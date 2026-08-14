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

import { csvEscape, rowsToCSV } from '../export/generateOwnerDataExport.js';

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
    })
    .select('id')
    .single();

  if (auditErr) throw new Error(`Failed to log audit entry: ${auditErr.message}`);

  return { storagePath, invoiceCount: filtered.length, auditId: auditRow.id };
}
