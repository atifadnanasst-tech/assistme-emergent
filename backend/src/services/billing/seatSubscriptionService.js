// Seat Subscriptions, Razorpay integration (Linked Devices feature,
// seat-purchase payment flow). See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md.
//
// Atif's own design insight, and the reason this file exists as a
// deliberate, near-total REUSE of subscriptionService.js rather than
// new invention: "a seat, in essence, means one more buy of the app,
// which is the same plan and the same subscription." Each purchased
// seat is its own, independent, recurring Razorpay subscription --
// same plan_id, same price, same billing cycle, same webhook signature
// verification as the org's own main-plan subscription. Zero new
// Razorpay API surface introduced; the only genuinely new piece is
// tracking (a seat_subscriptions table, separate from subscriptions
// because that table has a one-row-per-org rule baked in) and
// recomputing the seat count.
//
// NOT reusing subscriptionService.js's own createSubscription()
// directly: that function upserts with onConflict: 'organisation_id',
// which would overwrite the org's main-plan row instead of adding a
// second, independent one. The Razorpay call itself (subscriptions.create
// with the same plan_id) is identical in spirit -- only the DB write
// target differs.
//
// No trial logic here -- a seat purchase is an ADD-ON to an existing,
// already-paying org, not a new signup, so isEligibleForTrial() from
// subscriptionService.js is deliberately never consulted.

import Razorpay from 'razorpay';
import { validateWebhookSignature, validatePaymentVerification } from 'razorpay/dist/utils/razorpay-utils.js';
import { sendTelegramAlert } from './telegramNotify.js';

// Same plan IDs as subscriptionService.js -- a seat costs exactly what
// the org's own current plan costs, since it's literally "one more of
// the same thing." Duplicated here (not imported) to keep this file
// fully independent and reviewable on its own, matching how
// walletService.js and subscriptionService.js are already two
// separate, self-contained files rather than sharing internals.
const PLAN_IDS = {
  pro: 'plan_TMlrUSFrLzANMV',
  business: 'plan_TMlsaUBnn0hW2L',
};

const TOTAL_COUNT_INDEFINITE = 120;

function getRazorpayInstance() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/**
 * Recomputes subscriptions.seats_purchased as a LIVE count (1 base seat
 * + however many seat_subscriptions are currently active for this org)
 * rather than incrementing/decrementing a stored number -- avoids any
 * possibility of drift from a missed event, always self-corrects.
 * Called after every seat_subscriptions status change.
 */
async function recomputeSeatsPurchased({ orgId, supabase }) {
  const { count, error } = await supabase
    .from('seat_subscriptions')
    .select('*', { count: 'exact', head: true })
    .eq('organisation_id', orgId)
    .eq('status', 'active');

  if (error) {
    console.error('[recomputeSeatsPurchased] count failed:', error.message);
    return;
  }

  const { error: updateErr } = await supabase
    .from('subscriptions')
    .update({ seats_purchased: 1 + (count || 0) })
    .eq('organisation_id', orgId);

  if (updateErr) {
    console.error('[recomputeSeatsPurchased] update failed:', updateErr.message);
  }
}

/**
 * Creates a new, independent Razorpay subscription for one additional
 * seat, using the SAME plan_id as the org's own current main plan
 * (looked up automatically, never passed in by the client -- a seat
 * always matches the org's current plan, it isn't independently
 * chosen). Inserts a NEW row into seat_subscriptions (never an upsert
 * -- multiple rows per org is the whole point).
 */
export async function createSeatSubscription({ orgId, supabase }) {
  const { data: mainSub, error: fetchErr } = await supabase
    .from('subscriptions')
    .select('plan_tier')
    .eq('organisation_id', orgId)
    .maybeSingle();

  if (fetchErr || !mainSub || !mainSub.plan_tier || !PLAN_IDS[mainSub.plan_tier]) {
    return { success: false, error: 'no_active_main_plan' };
  }

  const tier = mainSub.plan_tier;
  const planId = PLAN_IDS[tier];
  const razorpay = getRazorpayInstance();

  let subscription;
  try {
    subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: TOTAL_COUNT_INDEFINITE,
      customer_notify: 1,
      notes: { product: 'assistme', feature: 'seat_purchase', org_id: orgId, tier },
    });
  } catch (err) {
    console.error('[createSeatSubscription] Razorpay subscription creation failed:', err.message);
    return { success: false, error: 'razorpay_subscription_failed' };
  }

  const { error: insertErr } = await supabase
    .from('seat_subscriptions')
    .insert({
      organisation_id: orgId,
      razorpay_subscription_id: subscription.id,
      status: 'created',
      plan_tier: tier,
    });

  if (insertErr) {
    console.error('[createSeatSubscription] DB insert failed:', insertErr.message);
    return { success: false, error: 'db_insert_failed' };
  }

  return {
    success: true,
    subscriptionId: subscription.id,
    keyId: process.env.RAZORPAY_KEY_ID,
    tier,
  };
}

export function verifyClientSeatPayment({ subscriptionId, paymentId, signature }) {
  try {
    return validatePaymentVerification(
      { subscription_id: subscriptionId, payment_id: paymentId },
      signature,
      process.env.RAZORPAY_KEY_SECRET
    );
  } catch (err) {
    console.error('[verifyClientSeatPayment] error:', err.message);
    return false;
  }
}

/**
 * Fast client-side path -- marks the seat active immediately so the
 * owner sees their new seat count without waiting for the webhook,
 * matching subscriptionService.js's own activateSubscriptionClientSide
 * pattern exactly. The webhook (below) remains the authoritative
 * backstop for cases where the app closes before this call completes.
 */
export async function activateSeatSubscriptionClientSide({ orgId, razorpaySubscriptionId, supabase }) {
  await supabase
    .from('seat_subscriptions')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('razorpay_subscription_id', razorpaySubscriptionId);

  await recomputeSeatsPurchased({ orgId, supabase });

  supabase
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle()
    .then(async ({ data: org }) => {
      const orgName = org?.name || orgId;
      const { count } = await supabase
        .from('seat_subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('organisation_id', orgId).eq('status', 'active');
      sendTelegramAlert(`💺 <b>Seat Purchased</b>\n${orgName}\nNow ${1 + (count || 0)} seats total`);
    })
    .catch(() => {});
}

export function verifySeatWebhookSignature({ rawBody, signature }) {
  try {
    return validateWebhookSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[verifySeatWebhookSignature] error:', err.message);
    return false;
  }
}

/**
 * Webhook handler, mirroring subscriptionService.js's own
 * handleSubscriptionEvent -- but writes to seat_subscriptions instead,
 * and recomputes the org's seats_purchased after every status change
 * (activation, halt, cancellation) so the seat count always reflects
 * reality even if the client-side verify call never completed.
 */
export async function handleSeatSubscriptionEvent({ event, payload, supabase }) {
  const entity = payload?.subscription?.entity;
  if (!entity) return { success: true, note: 'no_subscription_entity' };

  const razorpaySubscriptionId = entity.id;
  const { data: seat } = await supabase
    .from('seat_subscriptions')
    .select('*')
    .eq('razorpay_subscription_id', razorpaySubscriptionId)
    .maybeSingle();

  if (!seat) {
    // Not every subscription webhook is about a seat -- the org's own
    // main-plan subscription shares the same Razorpay account and
    // webhook endpoint pattern, so a non-match here is expected and
    // not an error; subscriptionService.js's own webhook handler
    // covers that case.
    return { success: true, note: 'no_matching_seat_subscription' };
  }

  if (event === 'subscription.activated' || event === 'subscription.charged') {
    const currentStart = entity.current_start ? new Date(entity.current_start * 1000).toISOString() : null;
    const currentEnd = entity.current_end ? new Date(entity.current_end * 1000).toISOString() : null;

    await supabase
      .from('seat_subscriptions')
      .update({
        status: 'active',
        current_period_start: currentStart,
        current_period_end: currentEnd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', seat.id);
  } else if (event === 'subscription.pending') {
    await supabase
      .from('seat_subscriptions')
      .update({ status: 'past_due', updated_at: new Date().toISOString() })
      .eq('id', seat.id);
  } else if (event === 'subscription.halted') {
    await supabase
      .from('seat_subscriptions')
      .update({ status: 'halted', updated_at: new Date().toISOString() })
      .eq('id', seat.id);
  } else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    await supabase
      .from('seat_subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', seat.id);
  }

  await recomputeSeatsPurchased({ orgId: seat.organisation_id, supabase });

  return { success: true };
}
