// Export My Data (Home Menu Audit). See
// ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit".
//
// Owner-facing business data export: a ZIP of CSV files (one per table --
// this is what "different tabs for different tables" means in pure-CSV
// terms, since a single CSV has no sheets/tabs; the natural CSV-only
// equivalent is one file per table, bundled together). Only owner-provided
// + financial-truth columns are exported -- explicitly excludes AI/analytics
// "moat" data (entity_memory, ai_context, ai_usage_log, product_vocabularies,
// entity_aliases, missing_capabilities, ai_conversations). Financial truth
// (outstanding_balance, amount_paid/amount_due, credit applied_amount) IS
// included -- this is the owner's own business record, not proprietary
// algorithm output.
//
// Chat/message history is deliberately NOT included here -- per-customer,
// on-demand "Export chat" is a SEPARATE feature (own scoped session).
//
// Packaging: adm-zip (already a backend dependency). Storage: same
// Supabase Storage pattern invoices/catalogs use, EXCEPT the 'exports'
// bucket must be PRIVATE (create it manually in the Supabase dashboard
// before deploying this) -- this bundle contains full bank account
// numbers, meaningfully more sensitive than a single invoice PDF. Only the
// storage PATH is persisted as metadata; an actual download link is a
// short-lived signed URL minted on demand (see index.js /api/export/download).

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

export async function generateOwnerDataExport({ orgId, supabase }) {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip();

  const [{ data: customers }, { data: products }, { data: suppliers }] = await Promise.all([
    supabase.from('customers').select('id, name, phone').eq('organisation_id', orgId).is('deleted_at', null),
    supabase.from('products').select('id, name, sku').eq('organisation_id', orgId).is('deleted_at', null),
    supabase.from('suppliers').select('id, name, phone').eq('organisation_id', orgId).is('deleted_at', null),
  ]);
  const custMap = new Map((customers || []).map(c => [c.id, c]));
  const prodMap = new Map((products || []).map(p => [p.id, p]));
  const suppMap = new Map((suppliers || []).map(s => [s.id, s]));
  const custName = id => custMap.get(id)?.name || '';
  const custPhone = id => custMap.get(id)?.phone || '';
  const prodName = id => prodMap.get(id)?.name || '';
  const prodSku = id => prodMap.get(id)?.sku || '';
  const suppName = id => suppMap.get(id)?.name || '';
  const suppPhone = id => suppMap.get(id)?.phone || '';

  const [{ data: invoices }, { data: quotations }, { data: bills }] = await Promise.all([
    supabase.from('invoices').select('id, invoice_number').eq('organisation_id', orgId).is('deleted_at', null),
    supabase.from('quotations').select('id, quote_number').eq('organisation_id', orgId).is('deleted_at', null),
    supabase.from('purchase_bills').select('id, bill_number').eq('organisation_id', orgId).is('deleted_at', null),
  ]);
  const invNumMap = new Map((invoices || []).map(i => [i.id, i.invoice_number]));
  const quoteNumMap = new Map((quotations || []).map(q => [q.id, q.quote_number]));
  const billNumMap = new Map((bills || []).map(b => [b.id, b.bill_number]));

  const addCsv = (filename, headers, rows) => {
    zip.addFile(filename, Buffer.from(rowsToCSV(headers, rows), 'utf-8'));
  };

  const { data: custRows } = await supabase
    .from('customers').select('name, email, phone, company, tax_id, credit_limit, outstanding_balance, payment_terms_days, notes, created_at')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('customers.csv', ['name', 'email', 'phone', 'company', 'tax_id', 'credit_limit', 'outstanding_balance', 'payment_terms_days', 'notes', 'created_at'], custRows || []);

  const { data: addrRows } = await supabase
    .from('customer_addresses').select('customer_id, type, line1, line2, city, state, postal_code, country')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('customer_addresses.csv', ['customer_name', 'customer_phone', 'type', 'line1', 'line2', 'city', 'state', 'postal_code', 'country'],
    (addrRows || []).map(r => ({ ...r, customer_name: custName(r.customer_id), customer_phone: custPhone(r.customer_id) })));

  const { data: prodRows } = await supabase
    .from('products').select('sku, name, description, category, unit, cost_price, selling_price, tax_rate, created_at')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('products.csv', ['sku', 'name', 'description', 'category', 'unit', 'cost_price', 'selling_price', 'tax_rate', 'created_at'], prodRows || []);

  const { data: suppRows } = await supabase
    .from('suppliers').select('name, email, phone, company, tax_id, payment_terms, address, city, country, notes, created_at')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('suppliers.csv', ['name', 'email', 'phone', 'company', 'tax_id', 'payment_terms', 'address', 'city', 'country', 'notes', 'created_at'], suppRows || []);

  const { data: quoteRows } = await supabase
    .from('quotations').select('quote_number, customer_id, issue_date, expiry_date, status, subtotal, discount_amount, tax_amount, total_amount, notes, terms')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('quotations.csv', ['quote_number', 'customer_name', 'customer_phone', 'issue_date', 'expiry_date', 'status', 'subtotal', 'discount_amount', 'tax_amount', 'total_amount', 'notes', 'terms'],
    (quoteRows || []).map(r => ({ ...r, customer_name: custName(r.customer_id), customer_phone: custPhone(r.customer_id) })));
  const { data: quoteItemRows } = await supabase
    .from('quotation_items').select('quotation_id, product_id, description, quantity, unit_price, discount_pct, tax_rate, line_total')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('quotation_items.csv', ['quote_number', 'product_name', 'product_sku', 'description', 'quantity', 'unit_price', 'discount_pct', 'tax_rate', 'line_total'],
    (quoteItemRows || []).map(r => ({ ...r, quote_number: quoteNumMap.get(r.quotation_id) || '', product_name: prodName(r.product_id), product_sku: prodSku(r.product_id) })));

  const { data: invRows } = await supabase
    .from('invoices').select('invoice_number, customer_id, issue_date, due_date, status, subtotal, discount_amount, tax_amount, total_amount, amount_paid, amount_due, notes, terms')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('invoices.csv', ['invoice_number', 'customer_name', 'customer_phone', 'issue_date', 'due_date', 'status', 'subtotal', 'discount_amount', 'tax_amount', 'total_amount', 'amount_paid', 'amount_due', 'notes', 'terms'],
    (invRows || []).map(r => ({ ...r, customer_name: custName(r.customer_id), customer_phone: custPhone(r.customer_id) })));
  const { data: invItemRows } = await supabase
    .from('invoice_items').select('invoice_id, product_id, description, quantity, unit_price, discount_pct, tax_rate, line_total')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('invoice_items.csv', ['invoice_number', 'product_name', 'product_sku', 'description', 'quantity', 'unit_price', 'discount_pct', 'tax_rate', 'line_total'],
    (invItemRows || []).map(r => ({ ...r, invoice_number: invNumMap.get(r.invoice_id) || '', product_name: prodName(r.product_id), product_sku: prodSku(r.product_id) })));

  const { data: payRows } = await supabase
    .from('payments').select('customer_id, invoice_id, amount, payment_date, payment_method, reference, notes')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('payments.csv', ['customer_name', 'customer_phone', 'invoice_number', 'amount', 'payment_date', 'payment_method', 'reference', 'notes'],
    (payRows || []).map(r => ({ ...r, customer_name: custName(r.customer_id), customer_phone: custPhone(r.customer_id), invoice_number: invNumMap.get(r.invoice_id) || '' })));

  const { data: billRows } = await supabase
    .from('purchase_bills').select('bill_number, supplier_id, issue_date, due_date, status, subtotal, discount_amount, tax_amount, total_amount, amount_paid, amount_due, notes')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('purchase_bills.csv', ['bill_number', 'supplier_name', 'supplier_phone', 'issue_date', 'due_date', 'status', 'subtotal', 'discount_amount', 'tax_amount', 'total_amount', 'amount_paid', 'amount_due', 'notes'],
    (billRows || []).map(r => ({ ...r, supplier_name: suppName(r.supplier_id), supplier_phone: suppPhone(r.supplier_id) })));
  const { data: billItemRows } = await supabase
    .from('purchase_bill_items').select('bill_id, product_id, description, quantity, unit_price, discount_pct, tax_rate, line_total')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('purchase_bill_items.csv', ['bill_number', 'product_name', 'product_sku', 'description', 'quantity', 'unit_price', 'discount_pct', 'tax_rate', 'line_total'],
    (billItemRows || []).map(r => ({ ...r, bill_number: billNumMap.get(r.bill_id) || '', product_name: prodName(r.product_id), product_sku: prodSku(r.product_id) })));

  const { data: suppPayRows } = await supabase
    .from('supplier_payments').select('supplier_id, bill_id, amount, payment_date, payment_method, reference, notes')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('supplier_payments.csv', ['supplier_name', 'supplier_phone', 'bill_number', 'amount', 'payment_date', 'payment_method', 'reference', 'notes'],
    (suppPayRows || []).map(r => ({ ...r, supplier_name: suppName(r.supplier_id), supplier_phone: suppPhone(r.supplier_id), bill_number: billNumMap.get(r.bill_id) || '' })));

  const { data: creditRows } = await supabase
    .from('credit_notes').select('customer_id, invoice_id, credit_number, issue_date, status, total_amount, applied_amount, notes')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('credit_notes.csv', ['customer_name', 'customer_phone', 'invoice_number', 'credit_number', 'issue_date', 'status', 'total_amount', 'applied_amount', 'notes'],
    (creditRows || []).map(r => ({ ...r, customer_name: custName(r.customer_id), customer_phone: custPhone(r.customer_id), invoice_number: invNumMap.get(r.invoice_id) || '' })));

  const { data: returnRows } = await supabase
    .from('purchase_returns').select('supplier_id, bill_id, return_number, issue_date, status, total_amount, notes')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('purchase_returns.csv', ['supplier_name', 'supplier_phone', 'bill_number', 'return_number', 'issue_date', 'status', 'total_amount', 'notes'],
    (returnRows || []).map(r => ({ ...r, supplier_name: suppName(r.supplier_id), supplier_phone: suppPhone(r.supplier_id), bill_number: billNumMap.get(r.bill_id) || '' })));

  const { data: expRows } = await supabase
    .from('expenses').select('category, description, amount, expense_date, payment_method')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('expenses.csv', ['category', 'description', 'amount', 'expense_date', 'payment_method'], expRows || []);

  const { data: taskRows } = await supabase
    .from('tasks').select('title, description, due_date, priority, status')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('tasks.csv', ['title', 'description', 'due_date', 'priority', 'status'], taskRows || []);

  const { data: bankRows } = await supabase
    .from('bank_accounts').select('name, bank_name, account_number, ifsc_code, account_holder_name, current_balance')
    .eq('organisation_id', orgId).is('deleted_at', null);
  addCsv('bank_accounts.csv', ['name', 'bank_name', 'account_number', 'ifsc_code', 'account_holder_name', 'current_balance'], bankRows || []);

  const zipBuffer = zip.toBuffer();
  const storagePath = `${orgId}/data-export.zip`;
  const { error: uploadErr } = await supabase.storage
    .from('exports')
    .upload(storagePath, zipBuffer, { contentType: 'application/zip', upsert: true });
  if (uploadErr) {
    console.error('[generateOwnerDataExport] upload failed:', uploadErr.message);
    return { success: false, error: uploadErr.message };
  }
  const generatedAt = new Date().toISOString();

  const { data: orgRow } = await supabase.from('organisations').select('settings').eq('id', orgId).maybeSingle();
  const newSettings = { ...(orgRow?.settings || {}), last_export_path: storagePath, last_export_generated_at: generatedAt };
  await supabase.from('organisations').update({ settings: newSettings }).eq('id', orgId);

  return { success: true, path: storagePath, generatedAt };
}
