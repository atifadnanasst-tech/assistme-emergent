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

const PRICE_PER_TOKEN_USD = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};

const USD_TO_INR = 96;

export function computeCostPaisa({ model, inputTokens, outputTokens }) {
  const pricing = PRICE_PER_TOKEN_USD[model] || PRICE_PER_TOKEN_USD['gpt-4o-mini'];
  const costUsd = (inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output;
  const costInr = costUsd * USD_TO_INR;
  return Math.round(costInr * 100);
}

function freeWindowEnd(startDate) {
  return new Date(startDate.getTime() + 5 * 60 * 60 * 1000);
}

function calendarMonthEnd(startDate) {
  return new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
}

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

export async function recordAiUsage({ orgId, model, inputTokens, outputTokens, supabase }) {
  try {
    if (!orgId || !supabase) return;

    const { data: org, error: orgErr } = await supabase
      .from('organisations')
      .select('subscription_plan')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) throw orgErr;

    const plan = org?.subscription_plan || 'free';
    const periodType = plan === 'free' ? 'free_window' : 'paid_month';
    const costPaisa = computeCostPaisa({ model, inputTokens, outputTokens });

    const period = await getOrCreateCurrentPeriod({ orgId, periodType, supabase });
    const costUsedBeforeThisCall = period.cost_used_paisa || 0;

    const { error: updateErr } = await supabase
      .from('ai_usage_periods')
      .update({
        cost_used_paisa: costUsedBeforeThisCall + costPaisa,
        updated_at: new Date().toISOString(),
      })
      .eq('id', period.id);
    if (updateErr) throw updateErr;

    const ceilingPaisa = getCeilingPaisaForPlan(plan);
    if (costUsedBeforeThisCall >= ceilingPaisa) {
      const { drawFromWallet } = await import('./walletService.js');
      await drawFromWallet({ orgId, paisaAmount: costPaisa, supabase });
    }
  } catch (err) {
    console.warn('[recordAiUsage] non-blocking tracking error:', err.message);
  }
}

export const ENFORCEMENT_ENABLED = true;

const CEILINGS_PAISA = {
  free_window: 50,
  pro: 12900,
  business: 79900,
};

export function getCeilingPaisaForPlan(plan) {
  if (plan === 'free' || !plan) return CEILINGS_PAISA.free_window;
  return CEILINGS_PAISA[plan] ?? CEILINGS_PAISA.pro;
}

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

    const periodType = plan === 'free' ? 'free_window' : 'paid_month';
    const ceilingPaisa = getCeilingPaisaForPlan(plan);

    const period = await getOrCreateCurrentPeriod({ orgId, periodType, supabase });
    const costUsedPaisa = period.cost_used_paisa || 0;
    const withinPlanCeiling = costUsedPaisa < ceilingPaisa;

    const periodEndFormatted = new Date(period.period_end).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
    });

    if (withinPlanCeiling) {
      return {
        allowed: true,
        reason: 'within_budget',
        costUsedPaisa,
        ceilingPaisa,
        periodType,
        periodEnd: period.period_end,
        periodEndFormatted,
      };
    }

    const { getWalletBudgetRemainingPaisa } = await import('./walletService.js');
    const walletRemainingPaisa = await getWalletBudgetRemainingPaisa({ orgId, supabase });
    const allowed = walletRemainingPaisa > 0;

    return {
      allowed,
      reason: allowed ? 'within_wallet_overage' : 'budget_exceeded',
      costUsedPaisa,
      ceilingPaisa,
      periodType,
      periodEnd: period.period_end,
      periodEndFormatted,
      walletRemainingPaisa,
    };
  } catch (err) {
    console.warn('[checkUsageAllowed] error, failing OPEN (allowing request):', err.message);
    return { allowed: true, reason: 'check_error_fail_open' };
  }
}
