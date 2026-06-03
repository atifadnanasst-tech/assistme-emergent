/**
 * AssistMe — Execution Plan Builder
 *
 * Location: /backend/src/services/ai/executionPlanBuilder.js
 * Created: Session I-A, Jun 2026
 *
 * PURPOSE: READ-ONLY preview generator. Never writes to DB.
 *          Uses resolveProductSelector() — same function as mutationCapabilities.js
 *          Guarantees preview and execution operate on identical product sets.
 */

import { resolveProductSelector } from '../capabilities/productSelector.js';

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', AED: 'AED ', GBP: '£', EUR: '€' };
const sym = (currency) => CURRENCY_SYMBOLS[currency] || `${currency} `;

export async function buildExecutionPlanCard({ validPlan, orgId, supabase, orgContext }) {
  if (!validPlan || validPlan.length === 0) return null;

  const step = validPlan[0];
  const { capability, params, label } = step;

  if (capability === 'mutate_product') {
    return _buildProductMutationPlan({ params, orgId, supabase, orgContext, label, capability });
  }

  return _buildGenericPlan({ capability, params, label, orgContext });
}

async function _buildProductMutationPlan({ params, orgId, supabase, orgContext, label, capability }) {
  const { selector = {}, operation, change_type, value } = params;
  const currency = orgContext?.currency || 'INR';
  const s = sym(currency);

  const { products, error } = await resolveProductSelector({
    selector,
    orgId,
    supabase,
    includeInactive: operation === 'archive' || operation === 'restore',
  });

  if (error) {
    return _errorCard({ capability, label, params, summary_text: 'Could not load products. Please try again.' });
  }

  if (products.length === 0) {
    const selectorDesc = selector.category ? `"${selector.category}" category`
      : selector.name_contains ? `products named "${selector.name_contains}"`
      : selector.product_id ? `product "${selector.product_id}"`
      : 'the selected products';
    return _emptyCard({ capability, label, params, summary_text: `No active products found in ${selectorDesc}.` });
  }

  const numValue = Number(value);
  const allRows = products.map(p => {
    const before = Math.round(Number(p.selling_price || 0) * 100) / 100;
    let after = before;
    if (change_type === 'increase_pct') after = Math.round(before * (1 + numValue / 100) * 100) / 100;
    else if (change_type === 'decrease_pct') after = Math.max(0, Math.round(before * (1 - numValue / 100) * 100) / 100);
    else if (change_type === 'set_price') after = Math.round(numValue * 100) / 100;
    return { name: p.name, before, after, diff: Math.round((after - before) * 100) / 100 };
  });

  const totalCount = allRows.length;
  const previewRows = allRows.slice(0, 5);
  const moreCount = Math.max(0, totalCount - 5);
  const changeDesc = _describeChange({ change_type, value: numValue, operation, s });

  return {
    capability,
    label,
    operation: changeDesc,
    operation_description: `${changeDesc} — ${totalCount} product${totalCount !== 1 ? 's' : ''}`,
    summary_text: `I will update ${totalCount} product${totalCount !== 1 ? 's' : ''} (${changeDesc}). Confirm to proceed.`,
    affected_count: totalCount,
    preview_rows: previewRows,
    more_count: moreCount,
    currency,
    error: false,
    empty: false,
    _plan_steps: [{ capability, params, label }],
  };
}

function _buildGenericPlan({ capability, params, label, orgContext }) {
  return {
    capability,
    label,
    operation: label,
    operation_description: label,
    summary_text: `I will: ${label}. Confirm to proceed.`,
    affected_count: null,
    preview_rows: [],
    more_count: 0,
    currency: orgContext?.currency || 'INR',
    error: false,
    empty: false,
    _plan_steps: [{ capability, params, label }],
  };
}

function _errorCard({ capability, label, params, summary_text }) {
  return { capability, label, operation: label, operation_description: label, summary_text,
    affected_count: 0, preview_rows: [], more_count: 0, currency: 'INR', error: true, empty: false,
    _plan_steps: [{ capability, params, label }] };
}

function _emptyCard({ capability, label, params, summary_text }) {
  return { capability, label, operation: label, operation_description: label, summary_text,
    affected_count: 0, preview_rows: [], more_count: 0, currency: 'INR', error: false, empty: true,
    _plan_steps: [{ capability, params, label }] };
}

function _describeChange({ change_type, value, operation, s }) {
  if (change_type === 'increase_pct') return `+${value}% price increase`;
  if (change_type === 'decrease_pct') return `-${value}% price decrease`;
  if (change_type === 'set_price')    return `Set price to ${s}${value}`;
  if (operation === 'archive')        return 'Archive products';
  if (operation === 'restore')        return 'Restore products';
  if (operation === 'update')         return 'Update product details';
  return operation || 'Update';
}
