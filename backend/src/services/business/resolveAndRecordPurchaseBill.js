// backend/src/services/business/resolveAndRecordPurchaseBill.js
//
// Shared orchestration for "acknowledge a purchase bill" and "create
// purchase bill from photo" -- both surfaces converge here, per Atif's
// design: one pipeline, multiple entry points. Resolves/creates/
// updates products (reusing confirmImportedProducts with
// skipStockAdjustment so nothing double-increments), then creates the
// actual purchase bill via recordPurchaseBill(), which performs the
// real, single stock increment and the bill itself in one call.
//
// customerId is used as BOTH the bill's customer_id (who this bill is
// recorded against) AND the vendor identity for inventory_by_vendor
// tracking -- for a purchase bill these are the same entity (who you
// bought it from IS whose stock batch this is), so callers only ever
// provide one id, not two.

import { confirmImportedProducts } from './productImport.js';
import { recordPurchaseBill } from './recordPurchaseBill.js';

export async function resolveAndRecordPurchaseBill({
  supabase, organisationId, customerId, items, dueDate, supplierBillNumber, notes,
}) {
  const productResult = await confirmImportedProducts({
    items, organisationId, supabase, vendorId: customerId, skipStockAdjustment: true,
  });

  if (productResult.resolvedItems.length === 0) {
    return {
      status: 'failed', reason: 'no_items_resolved',
      created: productResult.created, updated: productResult.updated,
      skipped: productResult.skipped, errors: productResult.errors,
    };
  }

  const billResult = await recordPurchaseBill(
    supabase, organisationId, customerId, productResult.resolvedItems,
    { dueDate, supplierBillNumber, notes }
  );

  if (billResult.status !== 'success') {
    // Fail closed, matching every other financial primitive in this
    // codebase: products/aliases already resolved above are NOT rolled
    // back (that's real catalog data, worth keeping even if the bill
    // itself fails) but no bill and no stock movement happened, so the
    // caller must not report this as a success.
    return {
      status: 'failed', reason: 'bill_creation_failed', detail: billResult.error,
      created: productResult.created, updated: productResult.updated,
      skipped: productResult.skipped, errors: productResult.errors,
    };
  }

  return {
    status: 'success',
    bill_id: billResult.bill_id, bill_number: billResult.bill_number, total_amount: billResult.total_amount,
    created: productResult.created, updated: productResult.updated,
    skipped: productResult.skipped, errors: productResult.errors,
  };
}
