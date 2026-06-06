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
import { resolveCustomerSelector } from '../capabilities/customerSelector.js';

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', AED: 'AED ', GBP: '£', EUR: '€' };
const sym = (currency) => CURRENCY_SYMBOLS[currency] || `${currency} `;

// Centralized client plan card builder — strips server-only fields (_plan_steps)
// Single source of truth: add new client fields here only
export function buildClientPlanCard(planCard) {
  return {
    capability: planCard.capability,
    label: planCard.label,
    operation: planCard.operation,
    operation_description: planCard.operation_description,
    affected_count: planCard.affected_count,
    preview_rows: planCard.preview_rows,
    more_count: planCard.more_count,
    currency: planCard.currency,
    is_multi_step: planCard.is_multi_step || false,
    step_cards: planCard.step_cards || null,
  };
}

export async function buildExecutionPlanCard({ validPlan, orgId, supabase, orgContext }) {
  if (!validPlan || validPlan.length === 0) return null;

  // Single step — existing path unchanged
  if (validPlan.length === 1) {
    const step = validPlan[0];
    const { capability, params, label } = step;
    if (capability === 'mutate_product') return _buildProductMutationPlan({ params, orgId, supabase, orgContext, label, capability });
    if (capability === 'mutate_payment') return _buildPaymentPlan({ params, label, capability, orgContext, orgId, supabase });
    if (capability === 'mutate_invoice') return _buildInvoicePlan({ params, label, capability, orgContext, orgId, supabase });
    if (capability === 'set_entity_field') return _buildSetEntityFieldPlan({ params, label, capability, orgContext, orgId, supabase });
    return _buildGenericPlan({ capability, params, label, orgContext });
  }

  // Multi-step — build each step card individually, return as composite
  const stepCards = [];
  for (const step of validPlan) {
    const { capability, params, label } = step;
    let card;
    if (capability === 'mutate_product') card = await _buildProductMutationPlan({ params, orgId, supabase, orgContext, label, capability });
    else if (capability === 'mutate_payment') card = await _buildPaymentPlan({ params, label, capability, orgContext, orgId, supabase });
    else if (capability === 'mutate_invoice') card = await _buildInvoicePlan({ params, orgId, supabase, orgContext, label, capability });
    else if (capability === 'set_entity_field') card = await _buildSetEntityFieldPlan({ params, orgId, supabase, orgContext, label, capability });
    else card = _buildGenericPlan({ capability, params, label, orgContext });

    // Surface clarification immediately — cannot proceed with multi-step if entity is ambiguous
    if (card?.clarification_needed) return card;

    // Hard stop on error only — empty (no matching records) is not a hard error
    if (card?.error) {
      return {
        ...card,
        error: true,
        summary_text: `Step ${stepCards.length + 1} could not be prepared: ${card.summary_text}`,
      };
    }

    stepCards.push(card);
  }

  // Composite card — step_cards preserved for frontend rendering
  // No aggregate affected_count — misleading across different capability types
  return {
    capability: 'multi_step',
    label: `${validPlan.length}-step plan`,
    operation: `${validPlan.length} actions`,
    operation_description: stepCards.map((c, i) => (i + 1) + '. ' + (c.operation_description || c.operation)).join('\n'),
    summary_text: stepCards.map((c, i) => (i + 1) + '. ' + (c.operation_description || c.operation)).join('\n'),
    affected_count: null,
    preview_rows: [],
    step_cards: stepCards,
    more_count: 0,
    currency: orgContext?.currency || 'INR',
    error: false,
    empty: false,
    is_multi_step: true,
    _plan_steps: validPlan.map(s => ({ capability: s.capability, params: s.params, label: s.label })),
  };
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

  // Show product name when only 1 matched — more informative for owner
  const productLabel = totalCount === 1
    ? allRows[0].name
    : totalCount + ' product' + (totalCount !== 1 ? 's' : '');

  return {
    capability,
    label,
    operation: changeDesc,
    operation_description: changeDesc + ' — ' + productLabel,
    summary_text: 'I will update ' + productLabel + ' (' + changeDesc + '). Confirm to proceed.',
    affected_count: totalCount,
    preview_rows: previewRows,
    more_count: moreCount,
    currency,
    error: false,
    empty: false,
    _plan_steps: [{ capability, params, label }],
  };
}

async function _buildPaymentPlan({ params, label, capability, orgContext, orgId, supabase }) {
  const { customer: customerSelector = {}, amount, date, method } = params;
  const currency = orgContext?.currency || 'INR';
  const s = currency === 'INR' ? '₹' : `${currency} `;
  const numAmount = Number(amount);
  const paymentDate = date || new Date().toISOString().split('T')[0];
  const methodLabel = method ? ` via ${method}` : '';

  // Resolve customer name from DB so preview shows confirmed name, not raw planner input
  let customerName = customerSelector.name || customerSelector.customer_name || 'the customer';
  if (orgId && supabase && (customerSelector.name || customerSelector.customer_name)) {
    const { customer, candidates } = await resolveCustomerSelector({ selector: customerSelector, orgId, supabase });

    // Multiple candidates — return structured clarification card before showing plan
    if ((candidates || []).length > 1) {
      return {
        capability,
        label,
        clarification_needed: true,
        clarification_type: 'customer_selection',
        clarification_text: `I found ${candidates.length} customers matching that name. Which one did you mean?`,
        options: candidates.slice(0, 5).map(c => ({
          id: c.id,
          label: c.name,
          sublabel: c.outstanding_balance > 0
            ? `Outstanding: ₹${Number(c.outstanding_balance).toLocaleString('en-IN')}`
            : 'No outstanding',
        })),
        original_params: params,  // preserved for plan regeneration after selection
        _plan_steps: [{ capability, params, label }],
      };
    }

    if (customer?.name) customerName = customer.name;
  }

  return {
    capability,
    label,
    operation: `Record payment — ${s}${numAmount.toLocaleString('en-IN')}`,
    operation_description: `${s}${numAmount.toLocaleString('en-IN')} from ${customerName}${methodLabel}`,
    summary_text: `Record ${s}${numAmount.toLocaleString('en-IN')} payment from ${customerName}${methodLabel} (${paymentDate}). Confirm to proceed.`,
    affected_count: 1,
    preview_rows: [],
    more_count: 0,
    currency,
    error: false,
    empty: false,
    _plan_steps: [{ capability, params, label }],
  };
}

async function _buildInvoicePlan({ params, label, capability, orgContext, orgId, supabase }) {
  const { customer, items = [] } = params;
  const s = orgContext?.currency === 'USD' ? '$' : '₹';

  // Resolve customer name for preview
  let customerName = customer?.name || customer?.customer_name || 'the customer';
  if (orgId && supabase && (customer?.name || customer?.customer_name)) {
    const { resolveCustomerSelector } = await import('../capabilities/customerSelector.js');
    const { customer: resolved, candidates } = await resolveCustomerSelector({
      selector: customer, orgId, supabase,
    });

    if ((candidates || []).length > 1) {
      return {
        capability,
        label,
        clarification_needed: true,
        clarification_type: 'customer_selection',
        clarification_text: 'I found ' + candidates.length + ' customers matching that name. Which one did you mean?',
        options: candidates.slice(0, 5).map(c => ({
          id: c.id,
          label: c.name,
          sublabel: c.outstanding_balance > 0
            ? 'Outstanding: ' + s + Number(c.outstanding_balance).toLocaleString('en-IN')
            : 'No outstanding',
        })),
        original_params: params,
        _plan_steps: [{ capability, params, label }],
      };
    }
    if (resolved?.name) customerName = resolved.name;
  }

  // Build item summary for preview
  const itemCount = items.length;
  const itemNames = items.slice(0, 3).map(i => i.name || i.product_name || 'item').join(', ');
  const itemSummary = itemCount === 1 ? itemNames : itemCount + ' items (' + itemNames + (itemCount > 3 ? '...' : '') + ')';

  return {
    capability,
    label,
    operation: 'Create invoice',
    operation_description: 'Invoice for ' + customerName + ' — ' + itemSummary,
    summary_text: 'Create invoice for ' + customerName + ' with ' + itemSummary + '. Confirm to proceed.',
    affected_count: 1,
    preview_rows: [],
    more_count: 0,
    currency: orgContext?.currency || 'INR',
    error: false,
    empty: false,
    _plan_steps: [{ capability, params, label }],
  };
}

async function _buildSetEntityFieldPlan({ params, label, capability, orgContext, orgId, supabase }) {
  const { mutation_key, entity = {}, new_value } = params;
  const s = sym(orgContext?.currency || 'INR');

  if (!mutation_key) return _errorCard({ capability, label, params, summary_text: 'No mutation_key provided.' });

  const { data: fieldDef, error: wlErr } = await supabase
    .from('ai_writable_fields')
    .select('mutation_key, field_label, value_type, allowed_values, entity_type, table_name, field_path, rejection_message')
    .eq('mutation_key', mutation_key)
    .eq('is_active', true)
    .maybeSingle();

  if (wlErr || !fieldDef) {
    return _errorCard({ capability, label, params, summary_text: 'This field cannot be updated via AI. Please update it manually in the app.' });
  }

  if (fieldDef.allowed_values && new_value !== undefined && new_value !== null) {
    const allowed = Array.isArray(fieldDef.allowed_values)
      ? fieldDef.allowed_values
      : JSON.parse(fieldDef.allowed_values || '[]');
    if (!allowed.map(String).includes(String(new_value).trim())) {
      return _errorCard({ capability, label, params,
        summary_text: fieldDef.field_label + ' must be one of: ' + allowed.join(', ') + '. Got: ' + new_value,
      });
    }
  }

  let entityId = null;
  let entityName = entity.name || entity.customer_name || entity.product_name || 'the record';

  if (fieldDef.entity_type === 'customer') {
    const selector = entity.id ? { customer_id: entity.id } : { name: entity.name || entity.customer_name };
    const { customer, candidates } = await resolveCustomerSelector({ selector, orgId, supabase });
    if ((candidates || []).length > 1) {
      return {
        capability, label, clarification_needed: true, clarification_type: 'customer_selection',
        clarification_text: 'I found ' + candidates.length + ' customers matching that name. Which one did you mean?',
        options: candidates.slice(0, 5).map(c => ({
          id: c.id, label: c.name,
          sublabel: c.outstanding_balance > 0 ? 'Outstanding: ' + s + Number(c.outstanding_balance).toLocaleString('en-IN') : 'No outstanding',
        })),
        original_params: params, _plan_steps: [{ capability, params, label }],
      };
    }
    if (!customer) return _errorCard({ capability, label, params, summary_text: 'Customer not found. Please check the name and try again.' });
    entityId = customer.id; entityName = customer.name;

  } else if (fieldDef.entity_type === 'product') {
    const selector = entity.id ? { product_id: entity.id } : { name: entity.name || entity.product_name };
    const { products } = await resolveProductSelector({ selector, orgId, supabase });
    if (products && products.length > 1) {
      return {
        capability, label, clarification_needed: true, clarification_type: 'product_selection',
        clarification_text: 'I found ' + products.length + ' products matching that name. Which one did you mean?',
        options: products.slice(0, 5).map(p => ({ id: p.id, label: p.name, sublabel: p.category || '' })),
        original_params: params, _plan_steps: [{ capability, params, label }],
      };
    }
    if (!products || products.length === 0) return _errorCard({ capability, label, params, summary_text: 'Product not found. Please check the name and try again.' });
    entityId = products[0].id; entityName = products[0].name;
  }

  const isCustomField = fieldDef.field_path.startsWith('custom_fields.');
  const selectCol = isCustomField ? 'custom_fields' : fieldDef.field_path;
  const { data: row } = await supabase
    .from(fieldDef.table_name).select(selectCol)
    .eq('id', entityId).eq('organisation_id', orgId).maybeSingle();

  let currentValue = null;
  if (row) {
    const customFieldKey = isCustomField ? fieldDef.field_path.replace('custom_fields.', '') : null;
    currentValue = isCustomField ? (row.custom_fields?.[customFieldKey] ?? null) : row[fieldDef.field_path];
  }

  const isCurrencyField = mutation_key.includes('credit_limit') || mutation_key.includes('amount');
  const formatVal = (v) => {
    if (v === null || v === undefined) return '(not set)';
    if (fieldDef.value_type === 'number' && isCurrencyField) return s + Number(v).toLocaleString('en-IN');
    return String(v);
  };

  const beforeDisplay = formatVal(currentValue);
  const afterDisplay = formatVal(new_value);

  return {
    capability, label,
    operation: 'Update ' + fieldDef.field_label,
    operation_description: fieldDef.field_label + ' for ' + entityName + ': ' + beforeDisplay + ' → ' + afterDisplay,
    summary_text: 'Change ' + fieldDef.field_label + ' for ' + entityName + ' from ' + beforeDisplay + ' to ' + afterDisplay + '. Confirm to proceed.',
    affected_count: 1,
    preview_rows: [{ name: fieldDef.field_label, before: beforeDisplay, after: afterDisplay }],
    more_count: 0, currency: orgContext?.currency || 'INR', error: false, empty: false,
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
  if (change_type === 'increase_pct') return '+' + value + '% price increase';
  if (change_type === 'increase_abs') return '+' + s + value + ' price increase';
  if (change_type === 'decrease_abs') return '-' + s + value + ' price decrease';
  if (change_type === 'decrease_pct') return '-' + value + '% price decrease';
  if (change_type === 'set_price')    return 'Set price to ' + s + value;
  if (operation === 'archive')        return 'Archive products';
  if (operation === 'restore')        return 'Restore products';
  if (operation === 'update')         return 'Update product details';
  return operation || 'Update';
}
