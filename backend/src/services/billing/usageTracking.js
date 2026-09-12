// AI Usage Tracking & Enforcement (Subscription & Billing, Step 5 --
// unified two-meter system). Replaces the earlier single-meter,
// per-file-manual-wiring design. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
// -> "Subscription & Billing".
//
// SINGLE ENTRY POINT: runTrackedCompletion() is the ONLY way any part of
// this app should call OpenAI's chat completions endpoint. It checks
// both meters, makes the actual call, and records real cost -- all in
// one place, so a future AI feature can't repeat the exact gap found
// Sept 2026 (product import's extraction calls were entirely untracked
// because someone had to remember to add two separate function calls
// around every OpenAI call, and several call sites simply never did).
//
// TWO INDEPENDENT METERS, same model Anthropic uses for Claude Pro
// (confirmed via web search before this was designed): a short 5-hour
// rolling window for burst control, and a longer period for total
// volume. A request needs room in BOTH to proceed. Free tier has ONLY
// the window meter (its existing, unchanged design); Pro and Business
// get both. The window period_type stays 'free_window' in the database
// for ALL plans now -- it describes the period's SHAPE (5-hour
// rolling), not which tier it's for; organisation_id already scopes it
// correctly, and this avoids any schema/constraint change to the
// existing ai_usage_periods table.
//
// Design principles carried over from the original single-meter version:
//   - Recording NEVER throws. Every internal error is caught and logged;
//     a bug in usage tracking must never be able to break an actual AI
//     response.
//   - Checking FAILS OPEN. If the check itself errors (DB hiccup, etc),
//     the request is allowed through -- a tracking bug must never be
//     able to silently block a real, paying user.
//   - Cost is tracked in PAISA (integer), not rupees-as-decimal, to
//     avoid floating-point drift on a value incremented on every call.
//   - Window/period refresh is LAZY (checked at request time), not
//     scheduled -- no cron job needed. A period only "ends" the moment
//     a new request arrives after its period_end has passed. Idle time
//     between periods is never credited back -- confirmed with Atif as
//     intentional, matching Claude Pro's own rolling-window behavior.

const PRICE_PER_TOKEN_USD = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  // gpt-4o pricing added Sept 2026 -- its absence was a real, separate
  // bug found during this same investigation: extraction calls on
  // Business-tier accounts use gpt-4o, but cost was being silently
  // computed at gpt-4o-mini's much cheaper rate via the fallback below,
  // under-charging exactly the calls most likely to matter.
  'gpt-4o': { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
};

const USD_TO_INR = 96;
const CEILING_CACHE_TTL_MS = 60_000; // avoids a DB round-trip on every single AI call
const DB_TIMEOUT_MS = 5_000;

// Sept 2026 -- the OpenAI call itself has always had a bounded timeout
// (an AbortController at the call site, 10-25s depending on the flow),
// but the usage-check database calls sitting IN FRONT of it never did.
// A slow or hung Supabase response could stall a request indefinitely
// with no timeout catching it at all -- a real, previously-unguarded
// gap, found while investigating an intermittent hang report (the
// actual root cause turned out to be unrelated -- a request that never
// reached the server at all -- but this gap was real regardless and
// worth closing on its own merits). withTimeout() races any promise
// against a bound; a timeout becomes a normal thrown error, which the
// existing fail-open handling in checkUsageAllowed() and the
// swallow-and-log handling in recordAiUsage() already treat exactly
// like any other DB error -- no new error-handling philosophy needed,
// just a hang that can no longer be unbounded.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export function computeCostPaisa({ model, inputTokens, outputTokens }) {
  const pricing = PRICE_PER_TOKEN_USD[model] || PRICE_PER_TOKEN_USD['gpt-4o-mini'];
  const costUsd = (inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output;
  const costInr = costUsd * USD_TO_INR;
  return Math.round(costInr * 100);
}

function windowEnd(startDate, hours) {
  return new Date(startDate.getTime() + hours * 60 * 60 * 1000);
}

function calendarMonthEnd(startDate) {
  return new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
}

// In-memory cache, module-level -- deliberately NOT per-request, since
// this needs to survive across requests to actually save DB round-trips.
// Reset via clearCeilingCacheForTests() in tests, never in production code.
let _ceilingCache = null;
let _ceilingCacheAt = 0;

export function clearCeilingCacheForTests() {
  _ceilingCache = null;
  _ceilingCacheAt = 0;
}

const EMERGENCY_FALLBACK_CEILINGS = {
  free: { plan: 'free', window_ceiling_paisa: 17, month_ceiling_paisa: null, window_hours: 5 },
  pro: { plan: 'pro', window_ceiling_paisa: 71, month_ceiling_paisa: 8000, window_hours: 5 },
  business: { plan: 'business', window_ceiling_paisa: 357, month_ceiling_paisa: 40000, window_hours: 5 },
};

export async function getCeilings(supabase) {
  const now = Date.now();
  if (_ceilingCache && (now - _ceilingCacheAt) < CEILING_CACHE_TTL_MS) return _ceilingCache;

  try {
    const { data, error } = await supabase.from('ai_usage_ceilings').select('*');
    if (error || !data || data.length === 0) throw error || new Error('empty ceiling table');

    const byPlan = {};
    for (const row of data) byPlan[row.plan] = row;
    _ceilingCache = byPlan;
    _ceilingCacheAt = now;
    return byPlan;
  } catch (err) {
    console.warn('[getCeilings] DB read failed, using last-known cache or emergency fallback:', err.message);
    // A DB hiccup here must never silently disable enforcement (fail
    // open on EVERY request forever until someone notices) nor silently
    // block every user (if the fallback were empty/zero). Stale cache
    // if we have one; hardcoded emergency values matching the real
    // seeded ceilings if we don't.
    return _ceilingCache || EMERGENCY_FALLBACK_CEILINGS;
  }
}

async function getOrCreatePeriod({ orgId, periodType, windowHours, supabase }) {
  const { data: existing, error: fetchErr } = await supabase
    .from('ai_usage_periods')
    .select('*')
    .eq('organisation_id', orgId)
    .eq('period_type', periodType)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  const now = new Date();
  if (existing && new Date(existing.period_end) > now) {
    return existing;
  }

  const periodStart = now;
  const periodEnd = periodType === 'free_window'
    ? windowEnd(periodStart, windowHours || 5)
    : calendarMonthEnd(periodStart);

  const { data: created, error: insertErr } = await supabase
    .from('ai_usage_periods')
    .insert({
      organisation_id: orgId,
      period_type: periodType,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      cost_used_paisa: 0,
    })
    .select()
    .single();

  if (insertErr) throw insertErr;
  return created;
}

// Returns the org's plan and both relevant periods (window always;
// month only for non-free plans). Shared by the check and record
// halves below so they always agree on which periods are "current."
async function getPlanAndPeriods({ orgId, supabase }) {
  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .select('subscription_plan')
    .eq('id', orgId)
    .maybeSingle();
  if (orgErr) throw orgErr;

  const plan = org?.subscription_plan || 'free';
  const ceilings = await getCeilings(supabase);
  const planCeilings = ceilings[plan] || ceilings.free;

  const windowPeriod = await getOrCreatePeriod({
    orgId, periodType: 'free_window', windowHours: planCeilings.window_hours, supabase,
  });

  let monthPeriod = null;
  if (plan !== 'free') {
    monthPeriod = await getOrCreatePeriod({ orgId, periodType: 'paid_month', supabase });
  }

  return { plan, planCeilings, windowPeriod, monthPeriod };
}

// checkUsageAllowed() -- both meters, fails open on any internal error.
// Kept as its own exported function (not folded invisibly into the
// wrapper below) so a call site that genuinely needs to check without
// yet knowing token counts (e.g. before deciding which of several
// possible operations to run) still can.
export async function checkUsageAllowed({ orgId, supabase }) {
  try {
    const { plan, planCeilings, windowPeriod, monthPeriod } = await withTimeout(
      getPlanAndPeriods({ orgId, supabase }), DB_TIMEOUT_MS, 'checkUsageAllowed DB lookup'
    );

    const windowUsedPaisa = windowPeriod.cost_used_paisa || 0;
    const windowCeilingPaisa = planCeilings.window_ceiling_paisa;
    const withinWindow = windowUsedPaisa < windowCeilingPaisa;

    if (!withinWindow) {
      const periodEndFormatted = new Date(windowPeriod.period_end).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
      });
      return {
        allowed: false, reason: 'window_budget_exceeded', blockedBy: 'window',
        plan, windowUsedPaisa, windowCeilingPaisa, periodEnd: windowPeriod.period_end, periodEndFormatted,
      };
    }

    if (monthPeriod) {
      const monthUsedPaisa = monthPeriod.cost_used_paisa || 0;
      const monthCeilingPaisa = planCeilings.month_ceiling_paisa;
      const withinMonth = monthUsedPaisa < monthCeilingPaisa;

      if (!withinMonth) {
        const { getWalletBudgetRemainingPaisa } = await import('./walletService.js');
        const walletRemainingPaisa = await getWalletBudgetRemainingPaisa({ orgId, supabase });
        const allowed = walletRemainingPaisa > 0;
        const periodEndFormatted = new Date(monthPeriod.period_end).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
        });
        return {
          allowed, reason: allowed ? 'within_wallet_overage' : 'month_budget_exceeded', blockedBy: allowed ? null : 'month',
          plan, monthUsedPaisa, monthCeilingPaisa, periodEnd: monthPeriod.period_end, periodEndFormatted, walletRemainingPaisa,
        };
      }
    }

    return { allowed: true, reason: 'within_budget', plan };
  } catch (err) {
    console.warn('[checkUsageAllowed] error, failing OPEN (allowing request):', err.message);
    return { allowed: true, reason: 'check_error_fail_open' };
  }
}

// recordAiUsage() -- writes real cost to both meters. Never throws.
export async function recordAiUsage({ orgId, model, inputTokens, outputTokens, supabase }) {
  try {
    if (!orgId || !supabase) return;

    const { plan, planCeilings, windowPeriod, monthPeriod } = await withTimeout(
      getPlanAndPeriods({ orgId, supabase }), DB_TIMEOUT_MS, 'recordAiUsage DB lookup'
    );
    const costPaisa = computeCostPaisa({ model, inputTokens, outputTokens });

    const windowUsedBefore = windowPeriod.cost_used_paisa || 0;
    const { error: windowErr } = await supabase
      .from('ai_usage_periods')
      .update({ cost_used_paisa: windowUsedBefore + costPaisa, updated_at: new Date().toISOString() })
      .eq('id', windowPeriod.id);
    if (windowErr) throw windowErr;

    if (monthPeriod) {
      const monthUsedBefore = monthPeriod.cost_used_paisa || 0;
      const { error: monthErr } = await supabase
        .from('ai_usage_periods')
        .update({ cost_used_paisa: monthUsedBefore + costPaisa, updated_at: new Date().toISOString() })
        .eq('id', monthPeriod.id);
      if (monthErr) throw monthErr;

      if (monthUsedBefore >= planCeilings.month_ceiling_paisa) {
        const { drawFromWallet } = await import('./walletService.js');
        await drawFromWallet({ orgId, paisaAmount: costPaisa, supabase });
      }
    }
  } catch (err) {
    console.warn('[recordAiUsage] non-blocking tracking error:', err.message);
  }
}

// runTrackedCompletion() -- THE single entry point every AI call site
// should use. Checks, calls OpenAI, records -- one function, one place
// for the whole lifecycle, so tracking can never again be "forgotten"
// at a new call site: using this function correctly IS being tracked.
//
// Checked and recorded once per actual OpenAI call, not once per
// higher-level business operation -- a flow that makes two sequential
// completions (e.g. a tool-call round-trip) calls this twice, and the
// second call is checked fresh against whatever budget the first call
// left behind. This is a genuine improvement over the previous
// single-meter code, which only checked once before a multi-call flow
// and never re-checked before the second call.
//
// On block: returns { blocked: true, checkResult } and never calls
// OpenAI at all -- zero cost incurred for a blocked request.
// On success: returns { blocked: false, completion: <raw OpenAI response> }.
export async function runTrackedCompletion({ orgId, client, requestParams, requestOptions, supabase }) {
  const checkResult = await checkUsageAllowed({ orgId, supabase });
  if (!checkResult.allowed) {
    return { blocked: true, checkResult };
  }

  const completion = await client.chat.completions.create(requestParams, requestOptions);

  recordAiUsage({
    orgId, model: requestParams.model,
    inputTokens: completion.usage?.prompt_tokens || 0,
    outputTokens: completion.usage?.completion_tokens || 0,
    supabase,
  }).catch(() => {});

  return { blocked: false, completion };
}

// getUsageSummary() -- everything the /api/subscription/usage route
// needs to render both progress bars, calculated once here rather than
// duplicated in the route itself. Replaces the old direct
// getOrCreateCurrentPeriod() call that route used to make.
export async function getUsageSummary({ orgId, supabase }) {
  const { plan, planCeilings, windowPeriod, monthPeriod } = await withTimeout(
    getPlanAndPeriods({ orgId, supabase }), DB_TIMEOUT_MS, 'getUsageSummary DB lookup'
  );

  const windowUsedPaisa = windowPeriod.cost_used_paisa || 0;
  const windowCeilingPaisa = planCeilings.window_ceiling_paisa;
  const windowPercentUsed = percentUsedWithFloor(windowUsedPaisa, windowCeilingPaisa);

  const summary = {
    plan,
    window: {
      usedPaisa: windowUsedPaisa,
      ceilingPaisa: windowCeilingPaisa,
      percentUsed: windowPercentUsed,
      periodEnd: windowPeriod.period_end,
    },
    month: null,
  };

  if (monthPeriod) {
    const monthUsedPaisa = monthPeriod.cost_used_paisa || 0;
    const monthCeilingPaisa = planCeilings.month_ceiling_paisa;
    summary.month = {
      usedPaisa: monthUsedPaisa,
      ceilingPaisa: monthCeilingPaisa,
      percentUsed: percentUsedWithFloor(monthUsedPaisa, monthCeilingPaisa),
      periodEnd: monthPeriod.period_end,
    };
  }

  return summary;
}

export function getCeilingPaisaForPlan(plan, ceilings) {
  const source = ceilings || EMERGENCY_FALLBACK_CEILINGS;
  const row = source[plan] || source.free;
  return row.month_ceiling_paisa ?? row.window_ceiling_paisa;
}

// percentUsed with a floor: real usage that rounds to 0% under plain
// division still shows as 1%, per Atif's explicit requirement -- a
// trader who has genuinely used the app even once should never see
// "0% used," since that reads as "nothing happened" when something
// really did. Floor only applies when usedPaisa > 0; a genuinely
// untouched period still correctly shows 0%.
export function percentUsedWithFloor(usedPaisa, ceilingPaisa) {
  if (!ceilingPaisa || ceilingPaisa <= 0) return 0;
  if (!usedPaisa || usedPaisa <= 0) return 0;
  const raw = Math.round((usedPaisa / ceilingPaisa) * 100);
  return Math.max(raw, 1);
}

export const ENFORCEMENT_ENABLED = true;
