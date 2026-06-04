/**
 * AssistMe — Payment Capabilities
 *
 * Location: /backend/src/services/capabilities/paymentCapabilities.js
 * Created: Session II, Jun 2026
 *
 * PURPOSE: Mutation capability for recording customer payments.
 *          Wraps recordPayment() primitive — no payment logic inline.
 *          Called ONLY after owner confirmation via execute-plan endpoint.
 *
 * PRIMITIVE CONTRACT (verified Jun 2026):
 *   recordPayment(supabase, orgId, customerId, amount, paymentDate, paymentMethod, invoiceId)
 *   Returns:
 *     success:        { status:'success', events, total_applied, new_balance }
 *     partial:        { status:'partial_success', events, ... }
 *     failure:        { status:'failed', error: string }
 *   Events type: 'payment_recorded' (one per invoice allocated)
 *   Error codes: no_unpaid_invoices, invoice_not_found, invoice_already_paid,
 *                amount_exceeds_due, invalid_amount, server_error
 *
 * OUTSTANDING BALANCE:
 *   Always use result.new_balance from primitive — never derive from stale customer snapshot.
 *   recordPayment() re-queries customer balance after mutation and updates it.
 */

import { recordPayment } from '../business/recordPayment.js';
import { resolveCustomerSelector } from './customerSelector.js';

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', AED: 'AED ', GBP: '£', EUR: '€' };
const sym = (currency) => CURRENCY_SYMBOLS[currency] || `${currency} `;

export async function mutatePaymentCapability(params, orgId, supabase, orgContext) {
  // Accept both nested { customer: { name } } and flat { customer_name } from planner
  const customerSelectorRaw = params.customer || {};
  const customerSelector = Object.keys(customerSelectorRaw).length > 0
    ? customerSelectorRaw
    : { name: params.customer_name };
  const { amount, date, method, invoice_id } = params;
  const currency = orgContext?.currency || 'INR';
  const s = sym(currency);

  // ── Step 1: Validate amount ──────────────────────────────────
  const numAmount = Number(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    return _errorResult('Payment amount is missing or invalid. Please specify the amount.');
  }

  // ── Step 2: Resolve customer ─────────────────────────────────
  const { customer, candidates, error: selectorErr } = await resolveCustomerSelector({
    selector: customerSelector,
    orgId,
    supabase,
  });

  if (selectorErr) {
    return _errorResult(`Could not look up customer: ${selectorErr}`);
  }

  // Multiple candidates — ask owner to clarify
  if (!customer && (candidates || []).length > 1) {
    const names = candidates.slice(0, 4).map(c => c.name).join(', ');
    return {
      response_text: `I found ${candidates.length} customers matching that name: ${names}. Please be more specific so I can record the payment correctly.`,
      chart_data: null,
      next_action: null,
      message_type: 'ai_response',
      _mutation_result: { affected_count: 0, operation: 'record_payment' },
    };
  }

  // No customer found
  if (!customer) {
    const searchedName = customerSelector.name || customerSelector.customer_name || 'that name';
    return {
      response_text: `I couldn't find a customer matching "${searchedName}". Please check the name and try again.`,
      chart_data: null,
      next_action: null,
      message_type: 'ai_response',
      _mutation_result: { affected_count: 0, operation: 'record_payment' },
    };
  }

  // ── Step 3: Record payment via primitive ─────────────────────
  const paymentDate = date || new Date().toISOString().split('T')[0];
  const result = await recordPayment(
    supabase,
    orgId,
    customer.id,
    numAmount,
    paymentDate,
    method || null,
    invoice_id || null
  );

  // ── Step 4: Handle all return statuses ───────────────────────
  if (result.status === 'failed') {
    const errMessages = {
      no_unpaid_invoices:  `${customer.name} has no unpaid invoices to apply this payment to.`,
      invoice_not_found:   'The specified invoice was not found.',
      invoice_already_paid:'That invoice is already fully paid.',
      amount_exceeds_due:  `Payment amount ${s}${numAmount.toLocaleString('en-IN')} exceeds the amount due (max: ${s}${(result.max_payable || 0).toLocaleString('en-IN')}).`,
      invalid_amount:      'Invalid payment amount.',
      server_error:        'Payment could not be recorded due to a server error. Please try again.',
    };
    return _errorResult(errMessages[result.error] || `Payment failed: ${result.error}`);
  }

  // ── Step 5: Build COO-quality response ───────────────────────
  // Use result.new_balance — already re-queried and updated by recordPayment()
  const totalApplied = result.total_applied ?? numAmount;
  const newBalance = result.new_balance ?? 0;
  const invoicesAllocated = (result.events || []).filter(e => e.type === 'payment_recorded');
  const isPartial = result.status === 'partial_success';

  const lines = [
    `${isPartial ? 'Partially recorded.' : 'Done.'} ${s}${totalApplied.toLocaleString('en-IN')} payment from ${customer.name} recorded.`,
  ];

  if (invoicesAllocated.length > 0) {
    const fullyPaid = invoicesAllocated.filter(e => e.invoice_status === 'paid');
    const partPaid  = invoicesAllocated.filter(e => e.invoice_status !== 'paid');
    if (fullyPaid.length > 0) lines.push(`${fullyPaid.length} invoice${fullyPaid.length > 1 ? 's' : ''} fully paid.`);
    if (partPaid.length > 0)  lines.push(`${partPaid.length} invoice${partPaid.length > 1 ? 's' : ''} partially paid.`);
  }

  if (newBalance > 0) {
    lines.push(`Remaining outstanding: ${s}${newBalance.toLocaleString('en-IN')}.`);
  } else {
    lines.push(`${customer.name}'s account is now fully cleared.`);
  }

  return {
    response_text: lines.join(' '),
    chart_data: null,
    next_action: {
      text: 'View collection insights or check remaining overdue accounts.',
      type: 'query_collection_insights',
      execution_mode: 'single',
      entities: [],
      prefill: null,
    },
    message_type: 'ai_response',
    _mutation_result: {
      affected_count: invoicesAllocated.length,
      operation: 'record_payment',
      customer_id: customer.id,
      customer_name: customer.name,
      amount: totalApplied,
      new_balance: newBalance,
    },
  };
}

function _errorResult(message) {
  return {
    response_text: message,
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    _mutation_result: { affected_count: 0, operation: 'record_payment' },
  };
}
