// Recurring Subscriptions, Razorpay integration (Subscription & Billing,
// Step 5B). See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription &
// Billing".
//
// Distinct from walletService.js (Orders API, one-time payments) -- this
// uses Razorpay's SUBSCRIPTIONS API (recurring, Plan-based).
//
// KEY DESIGN DECISION: does NOT trust Razorpay's cancel_at_cycle_end
// parameter alone to guarantee "downgrade only at period end" -- a
// credible bug report (razorpay-node GitHub issue #325) found during
// research shows this parameter has NOT reliably behaved as documented in
// the past. Instead, this module builds an INDEPENDENT safety net: on
// cancellation, we mark our own subscriptions.status as 'cancel_pending'
// and do NOT touch organisations.subscription_plan immediately. A
// separate daily cron job (jobDowngradeCancelledSubscriptions, wired into
// index.js the same way as every other Watch Engine job) checks for
// cancel_pending subscriptions whose current_period_end has genuinely
// passed and only THEN downgrades. This guarantee holds regardless of
// whether Razorpay's own cancel-timing behaves as documented.
//
// Plan IDs (created once via Razorpay Dashboard, cannot be edited/deleted
// after creation per Razorpay's own docs):
//   pro:      plan_TMlrUSFrLzANMV  (Rs 588.82/month, GST-inclusive charge;
//                                    Rs 499 base + 18% GST)
//   business: plan_TMlsaUBnn0hW2L  (Rs 2358.82/month, GST-inclusive charge;
//                                    Rs 1999 base + 18% GST)

import Razorpay from 'razorpay';
import { validateWebhookSignature, validatePaymentVerification } from 'razorpay/dist/utils/razorpay-utils.js';

const PLAN_IDS = {
  pro: 'plan_TMlrUSFrLzANMV',
  business: 'plan_TMlsaUBnn0hW2L',
};

// Large-but-finite billing-cycle count, since Razorpay's Subscriptions API
// requires SOME total_count rather than truly indefinite -- 120 monthly
// cycles = 10 years, a practical stand-in for "until cancelled."
const TOTAL_COUNT_INDEFINITE = 120;

function getRazorpayInstance() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

export async function createSubscription({ orgId, tier, supabase }) {
  const planId = PLAN_IDS[tier];
  if (!planId) {
    return { success: false, error: 'invalid_tier' };
  }

  const razorpay = getRazorpayInstance();

  let subscription;
  try {
    subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: TOTAL_COUNT_INDEFINITE,
      customer_notify: 1,
      notes: { product: 'assistme', feature: 'subscription', org_id: orgId, tier },
    });
  } catch (err) {
    console.error('[createSubscription] Razorpay subscription creation failed:', err.message);
    return { success: false, error: 'razorpay_subscription_failed' };
  }

  const { error: upsertErr } = await supabase
    .from('subscriptions')
    .upsert(
      {
        organisation_id: orgId,
        razorpay_subscription_id: subscription.id,
        status: 'created',
        plan_tier: tier,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organisation_id' }
    );

  if (upsertErr) {
    console.error('[createSubscription] DB upsert failed:', upsertErr.message);
    return { success: false, error: 'db_upsert_failed' };
  }

  return {
    success: true,
    subscriptionId: subscription.id,
    keyId: process.env.RAZORPAY_KEY_ID,
  };
}

export async function changeSubscriptionTier({ orgId, newTier, supabase }) {
  const newPlanId = PLAN_IDS[newTier];
  if (!newPlanId) {
    return { success: false, error: 'invalid_tier' };
  }

  const { data: sub, error: fetchErr } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('organisation_id', orgId)
    .maybeSingle();

  if (fetchErr || !sub || !sub.razorpay_subscription_id) {
    return { success: false, error: 'no_active_subscription' };
  }

  const razorpay = getRazorpayInstance();

  try {
    await razorpay.subscriptions.update(sub.razorpay_subscription_id, {
      plan_id: newPlanId,
      schedule_change_at: 'now',
    });

    await supabase
      .from('subscriptions')
      .update({ plan_tier: newTier, updated_at: new Date().toISOString() })
      .eq('id', sub.id);

    await supabase
      .from('organisations')
      .update({ subscription_plan: newTier })
      .eq('id', orgId);

    await recordSubscriptionEvent({
      orgId,
      razorpaySubscriptionId: sub.razorpay_subscription_id,
      eventType: 'tier_changed_instant',
      planTier: newTier,
      amountPaisa: null,
      payload: { from_tier: sub.plan_tier, to_tier: newTier, method: 'in_place_update' },
      supabase,
    });

    return { success: true, instant: true };
  } catch (updateErr) {
    console.warn('[changeSubscriptionTier] in-place update failed (likely UPI/eMandate), falling back to cancel+recreate:', updateErr.message);
  }

  try {
    await razorpay.subscriptions.cancel(sub.razorpay_subscription_id);
  } catch (cancelErr) {
    console.error('[changeSubscriptionTier] cancel-old failed:', cancelErr.message);
  }

  const newSubResult = await createSubscription({ orgId, tier: newTier, supabase });
  if (!newSubResult.success) {
    return { success: false, error: 'new_subscription_creation_failed' };
  }

  await recordSubscriptionEvent({
    orgId,
    razorpaySubscriptionId: sub.razorpay_subscription_id,
    eventType: 'tier_change_requires_reauth',
    planTier: newTier,
    amountPaisa: null,
    payload: { from_tier: sub.plan_tier, to_tier: newTier, method: 'cancel_and_recreate' },
    supabase,
  });

  return {
    success: true,
    instant: false,
    needsReauth: true,
    subscriptionId: newSubResult.subscriptionId,
    keyId: newSubResult.keyId,
  };
}

export async function requestCancellation({ orgId, supabase }) {
  const { data: sub, error: fetchErr } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('organisation_id', orgId)
    .maybeSingle();

  if (fetchErr || !sub || !sub.razorpay_subscription_id) {
    return { success: false, error: 'no_active_subscription' };
  }

  const razorpay = getRazorpayInstance();
  try {
    await razorpay.subscriptions.cancel(sub.razorpay_subscription_id, { cancel_at_cycle_end: 1 });
  } catch (err) {
    console.error('[requestCancellation] Razorpay cancel call failed:', err.message);
  }

  const { error: updateErr } = await supabase
    .from('subscriptions')
    .update({ status: 'cancel_pending', updated_at: new Date().toISOString() })
    .eq('id', sub.id);

  if (updateErr) {
    console.error('[requestCancellation] DB update failed:', updateErr.message);
    return { success: false, error: 'db_update_failed' };
  }

  return { success: true, activeUntil: sub.current_period_end };
}

async function recordSubscriptionEvent({ orgId, razorpaySubscriptionId, eventType, planTier, amountPaisa, payload, supabase }) {
  const { error } = await supabase.from('subscription_events').insert({
    organisation_id: orgId,
    razorpay_subscription_id: razorpaySubscriptionId,
    event_type: eventType,
    plan_name: planTier,
    amount_paisa: amountPaisa,
    razorpay_payload: payload,
  });
  if (error) {
    console.error('[recordSubscriptionEvent] insert failed:', error.message);
  }
}

export function verifyClientSubscriptionPayment({ subscriptionId, paymentId, signature }) {
  try {
    return validatePaymentVerification(
      { subscription_id: subscriptionId, payment_id: paymentId },
      signature,
      process.env.RAZORPAY_KEY_SECRET
    );
  } catch (err) {
    console.error('[verifyClientSubscriptionPayment] error:', err.message);
    return false;
  }
}

export async function activateSubscriptionClientSide({ orgId, tier, supabase }) {
  await supabase
    .from('subscriptions')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('organisation_id', orgId);

  await supabase
    .from('organisations')
    .update({ subscription_plan: tier })
    .eq('id', orgId);
}

export function verifySubscriptionWebhookSignature({ rawBody, signature }) {
  try {
    return validateWebhookSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[verifySubscriptionWebhookSignature] error:', err.message);
    return false;
  }
}

export async function handleSubscriptionEvent({ event, payload, supabase }) {
  const entity = payload?.subscription?.entity;
  if (!entity) return { success: true, note: 'no_subscription_entity' };

  const razorpaySubscriptionId = entity.id;
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('razorpay_subscription_id', razorpaySubscriptionId)
    .maybeSingle();

  if (!sub) {
    console.warn('[handleSubscriptionEvent] no matching subscription for:', razorpaySubscriptionId);
    return { success: true, note: 'no_matching_subscription' };
  }

  await recordSubscriptionEvent({
    orgId: sub.organisation_id,
    razorpaySubscriptionId,
    eventType: event,
    planTier: sub.plan_tier,
    amountPaisa: entity.plan_id ? null : null,
    payload,
    supabase,
  });

  if (event === 'subscription.activated' || event === 'subscription.charged') {
    const currentStart = entity.current_start ? new Date(entity.current_start * 1000).toISOString() : null;
    const currentEnd = entity.current_end ? new Date(entity.current_end * 1000).toISOString() : null;

    await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        current_period_start: currentStart,
        current_period_end: currentEnd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sub.id);

    await supabase
      .from('organisations')
      .update({ subscription_plan: sub.plan_tier })
      .eq('id', sub.organisation_id);
  } else if (event === 'subscription.pending') {
    await supabase
      .from('subscriptions')
      .update({ status: 'past_due', updated_at: new Date().toISOString() })
      .eq('id', sub.id);
  } else if (event === 'subscription.halted') {
    console.warn('[handleSubscriptionEvent] subscription.halted for org', sub.organisation_id, '-- no auto-action taken, needs a product decision.');
  } else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    await supabase
      .from('subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', sub.id);
  }

  return { success: true };
}

export async function jobDowngradeCancelledSubscriptions(orgId, supabase) {
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('organisation_id', orgId)
    .eq('status', 'cancel_pending')
    .maybeSingle();

  if (!sub) return 0;

  const periodEnded = sub.current_period_end && new Date(sub.current_period_end) < new Date();
  if (!periodEnded) return 0;

  await supabase
    .from('subscriptions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', sub.id);

  await supabase
    .from('organisations')
    .update({ subscription_plan: 'free' })
    .eq('id', orgId);

  await recordSubscriptionEvent({
    orgId,
    razorpaySubscriptionId: sub.razorpay_subscription_id,
    eventType: 'downgraded_at_period_end',
    planTier: sub.plan_tier,
    amountPaisa: null,
    payload: { triggered_by: 'daily_cron', period_end: sub.current_period_end },
    supabase,
  });

  return 1;
}
