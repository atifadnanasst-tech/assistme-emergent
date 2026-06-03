/**
 * AssistMe — Mutation Capabilities
 *
 * Location: /backend/src/services/capabilities/mutationCapabilities.js
 * Created: Session I-A, Jun 2026
 *
 * PURPOSE: Write-side capability implementations.
 *          Session I: mutate_product only.
 *          Only called AFTER owner confirms via Session I-B endpoint.
 *
 * Uses resolveProductSelector() — same function as executionPlanBuilder.js
 * Guarantees execution operates on same product set as preview.
 */

import { updateProduct } from '../business/productMutations.js';
import { resolveProductSelector } from './productSelector.js';

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', AED: 'AED ', GBP: '£', EUR: '€' };
const sym = (currency) => CURRENCY_SYMBOLS[currency] || `${currency} `;

export async function mutateProductCapability(params, orgId, supabase, orgContext) {
  const { operation, selector = {}, change_type, value, fields } = params;

  const { products, error } = await resolveProductSelector({
    selector,
    orgId,
    supabase,
    includeInactive: operation === 'archive' || operation === 'restore',
  });

  if (error) return _errorResult('Could not fetch products. Please try again.');

  if (products.length === 0) {
    const selectorDesc = selector.category ? `"${selector.category}" category`
      : selector.name_contains ? `products named "${selector.name_contains}"`
      : 'the selected products';
    return {
      response_text: `No active products found in ${selectorDesc}.`,
      chart_data: null,
      next_action: { text: 'Check your product list to confirm the category name.', type: 'none', entities: [] },
      message_type: 'ai_response',
      _mutation_result: { affected_count: 0, operation },
    };
  }

  if (operation === 'bulk_price_change' || change_type) {
    return _executeBulkPriceChange({ products, change_type, value, orgId, orgContext, supabase });
  }

  if (operation === 'archive') return _executeArchive({ products, orgId, supabase });

  if (operation === 'update' && fields) return _executeSingleUpdate({ products, fields, orgId, supabase });

  console.warn('[mutate_product] unhandled operation:', operation);
  return _errorResult(`The "${operation}" operation is coming soon.`);
}

async function _executeBulkPriceChange({ products, change_type, value, orgId, orgContext, supabase }) {
  if (!change_type || value == null || isNaN(Number(value))) {
    return _errorResult('Price change requires a change type and a value.');
  }

  const numValue = Number(value);
  const currency = orgContext?.currency || 'INR';
  const s = sym(currency);
  const beforeAfter = [];
  let successCount = 0;
  let failCount = 0;

  for (const product of products) {
    const oldPrice = Number(product.selling_price || 0);
    let newPrice;
    if (change_type === 'increase_pct') newPrice = Math.round(oldPrice * (1 + numValue / 100) * 100) / 100;
    else if (change_type === 'decrease_pct') newPrice = Math.max(0, Math.round(oldPrice * (1 - numValue / 100) * 100) / 100);
    else if (change_type === 'set_price') newPrice = numValue;
    else continue;

    const result = await updateProduct(supabase, orgId, product.id, { sellingPrice: newPrice });

    if (result.status === 'success') {
      successCount++;
      beforeAfter.push({ name: product.name, old_price: oldPrice, new_price: newPrice, diff: newPrice - oldPrice });
    } else {
      failCount++;
      console.warn('[mutate_product] update failed:', product.name, result.error);
    }
  }

  if (successCount === 0) return _errorResult('Price update failed. Please try again.');

  const avgOld = beforeAfter.reduce((s, p) => s + p.old_price, 0) / beforeAfter.length;
  const avgNew = beforeAfter.reduce((s, p) => s + p.new_price, 0) / beforeAfter.length;
  const avgDiff = Math.round((avgNew - avgOld) * 100) / 100;
  const largest = [...beforeAfter].sort((a, b) => b.new_price - a.new_price)[0];
  const smallest = [...beforeAfter].sort((a, b) => a.new_price - b.new_price)[0];

  const changeDesc = change_type === 'increase_pct' ? `+${numValue}%`
    : change_type === 'decrease_pct' ? `-${numValue}%`
    : `set to ${s}${numValue}`;

  const lines = [
    `Done. Updated ${successCount} product${successCount !== 1 ? 's' : ''} (${changeDesc}).`,
    `Average price change: ${s}${Math.abs(avgDiff).toLocaleString('en-IN')}.`,
  ];
  if (largest && smallest && largest.name !== smallest.name) {
    lines.push(`Highest: ${largest.name} ${s}${largest.old_price.toLocaleString('en-IN')} → ${s}${largest.new_price.toLocaleString('en-IN')}.`);
  }
  if (failCount > 0) lines.push(`${failCount} product${failCount !== 1 ? 's' : ''} could not be updated.`);

  return {
    response_text: lines.join(' '),
    chart_data: {
      type: 'before_after_table',
      title: `Price Update — ${successCount} Products`,
      currency,
      rows: beforeAfter.slice(0, 5).map(p => ({ label: p.name, before: p.old_price, after: p.new_price, change: p.diff })),
      summary: successCount > 5 ? `+${successCount - 5} more products updated` : null,
    },
    next_action: {
      text: 'Regenerate your catalog to share updated prices with customers.',
      type: 'generate_document',
      execution_mode: 'single',
      entities: [],
      prefill: null,
    },
    message_type: 'ai_response',
    _mutation_result: { affected_count: successCount, operation: 'bulk_price_change', change_type, value: numValue },
  };
}

async function _executeArchive({ products, orgId, supabase }) {
  let successCount = 0;
  for (const product of products) {
    const { error } = await supabase.from('products')
      .update({ is_active: false })
      .eq('id', product.id)
      .eq('organisation_id', orgId);
    if (!error) successCount++;
  }
  return {
    response_text: `Archived ${successCount} product${successCount !== 1 ? 's' : ''}.`,
    chart_data: null,
    next_action: { text: 'View archived products in the Products tab to restore if needed.', type: 'none', entities: [] },
    message_type: 'ai_response',
    _mutation_result: { affected_count: successCount, operation: 'archive' },
  };
}

async function _executeSingleUpdate({ products, fields, orgId, supabase }) {
  if (products.length > 1) {
    return _errorResult(`Found ${products.length} matching products. Please be more specific.`);
  }
  const product = products[0];
  const result = await updateProduct(supabase, orgId, product.id, fields);
  if (result.status !== 'success') return _errorResult(`Could not update ${product.name}: ${result.message || result.error}`);
  return {
    response_text: `Updated ${product.name}.`,
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    _mutation_result: { affected_count: 1, operation: 'update' },
  };
}

function _errorResult(message) {
  return { response_text: message, chart_data: null, next_action: null, message_type: 'ai_response', _mutation_result: { affected_count: 0, operation: 'failed' } };
}
