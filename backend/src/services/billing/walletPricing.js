// Wallet Top-ups (Subscription & Billing, Step 5A). See
// ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription & Billing".
//
// This file holds ONLY pure, side-effect-free logic (tier lookup, GST/credit
// math) -- no Razorpay SDK, no database, no I/O. Kept separate from the
// Razorpay integration itself so this half can be independently unit-tested
// with zero server/network risk, same discipline as computeCostPaisa() in
// usageTracking.js.
//
// Amounts below are pre-tax (GST exclusive, per Atif's explicit decision).
// AI Credits computed at a 20% cost-ratio (₹20 of AI-cost ceiling per ₹100
// spent), then rounded to clean, trustworthy-looking numbers rather than
// the precise-but-odd computed figures (e.g. 80 credits, not 79) --
// marginally more generous to the customer, not a meaningful cost delta.

const GST_RATE = 0.18;

// The only 5 valid top-up amounts (pre-tax, INR). AI Credits pre-computed
// and locked -- see ASSISTME_V2_ARCHITECTURAL_BACKLOG.md for the full
// derivation (20% cost ceiling / GPT-4o-mini pricing / 1 credit = 10,000
// tokens blended 75% input : 25% output).
export const WALLET_TIERS = {
  100: { amountInr: 100, aiCredits: 80 },
  200: { amountInr: 200, aiCredits: 160 },
  500: { amountInr: 500, aiCredits: 400 },
  1000: { amountInr: 1000, aiCredits: 800 },
  2000: { amountInr: 2000, aiCredits: 1600 },
};

/**
 * Given a pre-tax amount, returns the full pricing breakdown or null if the
 * amount isn't one of the 5 valid tiers. Rejecting arbitrary amounts here
 * (rather than computing GST/credits for any number) prevents a client
 * from ever requesting an off-menu amount.
 */
export function getWalletTierPricing(amountInr) {
  const tier = WALLET_TIERS[amountInr];
  if (!tier) return null;

  const gstAmountInr = Math.round(tier.amountInr * GST_RATE * 100) / 100;
  const totalChargedInr = Math.round((tier.amountInr + gstAmountInr) * 100) / 100;

  return {
    amountInr: tier.amountInr,
    gstAmountInr,
    totalChargedInr,
    aiCredits: tier.aiCredits,
  };
}

/**
 * Returns the end of the current calendar month (IST) -- wallet credits
 * expire at the end of the month they were purchased in, non-transferable,
 * matching the same "use it this month or lose it" convention already used
 * for the paid_month usage-tracking periods.
 */
export function walletExpiryDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}
