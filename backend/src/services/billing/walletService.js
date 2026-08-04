// Wallet Top-ups, Razorpay integration (Subscription & Billing, Step 5A-2).
// See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription & Billing".
//
// Grounded directly in Razorpay's own docs (fetched live, not assumed):
//   - Orders API amount is in PAISE, not rupees (confirmed via SDK types).
//   - validatePaymentVerification() / validateWebhookSignature() are the
//     SDK's own battle-tested HMAC verification functions -- tested with
//     known-correct and deliberately-tampered signatures before use here.
//   - Webhook body must be verified against the RAW, unparsed request body
//     (Razorpay's own docs: "Do not parse or cast the webhook request
//     body" before verifying -- re-serializing JSON can change whitespace/
//     key order and silently break the signature match).
//   - callback_url is NOT what we use -- that's specifically for WebView-
//     embedded checkouts. We use react-native-razorpay's native handler
//     (returns payment details directly to app JS), which is Razorpay's
//     own recommended mobile pattern, paired with a webhook as the
//     authoritative server-side backstop -- exactly their own stated best
//     practice ("handler function for immediate client-side confirmation
//     and webhooks for server-side verification").
//   - Payment capture: confirmed via Atif's dashboard screenshot that
//     Automatic Capture is enabled, so no manual capture logic is needed.

import Razorpay from 'razorpay';
import { validatePaymentVerification, validateWebhookSignature } from 'razorpay/dist/utils/razorpay-utils.js';
import { getWalletTierPricing, walletExpiryDate } from './walletPricing.js';

function getRazorpayInstance() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/**
 * Creates a Razorpay Order for a wallet top-up and a matching `created`-
 * status row in wallet_topups (so we have a record even of abandoned
 * attempts, not just successful ones). Returns everything the frontend
 * needs to open react-native-razorpay checkout.
 *
 * Rejects any amount that isn't one of the 5 fixed tiers -- prevents a
 * client from ever requesting an off-menu amount.
 */
export async function createWalletOrder({ orgId, amountInr, supabase }) {
  const pricing = getWalletTierPricing(amountInr);
  if (!pricing) {
    return { success: false, error: 'invalid_amount' };
  }

  const razorpay = getRazorpayInstance();
  const amountPaise = Math.round(pricing.totalChargedInr * 100);

  let order;
  try {
    order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `wallet_${orgId.slice(0, 8)}_${Date.now()}`,
      notes: { product: 'assistme', feature: 'wallet_topup', org_id: orgId },
    });
  } catch (err) {
    console.error('[createWalletOrder] Razorpay order creation failed:', err.message);
    return { success: false, error: 'razorpay_order_failed' };
  }

  const { data: row, error: insertErr } = await supabase
    .from('wallet_topups')
    .insert({
      organisation_id: orgId,
      razorpay_order_id: order.id,
      amount_inr: pricing.amountInr,
      gst_amount_inr: pricing.gstAmountInr,
      total_charged_inr: pricing.totalChargedInr,
      ai_credits_total: pricing.aiCredits,
      ai_credits_used: 0,
      status: 'created',
      expires_at: walletExpiryDate().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[createWalletOrder] DB insert failed:', insertErr.message);
    return { success: false, error: 'db_insert_failed' };
  }

  return {
    success: true,
    orderId: order.id,
    keyId: process.env.RAZORPAY_KEY_ID,
    amountPaise,
    aiCredits: pricing.aiCredits,
    walletTopupRowId: row.id,
  };
}

/**
 * THE SINGLE SHARED CREDITING FUNCTION. Called from BOTH the client-side
 * verification endpoint AND the webhook -- both are legitimate ways to
 * learn a payment succeeded, and both may fire for the same payment. This
 * function is the idempotency guard: if the row is already 'paid', it's a
 * safe no-op, never double-credits. Callers should call this whenever they
 * have confirmed (via their own verification method) that a payment
 * succeeded -- this function does no verification itself, only crediting.
 */
export async function creditWalletTopup({ razorpayOrderId, razorpayPaymentId, supabase }) {
  const { data: existing, error: fetchErr } = await supabase
    .from('wallet_topups')
    .select('*')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();

  if (fetchErr) {
    console.error('[creditWalletTopup] fetch failed:', fetchErr.message);
    return { success: false, error: 'fetch_failed' };
  }
  if (!existing) {
    console.warn('[creditWalletTopup] no matching wallet_topups row for order:', razorpayOrderId);
    return { success: false, error: 'order_not_found' };
  }

  // Idempotency guard -- if already credited (by the other path), this is
  // a harmless no-op, not an error. This is what makes it safe for both
  // the client-side verify call and the webhook to potentially fire for
  // the same order.
  if (existing.status === 'paid') {
    return { success: true, alreadyCredited: true, aiCredits: existing.ai_credits_total };
  }

  const { error: updateErr } = await supabase
    .from('wallet_topups')
    .update({ status: 'paid', razorpay_payment_id: razorpayPaymentId })
    .eq('id', existing.id);

  if (updateErr) {
    console.error('[creditWalletTopup] update failed:', updateErr.message);
    return { success: false, error: 'update_failed' };
  }

  return { success: true, alreadyCredited: false, aiCredits: existing.ai_credits_total };
}

/**
 * Client-side verification -- called right after react-native-razorpay's
 * checkout success handler returns payment details to the app. Uses the
 * SDK's own validatePaymentVerification() (HMAC-SHA256, verified against
 * known-correct and tampered test signatures before this code was written).
 */
export function verifyClientPayment({ orderId, paymentId, signature }) {
  try {
    return validatePaymentVerification(
      { order_id: orderId, payment_id: paymentId },
      signature,
      process.env.RAZORPAY_KEY_SECRET
    );
  } catch (err) {
    console.error('[verifyClientPayment] error:', err.message);
    return false;
  }
}

/**
 * Webhook verification -- rawBody MUST be the exact, unparsed request body
 * string (Razorpay's own docs: do not parse/cast before verifying). Uses a
 * SEPARATE secret (RAZORPAY_WEBHOOK_SECRET) from the API key secret --
 * confirmed via Razorpay's docs this is intentional and required.
 */
export function verifyWebhookSignature({ rawBody, signature }) {
  try {
    return validateWebhookSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[verifyWebhookSignature] error:', err.message);
    return false;
  }
}
