/**
 * AssistMe — prepareTransactionDocument() Domain Service
 * Location: /backend/src/services/business/prepareTransactionDocument.js
 * Created: Session F, May 2026
 *
 * PURPOSE: Transaction-agnostic document preparation engine.
 * First consumer: create_purchase_bill (Session F)
 * Planned consumers: create_invoice, create_quote, goods_returned, credit_note
 *
 * SHADOW EXTRACTION PRINCIPLE (CRITICAL - READ BEFORE MODIFYING)
 * This file contains EXACT COPIES of proven inline logic from index.js:
 *   normaliseVocabulary() - index.js line 2028
 *   resolveProduct()      - index.js line 2039
 *   Item resolution loop  - index.js Spark handler create_invoice branch
 * DO NOT redesign, improve, or reinterpret this logic.
 * Any improvement must be made in BOTH places until create_invoice migrates.
 *
 * MIGRATION PLAN (deferred - future session):
 *   1. Remove inline normaliseVocabulary from index.js
 *   2. Remove inline resolveProduct from index.js
 *   3. Import both from this file in index.js
 *   4. Replace inline item resolution loop with prepareTransactionDocument()
 *
 * UNIT PRICE SELECTION BY DOCUMENT TYPE:
 *   create_invoice, create_quote  -> selling_price from catalog
 *   create_purchase_bill          -> cost_price from catalog, fallback to GPT price
 *   goods_returned (outbound)     -> selling_price (customer returns to us)
 *   goods_returned (inbound)      -> cost_price (we return to supplier)
 */

export function normaliseVocabulary(v) {
  return (v || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '');
}

export async function resolveProduct({ productName, customerId, organisationId, supabase }) {
  if (!productName) return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };

  const cleanName = productName.trim().slice(0, 120);
  const nameLower = normaliseVocabulary(cleanName);

  const { data: exact } = await supabase
    .from('products').select('id, name, selling_price, cost_price, tax_rate, sku')
    .eq('organisation_id', organisationId).eq('is_active', true)
    .ilike('name', cleanName).limit(1);
  if (exact?.length > 0) {
    return { resolved: exact[0], alternatives: [], confidence: 1.0, resolution_type: 'exact' };
  }

  const { data: vocabRows } = await supabase
    .from('product_vocabularies')
    .select('product_id, match_strength, confirmed_count, products:product_id (id, name, selling_price, cost_price, tax_rate, sku)')
    .eq('organisation_id', organisationId)
    .eq('normalised', nameLower)
    .eq('is_active', true)
    .order('confirmed_count', { ascending: false })
    .order('match_strength', { ascending: false })
    .limit(1);
  if (vocabRows?.length > 0 && vocabRows[0].products) {
    return { resolved: vocabRows[0].products, alternatives: [], confidence: 0.9, resolution_type: 'vocabulary' };
  }

  const { data: fuzzy, error: fuzzyErr } = await supabase
    .rpc('search_products_fuzzy', {
      p_organisation_id: organisationId,
      p_search_term: cleanName,
      p_limit: 10,
      p_threshold: 0.15,
    });
  if (fuzzyErr) {
    console.error('[RESOLVE_PRODUCT] fuzzy rpc error:', fuzzyErr.message);
    return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };
  }
  if (!fuzzy || fuzzy.length === 0) {
    return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };
  }

  const productIds = fuzzy.map(p => p.id);
  if (productIds.length === 0) {
    return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };
  }

  const { data: custInvoices } = await supabase
    .from('invoices')
    .select('id, invoice_items(product_id, quantity)')
    .eq('organisation_id', organisationId)
    .eq('customer_id', customerId)
    .limit(50);

  const { data: orgItems } = await supabase
    .from('invoice_items').select('product_id, quantity')
    .eq('organisation_id', organisationId)
    .in('product_id', productIds);

  const custCounts = {};
  (custInvoices || []).forEach(inv => {
    (inv.invoice_items || []).forEach(item => {
      if (productIds.includes(item.product_id))
        custCounts[item.product_id] = (custCounts[item.product_id] || 0) + item.quantity;
    });
  });
  const orgCounts = {};
  (orgItems || []).forEach(r => {
    orgCounts[r.product_id] = (orgCounts[r.product_id] || 0) + r.quantity;
  });

  const scored = fuzzy.map(p => ({
    ...p,
    score: (custCounts[p.id] || 0) * 3 + (orgCounts[p.id] || 0) * 1
  })).sort((a, b) => b.score - a.score);

  const confidence = scored.length === 1 ? 0.6 : 0.4;
  return {
    resolved: scored[0],
    alternatives: scored.slice(1, 3),
    confidence,
    resolution_type: 'fuzzy'
  };
}

export async function learnVocabularyAliases({ supabase, organisationId, items }) {
  for (const item of items) {
    try {
      if (!item.product_id || !item.raw_product_name || !item.product_name) continue;
      const rawNormalised = normaliseVocabulary(item.raw_product_name);
      const catalogNormalised = normaliseVocabulary(item.product_name);
      if (rawNormalised === catalogNormalised) continue;

      const { data: existing } = await supabase
        .from('product_vocabularies')
        .select('id, usage_count, confirmed_count')
        .eq('organisation_id', organisationId)
        .eq('product_id', item.product_id)
        .eq('normalised', rawNormalised)
        .maybeSingle();

      if (existing) {
        await supabase.from('product_vocabularies').update({
          usage_count: existing.usage_count + 1,
          confirmed_count: existing.confirmed_count + 1,
          last_confirmed_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await supabase.from('product_vocabularies').insert({
          organisation_id: organisationId,
          product_id: item.product_id,
          vocabulary: item.raw_product_name.trim(),
          normalised: rawNormalised,
          source_type: 'owner_correction',
          match_strength: 0.5,
          usage_count: 1,
          confirmed_count: 1,
          first_seen_at: new Date().toISOString(),
          last_confirmed_at: new Date().toISOString(),
        });
      }
    } catch (aliasErr) {
      console.warn('[VOCAB] vocabulary write failed silently:', aliasErr.message);
    }
  }
}

export async function prepareTransactionDocument({
  supabase,
  organisationId,
  customerId,
  customerName,
  actionType,
  rawItems,
  entities,
}) {
  const ent = entities || {};

  const items = Array.isArray(rawItems)
    ? rawItems
    : (ent.product_name ? [{ product_name: ent.product_name, quantity: ent.quantity }] : []);

  const resolvedItems = [];
  let totalAmount = 0;

  const useCostPrice = actionType === 'create_purchase_bill';

  for (const item of items) {
    const { resolved, alternatives } = await resolveProduct({
      productName: item.product_name,
      customerId,
      organisationId,
      supabase,
    });

    const unitPrice = useCostPrice
      ? (resolved?.cost_price || item.unit_price || null)
      : (resolved?.selling_price || item.unit_price || null);

    const qty = item.quantity || 1;
    const lineTotal = unitPrice ? Math.round(unitPrice * qty * 100) / 100 : null;
    if (lineTotal) totalAmount += lineTotal;

    resolvedItems.push({
      raw_product_name: item.product_name,
      product_name: resolved?.name || item.product_name,
      product_id: resolved?.id || null,
      quantity: qty,
      unit_price: unitPrice,
      tax_rate: resolved?.tax_rate || 0,
      line_total: lineTotal,
      discount_pct: item.discount_pct || 0,
      alternatives: alternatives.map(a => ({
        id: a.id,
        name: a.name,
        selling_price: a.selling_price,
        cost_price: a.cost_price,
        tax_rate: a.tax_rate ?? 0,
      })),
    });
  }

  totalAmount = Math.round(totalAmount * 100) / 100;

  const actionParams = {
    customer_id: customerId,
    customer_name: customerName,
    items: resolvedItems,
    amount: ent.amount || totalAmount || null,
    due_date: ent.due_date || null,
    delivery_date: ent.delivery_date || null,
    freight: (ent.freight || 0) + (ent.packing || 0),
    freight_taxable: ent.freight_taxable || false,
    freight_tax_rate: ent.freight_tax_rate || 18,
    bill_number: ent.bill_number || null,
    supplier_bill_number: ent.supplier_bill_number || null,
    notes: ent.notes || null,
  };

  const itemLines = resolvedItems.map(it =>
    `${it.quantity} x ${it.product_name}${it.unit_price ? ` @ Rs.${it.unit_price.toLocaleString('en-IN')}` : ''}`
  );
  const totalStr = (ent.amount || totalAmount)
    ? `Rs.${(ent.amount || totalAmount).toLocaleString('en-IN')}`
    : null;

  const details = itemLines.join('\n')
    + (totalStr ? `\nTotal: ${totalStr}` : '')
    + (ent.due_date ? `\nDue: ${ent.due_date}` : '');

  const actionNameMap = {
    create_invoice: 'create invoice',
    create_quote: 'create quote',
    create_purchase_bill: 'create purchase bill',
    goods_returned: 'goods returned',
  };
  const actionName = `${actionNameMap[actionType] || actionType} for ${customerName}`;

  return {
    resolvedItems,
    totalAmount,
    actionParams,
    details,
    actionName,
  };
}
