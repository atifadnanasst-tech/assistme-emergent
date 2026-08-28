/**
 * AssistMe — recordPurchaseBill() Domain Service
 * Location: /backend/src/services/business/recordPurchaseBill.js
 * Created: Session F, May 2026
 *
 * SECOND CANONICAL BUSINESS PRIMITIVE (mirrors recordPayment.js pattern exactly).
 * Called by every purchase bill creation path. Never duplicated. Never bypassed.
 *
 * Callers (present and future):
 *   - POST /api/purchase-bills          (manual UI — PurchaseBillSheet)
 *   - case 'create_purchase_bill'       (Spark AI execution in entity chat)
 *
 * NOT called by GPT directly. Deterministic tool only.
 * GPT extracts intent and parameters. This function executes. Never the reverse.
 *
 * ENTITY MODEL:
 *   All entities live in the customers table. customer_id is the single identity.
 *   purchase_bills.supplier_id (legacy column) is null for all new bills.
 *   purchase_bills.customer_id (new column) is used for all new bills.
 *
 * INVENTORY RULES:
 *   - Finished goods (product.is_raw_material = false, track_inventory = true):
 *       inventory.quantity incremented + inventory_transactions row written
 *   - Raw materials (product.is_raw_material = true):
 *       financial write only — inventory NOT touched
 *   - track_inventory = false: inventory NOT touched regardless
 *
 * LOCATION HANDLING:
 *   inventory requires location_id (NOT NULL).
 *   Finds or creates a default 'Main Store' location per org (non-blocking).
 *
 * BILL NUMBER:
 *   Auto-generated as PB-001, PB-002 if not provided. Mirrors INV-001 pattern.
 *
 * DUE DATE:
 *   Auto-calculated as issue_date + payment_terms_days if not provided.
 *   Reads from customers.payment_terms_days. Default: 30 days.
 *
 * Returns events[] — callers own ALL rendering, chat messages, notifications.
 * Zero UI awareness. Zero narration. Zero chat writes.
 *
 * COST PRICE RULE:
 *   products.cost_price is updated to the latest purchase price on every bill.
 *   AssistMe v1 uses Latest Purchase Cost methodology intentionally.
 *   Weighted Average, FIFO, and accounting valuation methods are
 *   out of scope for this primitive. This is a product decision, not a bug.
 *
 * V1 KNOWN DEBT (matches recordPayment.js):
 *   No Postgres transaction wrapping. Partial failure leaves bill created
 *   but inventory potentially incomplete. Documented for Phase 2 hardening.
 *   Bill numbering uses count+1 (same as INV-, Q-). Race condition
 *   handled by UNIQUE constraint — duplicate rejected, not silently created.
 *
 * Entity memory keys managed here:
 *   last_purchase_date     — most recent bill date (YYYY-MM-DD)
 *   total_purchases_amount — running total purchased from this entity (string)
 */

import { randomUUID } from 'crypto';
import { getBusinessProfile } from '../capabilities/setBusinessProfileCapability.js';

const istToday = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};

async function getOrCreateDefaultLocation(supabase, orgId) {
  try {
    const { data: existing } = await supabase
      .from('locations')
      .select('id')
      .eq('organisation_id', orgId)
      .eq('is_active', true)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();

    if (existing?.id) return existing.id;

    const { data: created, error } = await supabase
      .from('locations')
      .insert({
        organisation_id: orgId,
        name: 'Main Store',
        type: 'warehouse',
        is_active: true,
      })
      .select('id')
      .single();

    if (error) {
      console.warn('[recordPurchaseBill] location create failed:', error.message);
      return null;
    }

    return created.id;
  } catch (err) {
    console.warn('[recordPurchaseBill] getOrCreateDefaultLocation error:', err.message);
    return null;
  }
}

export async function recordPurchaseBill(supabase, orgId, customerId, items, opts = {}) {
  const start = Date.now();
  const operationId = randomUUID();
  const events = [];

  console.log(`[recordPurchaseBill] start op=${operationId} entity=${customerId} items=${items?.length}`);

  try {
    if (!orgId || !customerId) {
      return { status: 'failed', operation_id: operationId, events, error: 'missing_org_or_entity' };
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return { status: 'failed', operation_id: operationId, events, error: 'no_items' };
    }

    const { data: entity, error: entityErr } = await supabase
      .from('customers')
      .select('id, name, payment_terms_days')
      .eq('id', customerId)
      .eq('organisation_id', orgId)
      .is('deleted_at', null)
      .maybeSingle();

    if (entityErr || !entity) {
      return { status: 'failed', operation_id: operationId, events, error: 'entity_not_found' };
    }

    const issueDate = opts.issueDate || istToday();

    let dueDate = opts.dueDate || null;
    if (!dueDate) {
      const termsDays = entity.payment_terms_days ?? 30;
      const due = new Date(issueDate);
      due.setDate(due.getDate() + termsDays);
      dueDate = due.toISOString().split('T')[0];
    }

    let billNumber = opts.billNumber || null;
    if (!billNumber) {
      const { count: pbCount } = await supabase
        .from('purchase_bills')
        .select('*', { count: 'exact', head: true })
        .eq('organisation_id', orgId);
      billNumber = 'PB-' + ((pbCount || 0) + 1).toString().padStart(3, '0');
    }

    const productIds = items.map(i => i.product_id).filter(Boolean);
    let productMap = {};
    if (productIds.length > 0) {
      const { data: products } = await supabase
        .from('products')
        // custom_fields added (Aug 2026) -- hsn_code lives there, not a
        // dedicated column, matching the same storage pattern products
        // already use everywhere else in this codebase.
        .select('id, name, cost_price, track_inventory, is_raw_material, custom_fields')
        .in('id', productIds)
        .eq('organisation_id', orgId);
      (products || []).forEach(p => { productMap[p.id] = p; });
    }

    // CGST/SGST/IGST split (Aug 2026, Atif's own design review) --
    // mirrors calculateInvoiceTotals()'s exact interstate/intrastate
    // determination in backend/src/index.js: same states or either
    // unknown = intrastate = CGST+SGST; both known and different =
    // interstate = IGST. Deliberately reused here rather than
    // duplicated with different logic, per Atif's explicit ask.
    // Lives INSIDE this shared primitive (not in either caller) so both
    // Spark's create_purchase_bill case and the manual UI get it
    // automatically, with zero Spark-specific changes needed.
    let supplierState = null, customerState = null;
    try {
      const orgProfile = await getBusinessProfile(orgId, supabase);
      supplierState = orgProfile?.state || null;
    } catch {}
    try {
      const { data: addrs } = await supabase
        .from('customer_addresses').select('state')
        .eq('customer_id', customerId).eq('organisation_id', orgId)
        .eq('type', 'billing').limit(1);
      customerState = addrs?.[0]?.state || null;
    } catch {}
    const isInterstate = !!(supplierState && customerState &&
      supplierState.toLowerCase() !== customerState.toLowerCase());

    let subtotal = 0;
    let totalTax = 0;
    let totalDiscount = 0;
    let cgstTotal = 0, sgstTotal = 0, igstTotal = 0;

    const resolvedItems = items.map((item, idx) => {
      const qty = Number(item.quantity) || 1;
      const unitPrice = Number(item.unit_price) || 0;
      const discountPct = Number(item.discount_pct) || 0;
      const taxRate = Number(item.tax_rate) || 0;

      const discountAmt = (unitPrice * qty * discountPct) / 100;
      const taxableAmt = (unitPrice * qty) - discountAmt;
      const taxAmt = (taxableAmt * taxRate) / 100;
      const lineTotal = Math.round((taxableAmt + taxAmt) * 100) / 100;

      subtotal += taxableAmt;
      totalTax += taxAmt;
      totalDiscount += discountAmt;

      if (taxAmt > 0) {
        if (isInterstate) {
          igstTotal += taxAmt;
        } else {
          cgstTotal += taxAmt / 2;
          sgstTotal += taxAmt / 2;
        }
      }

      return {
        product_id: item.product_id || null,
        description: item.description || productMap[item.product_id]?.name || 'Item',
        quantity: qty,
        unit_price: unitPrice,
        discount_pct: discountPct,
        tax_rate: taxRate,
        line_total: lineTotal,
        sort_order: idx,
        // HSN parity with invoice_items (Aug 2026, Atif's own design
        // review) -- purely additive, nullable column.
        hsn_code: item.hsn_code || productMap[item.product_id]?.custom_fields?.hsn_code || null,
      };
    });

    subtotal = Math.round(subtotal * 100) / 100;
    totalTax = Math.round(totalTax * 100) / 100;
    totalDiscount = Math.round(totalDiscount * 100) / 100;
    cgstTotal = Math.round(cgstTotal * 100) / 100;
    sgstTotal = Math.round(sgstTotal * 100) / 100;
    igstTotal = Math.round(igstTotal * 100) / 100;
    const totalAmount = Math.round((subtotal + totalTax) * 100) / 100;

    const { data: bill, error: billErr } = await supabase
      .from('purchase_bills')
      .insert({
        organisation_id: orgId,
        customer_id: customerId,
        supplier_id: null,
        bill_number: billNumber,
        supplier_bill_number: opts.supplierBillNumber || null,
        status: 'received',
        issue_date: issueDate,
        due_date: dueDate,
        currency: 'INR',
        subtotal,
        discount_amount: totalDiscount,
        tax_amount: totalTax,
        total_amount: totalAmount,
        amount_paid: 0,
        amount_due: totalAmount,
        notes: opts.notes || null,
        is_historical: false,
        historical_source: opts.historicalSource || null,
        import_metadata: { operation_id: operationId },
        // Matches the exact same pattern invoices already use (Aug
        // 2026, Atif's own design review) -- custom_fields is the only
        // place this breakdown lives for invoices too (no dedicated
        // cgst/sgst/igst columns exist on either table), so this is
        // consistent, not a new pattern.
        custom_fields: { cgst_amount: cgstTotal, sgst_amount: sgstTotal, igst_amount: igstTotal, is_interstate: isInterstate },
      })
      .select('id, bill_number, total_amount, custom_fields')
      .single();

    if (billErr || !bill) {
      console.error('[recordPurchaseBill] bill insert failed:', billErr?.message);
      return { status: 'failed', operation_id: operationId, events, error: 'bill_insert_failed' };
    }

    events.push({
      type: 'purchase_bill_created',
      operation_id: operationId,
      bill_id: bill.id,
      bill_number: bill.bill_number,
      total_amount: totalAmount,
      due_date: dueDate,
      entity_name: entity.name,
    });

    const itemRows = resolvedItems.map(item => ({
      organisation_id: orgId,
      bill_id: bill.id,
      ...item,
    }));

    const { error: itemsErr } = await supabase
      .from('purchase_bill_items')
      .insert(itemRows);

    if (itemsErr) {
      console.error('[recordPurchaseBill] items insert failed:', itemsErr.message);
      events.push({ type: 'items_insert_warning', operation_id: operationId, error: itemsErr.message });
    }

    const locationId = await getOrCreateDefaultLocation(supabase, orgId);

    if (locationId) {
      for (const item of resolvedItems) {
        if (!item.product_id) continue;

        const product = productMap[item.product_id];
        if (!product) continue;
        if (product.track_inventory === false) continue;

        if (product.is_raw_material === true) {
          events.push({
            type: 'inventory_skipped_raw_material',
            operation_id: operationId,
            product_id: item.product_id,
            product_name: item.description,
          });
          continue;
        }

        const { data: existingInv } = await supabase
          .from('inventory')
          .select('id, quantity')
          .eq('organisation_id', orgId)
          .eq('product_id', item.product_id)
          .eq('location_id', locationId)
          .is('deleted_at', null)
          .maybeSingle();

        if (existingInv) {
          const newQty = Math.round((Number(existingInv.quantity) + Number(item.quantity)) * 10000) / 10000;
          await supabase
            .from('inventory')
            .update({ quantity: newQty })
            .eq('id', existingInv.id);
        } else {
          await supabase
            .from('inventory')
            .insert({
              organisation_id: orgId,
              product_id: item.product_id,
              location_id: locationId,
              quantity: Number(item.quantity),
              reserved_qty: 0,
              reorder_point: 0,
              reorder_qty: 0,
            });
        }

        await supabase
          .from('inventory_transactions')
          .insert({
            organisation_id: orgId,
            product_id: item.product_id,
            location_id: locationId,
            type: 'in',
            quantity: Number(item.quantity),
            reference_type: 'purchase_bill',
            reference_id: bill.id,
            notes: `Purchase bill ${bill.bill_number} from ${entity.name}`,
          });

        events.push({
          type: 'inventory_updated',
          operation_id: operationId,
          product_id: item.product_id,
          product_name: item.description,
          quantity_added: item.quantity,
        });
      }
    } else {
      console.warn('[recordPurchaseBill] no location available — inventory write skipped');
      events.push({ type: 'inventory_skipped_no_location', operation_id: operationId });
    }

    try {
      for (const item of resolvedItems) {
        if (!item.product_id) continue;
        // Only update cost_price when owner confirmed a real price (> 0)
        // Prevents overwriting catalog cost_price with null/zero/AI-guessed values
        const confirmedPrice = Number(item.unit_price || 0);
        if (confirmedPrice <= 0) continue;
        await supabase
          .from('products')
          .update({ cost_price: confirmedPrice })
          .eq('id', item.product_id)
          .eq('organisation_id', orgId);
      }
    } catch (cpErr) {
      console.warn('[recordPurchaseBill] cost_price update failed (non-fatal):', cpErr.message);
    }

    try {
      await supabase.from('entity_memory').upsert({
        organisation_id: orgId,
        entity_type: 'customer',
        entity_id: customerId,
        memory_key: 'last_purchase_date',
        memory_value: issueDate,
        confidence: 1.0,
      }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

      const { data: existingMem } = await supabase
        .from('entity_memory')
        .select('memory_value')
        .eq('organisation_id', orgId)
        .eq('entity_type', 'customer')
        .eq('entity_id', customerId)
        .eq('memory_key', 'total_purchases_amount')
        .maybeSingle();

      const currentTotal = Number(existingMem?.memory_value || 0);
      const newTotal = Math.round((currentTotal + totalAmount) * 100) / 100;

      await supabase.from('entity_memory').upsert({
        organisation_id: orgId,
        entity_type: 'customer',
        entity_id: customerId,
        memory_key: 'total_purchases_amount',
        memory_value: String(newTotal),
        confidence: 1.0,
      }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

    } catch (memErr) {
      console.warn('[recordPurchaseBill] entity_memory write failed (non-fatal):', memErr.message);
    }

    console.log(`[recordPurchaseBill] op=${operationId} complete in ${Date.now() - start}ms — ${billNumber} INR ${totalAmount}`);

    return {
      status: 'success',
      operation_id: operationId,
      events,
      bill_id: bill.id,
      bill_number: billNumber,
      total_amount: totalAmount,
      amount_due: totalAmount,
      due_date: dueDate,
      entity_name: entity.name,
      // GST breakdown (Aug 2026, Atif's own design review), additive --
      // existing callers reading this object are unaffected by new keys.
      cgst_amount: cgstTotal,
      sgst_amount: sgstTotal,
      igst_amount: igstTotal,
      is_interstate: isInterstate,
    };

  } catch (err) {
    console.error(`[recordPurchaseBill] op=${operationId} unexpected error:`, err.message);
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'server_error',
      message: err.message,
    };
  }
}
