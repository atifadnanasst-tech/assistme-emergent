/**
 * AssistMe — Opening Position Constants
 * Location: /backend/src/constants/openingPosition.js
 * Created: Jun 2026 — Opening Position capability (Patch Set D)
 *
 * Single canonical identifier for Opening Position Transactions.
 * Per audited architecture (AssistMe_Financial_Calculation_Rules.md →
 * "Opening Position Rules"):
 *
 *   Opening Position Transaction = any invoices/purchase_bills row where
 *     historical_source = OPENING_POSITION_SOURCE
 *     is_historical      = false   (always — live, never imported history)
 *
 *   Real Transaction = any invoices/payments/purchase_bills/supplier_payments
 *     row where historical_source IS NULL OR historical_source !=
 *     OPENING_POSITION_SOURCE
 *
 * Used by:
 *   - recordOpeningPosition.js   (writes this value)
 *   - guard queries               (exclude OB rows when checking for
 *                                  Real Transactions / lock state)
 *   - visibility filters           (exclude OB rows from default
 *                                  invoice/bill lists)
 *
 * Do not hardcode the string 'opening_balance' anywhere else.
 */

export const OPENING_POSITION_SOURCE = 'opening_balance';
