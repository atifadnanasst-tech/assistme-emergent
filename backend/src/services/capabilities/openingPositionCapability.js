/**
 * AssistMe — Opening Position Capability
 * Location: /backend/src/services/capabilities/openingPositionCapability.js
 * Created: Jun 2026 — Opening Position capability (Patch Set B/C)
 *
 * Thin capability wrapper around recordOpeningPosition() — resolves the
 * entity selector (same resolveCustomerSelector used by mutate_payment /
 * set_entity_field — single entity model, "suppliers" are customers rows
 * too, per Finding 4/6 in AssistMe_Domain_Engine_Contracts.md), validates
 * params, calls the primitive, and formats the result for the COO
 * response contract.
 *
 * Response shape and next_action conventions follow paymentCapabilities.js
 * (mutatePaymentCapability) exactly:
 *   next_action: { text, type, execution_mode: 'single', entities: [], prefill: null }
 *   _mutation_result: { affected_count, operation, is_success, ... }
 *
 * Full architecture: AssistMe_Financial_Calculation_Rules.md →
 * "Opening Position Rules"
 *
 * Direction mapping (planner → primitive):
 *   "Ramesh owes me 10000"  → direction: 'receivable'
 *   "I owe Noor 5000"       → direction: 'payable'
 *
 * entity_memory: NEVER written here. Opening Position is financial truth
 * recorded in invoices/purchase_bills (via the primitive).
 *
 * CLARIFICATION (audit Blocker 3, Jun 2026): if direction is missing or
 * ambiguous, this returns next_action: null + a clarifying response_text
 * — matching freeform.js's existing clarification_needed convention
 * (planner.js / freeform.js line ~71), not a generic dead-end error.
 */

import { recordOpeningPosition } from '../business/recordOpeningPosition.js';
import { resolveCustomerSelector } from './customerSelector.js';

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', AED: 'AED ', GBP: '£', EUR: '€' };
const sym = (currency) => CURRENCY_SYMBOLS[currency] || `${currency} `;

export async function recordOpeningPositionCapability(params, orgId, supabase, orgContext) {
  const { amount, direction } = params;
  const s = sym(orgContext?.currency || 'INR');

  // ── Step 1: Validate direction ───────────────────────────
  if (direction !== 'receivable' && direction !== 'payable') {
    return _errorResult(
      'I need to know the direction: does this customer owe the business, ' +
      'or does the business owe them?'
    );
  }

  // ── Step 2: Validate amount ───────────────────────────────
  const numAmount = Number(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    return _errorResult('Opening balance amount is missing or invalid. Please specify a positive amount.');
  }

  // ── Step 3: Resolve entity (same selector as mutate_payment /
  //    set_entity_field — single customers-table entity model) ──
  const customerSelectorRaw = params.customer || params.entity || {};
  const customerSelector = Object.keys(customerSelectorRaw).length > 0
    ? customerSelectorRaw
    : { name: params.customer_name || params.entity_name };

  const { customer, candidates, error: selectorErr } = await resolveCustomerSelector({
    selector: customerSelector,
    orgId,
    supabase,
  });

  if (selectorErr) {
    return _errorResult('Could not look up that customer: ' + selectorErr);
  }
  if (!customer && (candidates || []).length > 1) {
    const names = candidates.slice(0, 4).map(c => c.name).join(', ');
    return _errorResult('Multiple customers found: ' + names + '. Please be more specific.');
  }
  if (!customer) {
    return _errorResult('Customer not found. Please check the name and try again.');
  }

  // ── Step 4: Call primitive ────────────────────────────────
  const result = await recordOpeningPosition(supabase, orgId, customer.id, numAmount, direction);

  if (result.status === 'failed') {
    return _errorResult(result.message || 'Could not record opening balance. Please try again.');
  }

  // ── Step 5: Format response (paymentCapabilities.js conventions) ──
  const wasVoided = result.events.some(e =>
    e.type === 'opening_position_voided' || e.type === 'opening_position_void_failed'
  );
  const amountStr = s + numAmount.toLocaleString('en-IN');

  let responseText;
  if (direction === 'receivable') {
    responseText = wasVoided
      ? `Done. Opening balance for ${customer.name} updated to ${amountStr}.`
      : `Done. Recorded opening balance: ${customer.name} owes ${amountStr}.`;
  } else {
    responseText = wasVoided
      ? `Done. Opening balance for ${customer.name} updated to ${amountStr}.`
      : `Done. Recorded opening balance: you owe ${customer.name} ${amountStr}.`;
  }

  if (result.status === 'partial_success') {
    responseText += ' Note: there was an issue updating the running balance — please verify on the account page.';
  }

  return {
    response_text: responseText,
    chart_data: null,
    next_action: {
      text: `View ${customer.name}'s account`,
      type: 'query_customers',
      execution_mode: 'single',
      entities: [],
      prefill: null,
    },
    message_type: 'ai_response',
    _mutation_result: {
      affected_count: 1,
      operation: 'record_opening_position',
      is_success: true,
      customer_id: customer.id,
      customer_name: customer.name,
      direction,
      amount: numAmount,
      operation_id: result.operation_id,
    },
  };
}

function _errorResult(message) {
  return {
    response_text: message,
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    _mutation_result: { affected_count: 0, operation: 'record_opening_position' },
  };
}
