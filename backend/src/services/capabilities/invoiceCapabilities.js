/**
 * AssistMe — invoiceCapabilities.js
 * Session V-B, Jun 2026
 *
 * Wires mutate_invoice capability to POST /api/invoices via internal authenticated fetch.
 * Uses owner JWT — no service role key.
 *
 * Capability layer returns deterministic execution/error results.
 * Clarification cards (entity_clarification) are handled by executionPlanBuilder, not here.
 * This mirrors the paymentCapabilities.js pattern exactly.
 *
 * TODO (Invoice Refactor Sprint, post-v1):
 *   Replace internal HTTP call with shared createInvoice() domain primitive.
 *   Both POST /api/invoices and this capability should call createInvoice() directly.
 */

import { resolveCustomerSelector } from './customerSelector.js';
import { resolveProductSelector } from './productSelector.js';

const BACKEND_BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

export async function mutateInvoiceCapability(params, orgId, supabase, orgContext, ownerToken) {
  const { operation, customer, items = [] } = params;

  if (operation !== 'create_invoice') {
    return _errorResult('Only "create_invoice" is supported via AI for now. Other invoice operations coming soon.');
  }

  if (!ownerToken) {
    return _errorResult('Authentication token missing. Please try again.');
  }

  // ── Resolve customer ─────────────────────────────────────
  const customerSelector = customer || {};
  const { customer: resolvedCustomer, candidates, error: custErr } = await resolveCustomerSelector({
    selector: customerSelector,
    orgId,
    supabase,
  });

  if (custErr) return _errorResult('Could not look up customer: ' + custErr);
  if ((candidates || []).length > 1) {
    const names = candidates.slice(0, 4).map(c => c.name).join(', ');
    return _errorResult('Multiple customers found matching that name: ' + names + '. Please be more specific.');
  }
  if (!resolvedCustomer) return _errorResult('Customer not found. Please check the name and try again.');

  // ── Resolve products ─────────────────────────────────────
  if (!items || items.length === 0) return _errorResult('No items specified for the invoice.');

  const resolvedItems = [];
  const missingProducts = [];
  const ambiguousProducts = [];

  for (const item of items) {
    const selector = item.product_id
      ? { product_id: item.product_id }
      : { name: item.name || item.product_name };

    const { products, error: prodErr } = await resolveProductSelector({ selector, orgId, supabase });

    if (prodErr || !products || products.length === 0) {
      missingProducts.push(item.name || item.product_id || 'unknown');
      continue;
    }

    // Multiple products matched — reject explicitly (financial mutation, no silent pick)
    if (products.length > 1) {
      const matchNames = products.slice(0, 3).map(p => p.name).join(', ');
      ambiguousProducts.push('"' + (item.name || item.product_id) + '" matched: ' + matchNames);
      continue;
    }

    resolvedItems.push({
      product_id: products[0].id,
      quantity: item.quantity || 1,
    });
  }

  if (ambiguousProducts.length > 0) {
    return _errorResult('Multiple products matched — please be more specific:\n' + ambiguousProducts.join('\n'));
  }

  if (resolvedItems.length === 0) {
    return _errorResult('No matching products found: ' + missingProducts.join(', ') + '. Please check product names.');
  }

  if (missingProducts.length > 0) {
    console.warn('[mutateInvoiceCapability] some products not found, proceeding with resolved:', missingProducts);
  }

  // ── Internal authenticated call to POST /api/invoices ────
  // Owner JWT preserves auditability — invoice created as owner, not system.
  let invoiceResponse;
  try {
    const res = await fetch(BACKEND_BASE_URL + '/api/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + ownerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer_id: resolvedCustomer.id,
        items: resolvedItems,
      }),
    });

    invoiceResponse = await res.json();

    if (!res.ok) {
      console.error('[mutateInvoiceCapability] route error:', invoiceResponse);
      return _errorResult('Invoice creation failed: ' + (invoiceResponse.error || 'unknown error'));
    }
  } catch (err) {
    console.error('[mutateInvoiceCapability] fetch error:', err.message);
    return _errorResult('Could not reach invoice service. Please try again.');
  }

  const { invoice_id, invoice_number, total_amount } = invoiceResponse;
  const s = orgContext?.currency === 'USD' ? '$' : '₹';
  const formattedTotal = Number(total_amount).toLocaleString('en-IN');
  const itemSummary = resolvedItems.length === 1 ? '1 item' : resolvedItems.length + ' items';

  console.log('[mutateInvoiceCapability]', {
    invoice_number,
    total_amount,
    customer: resolvedCustomer.name,
    items: resolvedItems.length,
  });

  return {
    response_text: 'Done. Invoice ' + invoice_number + ' created for ' + resolvedCustomer.name
      + ' — ' + s + formattedTotal + ' (' + itemSummary + ').',
    chart_data: null,
    next_action: {
      text: 'View invoice or record payment from ' + resolvedCustomer.name,
      type: 'mutate_payment',
      execution_mode: 'single',
      entities: [{ type: 'customer', id: resolvedCustomer.id, customer_name: resolvedCustomer.name }],
      prefill: null,
    },
    message_type: 'ai_response',
    _mutation_result: {
      affected_count: 1,
      operation: 'create_invoice',
      is_success: true,
      invoice_id,
      invoice_number,
      total_amount,
      customer_id: resolvedCustomer.id,
      customer_name: resolvedCustomer.name,
    },
  };
}

function _errorResult(message) {
  return {
    response_text: message,
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    _mutation_result: { affected_count: 0, operation: 'failed', is_success: false },
  };
}
