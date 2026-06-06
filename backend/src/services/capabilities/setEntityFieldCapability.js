/**
 * AssistMe — setEntityFieldCapability.js
 * Session V-A, Jun 2026
 *
 * Generic field mutation capability backed by ai_writable_fields whitelist.
 * AI sees only mutation_key — never table_name or field_path.
 * Financial fields are never in the whitelist. Deny-by-default.
 *
 * Supported entity types: customer, product (V-A scope only)
 * Two execution paths:
 *   field_path = 'phone'                  → direct column UPDATE
 *   field_path = 'custom_fields.language' → set_customer_custom_field() RPC (customers only)
 *
 * Returns previous_value + new_value for COO result and audit log.
 */

import { resolveCustomerSelector } from './customerSelector.js';
import { resolveProductSelector } from './productSelector.js';

export async function setEntityFieldCapability(params, orgId, supabase, orgContext) {
  const { mutation_key, entity = {}, new_value } = params;

  if (!mutation_key) return _errorResult('No mutation_key provided.');
  if (new_value === undefined || new_value === null || String(new_value).trim() === '') {
    return _errorResult('No new value provided.');
  }

  // ── Step 1: Lookup whitelist ─────────────────────────────
  const { data: fieldDef, error: wlErr } = await supabase
    .from('ai_writable_fields')
    .select('*')
    .eq('mutation_key', mutation_key)
    .eq('is_active', true)
    .maybeSingle();

  if (wlErr || !fieldDef) {
    return _errorResult(
      'This field cannot be updated via AI. Please update it manually in the app.'
    );
  }

  // V-A scope: only customer and product supported
  if (!['customer', 'product'].includes(fieldDef.entity_type)) {
    return _errorResult('Unsupported entity type: ' + fieldDef.entity_type + '. Only customer and product fields are supported.');
  }

  // ── Step 2: Resolve entity ───────────────────────────────
  let entityId = null;
  let entityName = null;

  if (fieldDef.entity_type === 'customer') {
    const selector = entity.id
      ? { customer_id: entity.id }
      : { name: entity.name || entity.customer_name };

    const { customer, candidates, error: selErr } = await resolveCustomerSelector({
      selector, orgId, supabase,
    });

    if (selErr) return _errorResult('Could not look up customer: ' + selErr);
    if ((candidates || []).length > 1) {
      const names = candidates.slice(0, 4).map(c => c.name).join(', ');
      return _errorResult('Multiple customers found: ' + names + '. Please be more specific.');
    }
    if (!customer) return _errorResult('Customer not found. Please check the name and try again.');

    entityId = customer.id;
    entityName = customer.name;

  } else if (fieldDef.entity_type === 'product') {
    const selector = entity.id
      ? { product_id: entity.id }
      : { name: entity.name || entity.product_name };

    const { products, error: selErr } = await resolveProductSelector({ selector, orgId, supabase });

    if (selErr) return _errorResult('Could not look up product: ' + selErr);
    if (!products || products.length === 0) return _errorResult('Product not found. Please check the name and try again.');
    if (products.length > 1) {
      const names = products.slice(0, 3).map(p => p.name).join(', ');
      return _errorResult('Multiple products matched: ' + names + '. Please be more specific.');
    }

    entityId = products[0].id;
    entityName = products[0].name;
  }

  // ── Step 3: Read current value ───────────────────────────
  const isCustomField = fieldDef.field_path.startsWith('custom_fields.');
  const directColumn = isCustomField ? null : fieldDef.field_path;
  const customFieldKey = isCustomField ? fieldDef.field_path.replace('custom_fields.', '') : null;

  // Fix 1: RPC guard — custom_fields path only supported for customers
  if (isCustomField && fieldDef.entity_type !== 'customer') {
    return _errorResult('Custom field updates currently support customers only.');
  }

  const selectCol = isCustomField ? 'custom_fields' : fieldDef.field_path;
  const { data: currentRow, error: readErr } = await supabase
    .from(fieldDef.table_name)
    .select(selectCol)
    .eq('id', entityId)
    .eq('organisation_id', orgId)
    .maybeSingle();

  if (readErr || !currentRow) return _errorResult('Could not read current value. Please try again.');

  const previousValue = isCustomField
    ? (currentRow.custom_fields?.[customFieldKey] ?? null)
    : currentRow[fieldDef.field_path];

  // ── Step 4: Validate new_value ───────────────────────────
  let parsedValue = String(new_value).trim();

  if (fieldDef.value_type === 'number') {
    const num = Number(parsedValue.replace(/,/g, ''));
    if (isNaN(num) || num < 0) return _errorResult(fieldDef.field_label + ' must be a valid positive number.');
    parsedValue = num;
  }

  if (fieldDef.allowed_values) {
    // Fix 2: defensive parsing — Supabase may return array or string
    const allowed = Array.isArray(fieldDef.allowed_values)
      ? fieldDef.allowed_values
      : JSON.parse(fieldDef.allowed_values || '[]');
    if (!allowed.map(String).includes(String(parsedValue))) {
      return _errorResult(
        fieldDef.field_label + ' must be one of: ' + allowed.join(', ') + '. Got: ' + parsedValue
      );
    }
  }

  // ── Step 5: Execute update ───────────────────────────────
  let updateError = null;

  if (isCustomField) {
    const { error } = await supabase.rpc('set_customer_custom_field', {
      p_customer_id: entityId,
      p_org_id: orgId,
      p_key: customFieldKey,
      p_value: String(parsedValue),
    });
    updateError = error;
  } else {
    // Fix 3: verify rows affected — select id to confirm update landed
    const { data: updated, error } = await supabase
      .from(fieldDef.table_name)
      .update({ [directColumn]: parsedValue })
      .eq('id', entityId)
      .eq('organisation_id', orgId)
      .select('id');
    updateError = error;
    if (!error && (!updated || updated.length === 0)) {
      return _errorResult('Update did not apply — record may have been deleted. Please try again.');
    }
  }

  if (updateError) {
    console.error('[setEntityFieldCapability] update failed:', updateError.message);
    return _errorResult('Update failed. Please try again.');
  }

  // Fix 4: value formatting — only credit_limit-type fields get currency symbol
  // field_label is used as display, not numeric formatting for all numbers
  const isCurrencyField = fieldDef.mutation_key.includes('credit_limit') ||
    fieldDef.mutation_key.includes('amount') ||
    fieldDef.mutation_key.includes('balance');
  const s = orgContext?.currency === 'USD' ? '$' : '₹';

  const formatVal = (v) => {
    if (v === null || v === undefined) return '(not set)';
    if (fieldDef.value_type === 'number' && isCurrencyField) {
      return s + Number(v).toLocaleString('en-IN');
    }
    return String(v);
  };

  console.log('[setEntityFieldCapability]', {
    mutation_key, entity_name: entityName, previous_value: previousValue, new_value: parsedValue,
  });

  return {
    response_text: 'Done. ' + fieldDef.field_label + ' for ' + entityName +
      ' updated from ' + formatVal(previousValue) + ' to ' + formatVal(parsedValue) + '.',
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    _mutation_result: {
      affected_count: 1,
      operation: 'set_entity_field',
      is_success: true,
      mutation_key,
      field_label: fieldDef.field_label,
      entity_type: fieldDef.entity_type,
      entity_id: entityId,
      entity_name: entityName,
      previous_value: previousValue,
      new_value: parsedValue,
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
