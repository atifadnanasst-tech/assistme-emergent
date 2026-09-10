// backend/src/services/business/adjustInventory.js
//
// Single shared primitive for ALL inventory stock movements -- purchase
// (in), sale (out), manual stock entry (in), and any future movement
// type. Every NEW call site should go through this function; no new
// code should write to `inventory` or `inventory_by_vendor` directly.
//
// NOTE: recordPurchaseBill.js's own existing inventory-increment logic
// is deliberately NOT migrated to call this function yet -- it already
// works correctly today (proven, shared between Spark and the manual
// UI), and per the BUILD-BESIDE-THEN-MIGRATE doctrine, changing working
// code purely for consistency isn't worth the regression risk right
// now. It's a known, flagged migration target for later.
//
// FUTURE WORK: goods returned (either direction) or any other reversal/
// adjustment scenario is NOT handled by this initial design and needs a
// deliberate revisit of this function before goods-return features are
// built.

import { getOrCreateDefaultLocation } from './recordPurchaseBill.js';

const roundQty = (n) => Math.round(Number(n) * 10000) / 10000;

/**
 * Move stock for one product by `delta` (positive = incoming, negative
 * = outgoing), keeping the aggregate `inventory` table and the optional
 * per-vendor `inventory_by_vendor` table consistent by construction --
 * this is the only function allowed to write to either table.
 *
 * @param {object} params
 * @param {object} params.supabase
 * @param {string} params.organisationId
 * @param {string} params.productId
 * @param {number} params.delta - positive for incoming stock, negative for outgoing
 * @param {string} [params.vendorId] - customers.id. When given, honored
 *   exactly -- even if it drives that vendor's own row negative. When
 *   omitted on an outgoing (negative) movement, falls back to
 *   largest-pool-first across whatever vendor rows already exist for
 *   this product.
 * @param {string} params.referenceType - e.g. 'invoice', 'manual_stock_entry', 'cross_org_acknowledge'
 * @param {string} [params.referenceId]
 * @param {string} [params.notes]
 * @param {string} [params.locationId] - defaults to the org's default location if omitted
 * @returns {Promise<object>} { status: 'success'|'skipped'|'failed', reason?, quantity_after?, vendor_breakdown? }
 */
export async function adjustInventory({
  supabase, organisationId, productId, delta, vendorId,
  referenceType, referenceId, notes, locationId,
}) {
  try {
    if (!productId || !delta) return { status: 'skipped', reason: 'no_product_or_zero_delta' };

    const { data: product } = await supabase.from('products')
      .select('id, track_inventory, is_raw_material')
      .eq('id', productId).eq('organisation_id', organisationId).maybeSingle();
    if (!product) return { status: 'skipped', reason: 'product_not_found' };
    if (product.track_inventory === false) return { status: 'skipped', reason: 'track_inventory_disabled' };
    if (product.is_raw_material === true) return { status: 'skipped', reason: 'raw_material' };

    const resolvedLocationId = locationId || await getOrCreateDefaultLocation(supabase, organisationId);
    if (!resolvedLocationId) return { status: 'failed', reason: 'no_location_available' };

    // 1. Update the aggregate -- single source of truth.
    const { data: existingInv } = await supabase.from('inventory')
      .select('id, quantity').eq('organisation_id', organisationId)
      .eq('product_id', productId).eq('location_id', resolvedLocationId)
      .is('deleted_at', null).maybeSingle();

    let newQty;
    if (existingInv) {
      newQty = roundQty(Number(existingInv.quantity) + delta);
      await supabase.from('inventory').update({ quantity: newQty }).eq('id', existingInv.id);
    } else {
      newQty = roundQty(delta);
      await supabase.from('inventory').insert({
        organisation_id: organisationId, product_id: productId, location_id: resolvedLocationId,
        quantity: newQty, reserved_qty: 0, reorder_point: 0, reorder_qty: 0,
      });
    }

    // 2. Record the movement (audit trail, matches existing convention
    // from recordPurchaseBill.js's own inventory_transactions writes).
    await supabase.from('inventory_transactions').insert({
      organisation_id: organisationId, product_id: productId, location_id: resolvedLocationId,
      type: delta > 0 ? 'in' : 'out',
      quantity: Math.abs(delta),
      reference_type: referenceType, reference_id: referenceId || null, notes: notes || null,
    });

    // 3. Vendor-scoped tracking -- best-effort, optional, never blocks
    // or reverses the aggregate update above (already committed).
    let vendorBreakdown = null;

    if (delta > 0 && vendorId) {
      // Incoming with a known vendor: straightforward increment/create.
      const { data: existingVendorRow } = await supabase.from('inventory_by_vendor')
        .select('id, quantity').eq('organisation_id', organisationId)
        .eq('product_id', productId).eq('vendor_id', vendorId).eq('location_id', resolvedLocationId)
        .maybeSingle();
      if (existingVendorRow) {
        await supabase.from('inventory_by_vendor')
          .update({ quantity: roundQty(Number(existingVendorRow.quantity) + delta), updated_at: new Date().toISOString() })
          .eq('id', existingVendorRow.id);
      } else {
        await supabase.from('inventory_by_vendor').insert({
          organisation_id: organisationId, product_id: productId, vendor_id: vendorId,
          location_id: resolvedLocationId, quantity: roundQty(delta),
        });
      }
      vendorBreakdown = { attribution: 'explicit_vendor', vendor_id: vendorId };
    } else if (delta < 0 && vendorId) {
      // Outgoing with an EXPLICIT vendor: honor it exactly, even if it
      // drives that vendor's row negative -- surfaces a real
      // discrepancy rather than hiding it (Atif's confirmed design).
      const { data: existingVendorRow } = await supabase.from('inventory_by_vendor')
        .select('id, quantity').eq('organisation_id', organisationId)
        .eq('product_id', productId).eq('vendor_id', vendorId).eq('location_id', resolvedLocationId)
        .maybeSingle();
      const currentQty = existingVendorRow ? Number(existingVendorRow.quantity) : 0;
      const afterQty = roundQty(currentQty + delta);
      if (existingVendorRow) {
        await supabase.from('inventory_by_vendor')
          .update({ quantity: afterQty, updated_at: new Date().toISOString() })
          .eq('id', existingVendorRow.id);
      } else {
        await supabase.from('inventory_by_vendor').insert({
          organisation_id: organisationId, product_id: productId, vendor_id: vendorId,
          location_id: resolvedLocationId, quantity: afterQty,
        });
      }
      vendorBreakdown = { attribution: 'explicit_vendor', vendor_id: vendorId };
    } else if (delta < 0 && !vendorId) {
      // Outgoing with NO vendor specified: largest-pool-first across
      // whatever vendor rows already exist for this product. Drains
      // each row (largest first) up to its own current quantity; the
      // LAST row touched absorbs any remaining shortfall and may go
      // negative if total tracked-by-vendor stock is less than the
      // actual sale -- same "surface the truth" philosophy as above.
      // If no vendor rows exist at all for this product, there is
      // nothing to attribute to and vendor-side tracking is skipped
      // entirely; only the aggregate (already updated above) moves.
      const { data: vendorRows } = await supabase.from('inventory_by_vendor')
        .select('id, vendor_id, quantity').eq('organisation_id', organisationId)
        .eq('product_id', productId).eq('location_id', resolvedLocationId)
        .order('quantity', { ascending: false });

      if (vendorRows && vendorRows.length > 0) {
        let remaining = Math.abs(delta);
        const touched = [];
        for (let i = 0; i < vendorRows.length && remaining > 0; i++) {
          const row = vendorRows[i];
          const isLastRow = i === vendorRows.length - 1;
          const rowQty = Number(row.quantity);
          const takeAmount = isLastRow ? remaining : Math.min(remaining, Math.max(rowQty, 0));
          const afterQty = roundQty(rowQty - takeAmount);
          await supabase.from('inventory_by_vendor')
            .update({ quantity: afterQty, updated_at: new Date().toISOString() })
            .eq('id', row.id);
          touched.push({ vendor_id: row.vendor_id, taken: takeAmount, quantity_after: afterQty });
          remaining = roundQty(remaining - takeAmount);
        }
        vendorBreakdown = { attribution: 'largest_pool_first', touched };
      }
    }

    return { status: 'success', quantity_after: newQty, vendor_breakdown: vendorBreakdown };
  } catch (err) {
    console.error('[adjustInventory] unexpected error:', err.message);
    return { status: 'failed', reason: 'unexpected_error', error: err.message };
  }
}
