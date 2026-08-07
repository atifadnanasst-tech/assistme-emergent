// AI Usage Tracking (Subscription & Billing, Step 2). See
// ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription & Billing".
//
// PURE TRACKING ONLY -- no enforcement/blocking logic lives here yet (that's
// Step 3, deployed feature-flagged off). This module's only job right now is
// to accurately record what AI usage actually costs, so the numbers can be
// verified against real traffic before anything is ever allowed to block a
// real user.
//
// Design principles:
//   - recordAiUsage() NEVER throws. Every internal error is caught and
//     logged; callers can invoke it fire-and-forget style. A bug in usage
//     tracking must never be able to break an actual AI response.
//   - Cost is tracked in PAISA (integer), not rupees-as-decimal, to avoid
//     floating-point drift on a value incremented on every single AI call.
//   - Window/period refresh is LAZY (checked at request time), not
//     scheduled -- no cron job needed. A period only "ends" the moment a
//     new request arrives after its period_end has passed.

// Pricing: GPT-4o-mini, confirmed current as of this session.
// $0.15 / 1M input tokens, $0.60 / 1M output tokens.
const PRICE_PER_TOKEN_USD = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};

// USD -> INR. Update if this drifts significantly from live rates -- this
// is a planning constant, not a live FX feed, and cost tracking is
// approximate by nature (exact billing reconciliation is a v2 concern).
const USD_TO_INR = 96;

/**
 * Pure function: given a model and token counts, return the cost in paisa.
 * No side effects, no I/O -- easiest piece to verify correctness of in
 * isolation before anything touches a live pipeline.
 */
export function computeCostPaisa({ model, inputTokens, outputTokens }) {
  const pricing = PRICE_PER_TOKEN_USD[model] || PRICE_PER_TOKEN_USD['gpt-4o-mini'];
  const costUsd = (inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output;
  const costInr = costUsd * USD_TO_INR;
  return Math.round(costInr * 100); // rupees -> paisa, integer
}

/**
 * Free-tier window boundary: exactly 5 hours from period_start.
 */
function freeWindowEnd(startDate) {
  return new Date(startDate.getTime() + 5 * 60 * 60 * 1000);
}

/**
 * Paid-tier boundary: end of the current calendar month, as an interim
 * default until Step 5 (Razorpay integration) populates real subscription
 * billing-cycle dates in the `subscriptions` table, at which point this
 * should be reconciled to use current_period_end instead.
 */
function calendarMonthEnd(startDate) {
  return new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
}

/**
 * Finds the org's current usage period for the given type, or creates a
 * fresh one if none exists or the existing one has expired. This is the
 * lazy-refresh mechanic: nothing resets on a schedule, it's purely
 * evaluated at the moment this function is called.
 */
export async function getOrCreateCurrentPeriod({ orgId, periodType, supabase }) {
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

  // No period exists, or the most recent one has expired -- start fresh.
  const periodStart = now;
  const periodEnd = periodType === 'free_window'
    ? freeWindowEnd(periodStart)
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

/**
 * Records one AI call's usage against the org's current period. Determines
 * period_type from the org's subscription_plan ('free' -> free_window,
 * anything else -> paid_month). NEVER throws -- all errors are caught and
 * logged as warnings, since a tracking failure must never break the actual
 * AI response the caller already has in hand. Fire-and-forget safe.
 *
 * Step 2 note: this ONLY records usage. No enforcement/blocking exists
 * here yet -- that's Step 3, and it will be feature-flagged off by default
 * even once built.
 */
export async function recordAiUsage({ orgId, model, inputTokens, outputTokens, supabase }) {
  try {
    if (!orgId || !supabase) return;

    const { data: org, error: orgErr } = await supabase
      .from('organisations')
      .select('subscription_plan')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) throw orgErr;

    const periodType = (!org || org.subscription_plan === 'free') ? 'free_window' : 'paid_month';
    const costPaisa = computeCostPaisa({ model, inputTokens, outputTokens });

    const period = await getOrCreateCurrentPeriod({ orgId, periodType, supabase });

    const { error: updateErr } = await supabase
      .from('ai_usage_periods')
      .update({
        cost_used_paisa: (period.cost_used_paisa || 0) + costPaisa,
        updated_at: new Date().toISOString(),
      })
      .eq('id', period.id);
    if (updateErr) throw updateErr;
  } catch (err) {
    console.warn('[recordAiUsage] non-blocking tracking error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Step 3: Enforcement (built here, NOT yet wired into any pipeline).
// See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription & Billing".
//
// ENFORCEMENT_ENABLED defaults to false. Flipping it to true is Step 4 --
// deliberately a tiny, one-line, trivially-revertible change, done only
// after this logic has been verified safe while disabled.
//
// Ceilings, back-calculated from Atif's real targets:
//   free_window: Rs 0.50 per 5-hour window -- worst-case ~90 windows/month
//     (3/day x 30 days) x Rs 0.50 = Rs 45/month absolute ceiling per free
//     org, matching the Rs 40-50/month target.
//   pro (Rs 499/month): Rs 129/month ceiling (~26% of revenue)
//   business (Rs 1999/month): Rs 799/month ceiling (~40% of revenue,
//     intentionally higher % than pro -- reinforces upgrade psychology)
// ─────────────────────────────────────────────────────────────────────────

export const ENFORCEMENT_ENABLED = false;

const CEILINGS_PAISA = {
  free_window: 50,     // Rs 0.50
  pro: 12900,           // Rs 129
  business: 79900,      // Rs 799
};

/**
 * Exported so the usage-summary endpoint (display only, no enforcement
 * implications) can show "X used of Y" even while ENFORCEMENT_ENABLED is
 * false. Same plan -> ceiling mapping logic checkUsageAllowed() itself
 * uses, extracted so it's not duplicated.
 */
export function getCeilingPaisaForPlan(plan) {
  if (plan === 'free' || !plan) return CEILINGS_PAISA.free_window;
  return CEILINGS_PAISA[plan] ?? CEILINGS_PAISA.pro;
}

/**
 * Checks whether an org is within its usage budget for the current period.
 * FAILS OPEN on any internal error -- a bug in enforcement must never be
 * able to block a legitimate (or paying) user. The worst case of a fail-
 * open bug is someone gets a query they technically shouldn't have; the
 * worst case of a fail-closed bug is blocking a paying customer, which is
 * far worse for the business.
 *
 * Returns { allowed, reason, costUsedPaisa, ceilingPaisa, periodType,
 * periodEnd }. Callers should treat `allowed` as the only field that
 * matters for gating; the rest is context for UI messaging.
 */
export async function checkUsageAllowed({ orgId, supabase }) {
  if (!ENFORCEMENT_ENABLED) {
    return { allowed: true, reason: 'enforcement_disabled' };
  }

  try {
    const { data: org, error: orgErr } = await supabase
      .from('organisations')
      .select('subscription_plan')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) throw orgErr;

    const plan = org?.subscription_plan || 'free';

    // Step 4 scope: enforcement applies to FREE TIER ONLY. Paid-tier
    // ceilings (Step 6) aren't wired to any user-facing wallet/upgrade UI
    // yet -- blocking a paying customer with no way to resolve it would be
    // a real regression, not a feature. Paid orgs always pass for now.
    if (plan !== 'free') {
      return { allowed: true, reason: 'paid_tier_not_yet_enforced' };
    }

    const periodType = 'free_window';
    const ceilingPaisa = CEILINGS_PAISA.free_window;

    const period = await getOrCreateCurrentPeriod({ orgId, periodType, supabase });
    const costUsedPaisa = period.cost_used_paisa || 0;
    const allowed = costUsedPaisa < ceilingPaisa;

    return {
      allowed,
      reason: allowed ? 'within_budget' : 'budget_exceeded',
      costUsedPaisa,
      ceilingPaisa,
      periodType,
      periodEnd: period.period_end,
      // Pre-formatted for the "Usage limit reached - Resets at <time> - Get
      // more usage" message (IST, matches the rest of the app's convention).
      periodEndFormatted: new Date(period.period_end).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
      }),
    };
  } catch (err) {
    console.warn('[checkUsageAllowed] error, failing OPEN (allowing request):', err.message);
    return { allowed: true, reason: 'check_error_fail_open' };
  }
}
