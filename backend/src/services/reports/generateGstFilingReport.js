// GST Filing Report (Aug 2026, ATT list "GST Filing Report" -- dedicated session).
//
// Generates a period-scoped CSV of all real (non-Internal, non-draft)
// invoices for GST return filing (GSTR-1 style columns). Reuses the
// csvEscape/rowsToCSV helpers already built for Export My Data -- same
// CSV convention, same 'exports' Supabase Storage bucket, same
// per-org path scoping.
//
// Internal invoices (custom_fields.invoice_type === 'Internal') are
// deliberately excluded -- they carry their own separate INT- numbering
// sequence precisely so the real INV- sequence stays gapless here.
// Credit notes are explicitly OUT OF SCOPE for v1 (Atif's call, Aug 2026)
// -- deferred to v2 to keep this build fast.
//
// Follows the codebase's established pattern of separate queries +
// manual JS correlation (no embedded Supabase relation joins used
// anywhere else in this codebase for invoices+customers, so this
// matches real precedent rather than introducing an unverified pattern).
//
// PURCHASE-SIDE EXTENSION (Aug 2026, Atif's own design, after a real
// GST-law discussion): generates a SECOND CSV, mirroring the sales-side
// columns exactly, for purchase_bills. Important, deliberate caveat
// this feature does NOT try to solve: under Indian GST law, Input Tax
// Credit is legally gated by GSTR-2B (auto-generated from what
// SUPPLIERS report in their own filings), not by a buyer's own purchase
// records. This purchase-side file is a reconciliation aid for the CA
// -- "what we believe we bought and paid GST on" -- to cross-check
// against GSTR-2B, not a direct substitute for it or a basis for
// claiming ITC on its own. Includes both our own bill_number AND the
// supplier's own supplier_bill_number, since the latter is what
// actually needs to match GSTR-2B.

import { csvEscape, rowsToCSV } from '../export/generateOwnerDataExport.js';

// Natural numeric sort (Aug 2026, Atif's own explicit request) --
// a plain string sort on values like "INV-100" vs "INV-59" would put
// INV-100 first ('1' < '5' character-by-character), which is not what
// a CA reviewing these sequentially would expect. Extracts the
// trailing numeric run from each value (falling back to 0, and to a
// full string comparison as a tiebreaker for any non-numeric suffix)
// and sorts by that instead. Shared by both the sales and purchase
// sections below rather than duplicated.
function naturalSort(a, b, keyFn) {
  const av = keyFn(a) || '';
  const bv = keyFn(b) || '';
  const aNum = parseInt((av.match(/(\d+)(?!.*\d)/) || [])[1] || '0', 10);
  const bNum = parseInt((bv.match(/(\d+)(?!.*\d)/) || [])[1] || '0', 10);
  if (aNum !== bNum) return aNum - bNum;
  return av.localeCompare(bv);
}

export async function generateGstFilingReport({ orgId, userId, periodType, periodStart, periodEnd, supabase }) {
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, invoice_number, issue_date, customer_id, subtotal, custom_fields, status')
    .eq('organisation_id', orgId)
    .gte('issue_date', periodStart)
    .lte('issue_date', periodEnd)
    .neq('status', 'draft')
    .order('issue_date', { ascending: true });

  if (invErr) throw new Error(`Failed to fetch invoices: ${invErr.message}`);

  const filtered = (invoices || []).filter(inv => inv.custom_fields?.invoice_type !== 'Internal');

  const customerIds = [...new Set(filtered.map(i => i.customer_id))];
  const { data: customers } = await supabase
    .from('customers').select('id, name, tax_id')
    .in('id', customerIds.length > 0 ? customerIds : ['00000000-0000-0000-0000-000000000000']);
  const customerById = {};
  (customers || []).forEach(c => { customerById[c.id] = c; });

  const invoiceIds = filtered.map(i => i.id);
  const { data: items } = await supabase
    .from('invoice_items').select('invoice_id, quantity')
    .in('invoice_id', invoiceIds.length > 0 ? invoiceIds : ['00000000-0000-0000-0000-000000000000']);
  const qtyByInvoice = {};
  (items || []).forEach(it => {
    qtyByInvoice[it.invoice_id] = (qtyByInvoice[it.invoice_id] || 0) + (it.quantity || 0);
  });

  const headers = [
    'Invoice Date', 'Invoice Number', 'Customer Name', 'Customer GSTIN',
    'Taxable Value', 'Total Quantity', 'CGST Amount', 'SGST Amount',
    'IGST Amount', 'Total Invoice Value',
  ];

  filtered.sort((a, b) => naturalSort(a, b, x => x.invoice_number));

  const rows = filtered.map(inv => {
    const cust = customerById[inv.customer_id] || {};
    const cgst = inv.custom_fields?.cgst_amount || 0;
    const sgst = inv.custom_fields?.sgst_amount || 0;
    const igst = inv.custom_fields?.igst_amount || 0;
    const packing = inv.custom_fields?.packing_handling || 0;
    const freightTax = inv.custom_fields?.freight_tax || 0;
    const totalValue = Math.round((inv.subtotal + cgst + sgst + igst + packing + freightTax) * 100) / 100;
    return {
      'Invoice Date': inv.issue_date,
      'Invoice Number': inv.invoice_number,
      'Customer Name': cust.name || '',
      'Customer GSTIN': cust.tax_id || '',
      'Taxable Value': inv.subtotal,
      'Total Quantity': qtyByInvoice[inv.id] || 0,
      'CGST Amount': cgst,
      'SGST Amount': sgst,
      'IGST Amount': igst,
      'Total Invoice Value': totalValue,
    };
  });

  const csv = rowsToCSV(headers, rows);
  const fileName = `gst-filing_${periodStart}_to_${periodEnd}.csv`;
  const storagePath = `${orgId}/gst-filings/${fileName}`;

  const { error: uploadErr } = await supabase.storage
    .from('exports')
    .upload(storagePath, Buffer.from(csv, 'utf-8'), { contentType: 'text/csv', upsert: true });

  if (uploadErr) throw new Error(`Failed to upload report: ${uploadErr.message}`);

  // ── Purchase side (mirrors everything above exactly) ──────────
  const { data: bills, error: pbErr } = await supabase
    .from('purchase_bills')
    .select('id, bill_number, supplier_bill_number, issue_date, customer_id, subtotal, custom_fields, status')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .is('deleted_at', null)
    .gte('issue_date', periodStart)
    .lte('issue_date', periodEnd)
    .neq('status', 'draft')
    .order('issue_date', { ascending: true });

  if (pbErr) throw new Error(`Failed to fetch purchase bills: ${pbErr.message}`);

  const pbFiltered = bills || [];

  const supplierIds = [...new Set(pbFiltered.map(b => b.customer_id))];
  const { data: suppliers } = await supabase
    .from('customers').select('id, name, tax_id')
    .in('id', supplierIds.length > 0 ? supplierIds : ['00000000-0000-0000-0000-000000000000']);
  const supplierById = {};
  (suppliers || []).forEach(c => { supplierById[c.id] = c; });

  const billIds = pbFiltered.map(b => b.id);
  const { data: pbItems } = await supabase
    .from('purchase_bill_items').select('bill_id, quantity')
    .in('bill_id', billIds.length > 0 ? billIds : ['00000000-0000-0000-0000-000000000000']);
  const qtyByBill = {};
  (pbItems || []).forEach(it => {
    qtyByBill[it.bill_id] = (qtyByBill[it.bill_id] || 0) + (it.quantity || 0);
  });

  const purchaseHeaders = [
    'Bill Date', 'Purchase Bill Number', 'Supplier Bill Number', 'Supplier Name',
    'Supplier GSTIN', 'Taxable Value', 'Total Quantity', 'CGST Amount',
    'SGST Amount', 'IGST Amount', 'Total Bill Value',
  ];

  pbFiltered.sort((a, b) => naturalSort(a, b, x => x.bill_number));

  const purchaseRows = pbFiltered.map(bill => {
    const supplier = supplierById[bill.customer_id] || {};
    const cgst = bill.custom_fields?.cgst_amount || 0;
    const sgst = bill.custom_fields?.sgst_amount || 0;
    const igst = bill.custom_fields?.igst_amount || 0;
    const totalValue = Math.round((bill.subtotal + cgst + sgst + igst) * 100) / 100;
    return {
      'Bill Date': bill.issue_date,
      'Purchase Bill Number': bill.bill_number,
      'Supplier Bill Number': bill.supplier_bill_number || '',
      'Supplier Name': supplier.name || '',
      'Supplier GSTIN': supplier.tax_id || '',
      'Taxable Value': bill.subtotal,
      'Total Quantity': qtyByBill[bill.id] || 0,
      'CGST Amount': cgst,
      'SGST Amount': sgst,
      'IGST Amount': igst,
      'Total Bill Value': totalValue,
    };
  });

  const purchaseCsv = rowsToCSV(purchaseHeaders, purchaseRows);
  const purchaseFileName = `gst-filing-purchases_${periodStart}_to_${periodEnd}.csv`;
  const purchaseStoragePath = `${orgId}/gst-filings/${purchaseFileName}`;

  const { error: pbUploadErr } = await supabase.storage
    .from('exports')
    .upload(purchaseStoragePath, Buffer.from(purchaseCsv, 'utf-8'), { contentType: 'text/csv', upsert: true });

  if (pbUploadErr) throw new Error(`Failed to upload purchase report: ${pbUploadErr.message}`);

  const { data: auditRow, error: auditErr } = await supabase
    .from('gst_filing_exports')
    .insert({
      organisation_id: orgId,
      generated_by: userId,
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      invoice_count: filtered.length,
      storage_path: storagePath,
      purchase_bill_count: pbFiltered.length,
      purchase_storage_path: purchaseStoragePath,
    })
    .select('id')
    .single();

  if (auditErr) throw new Error(`Failed to log audit entry: ${auditErr.message}`);

  return {
    storagePath, invoiceCount: filtered.length,
    purchaseStoragePath, purchaseBillCount: pbFiltered.length,
    auditId: auditRow.id,
  };
}
