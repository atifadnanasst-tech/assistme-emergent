/**
 * AssistMe — Business Query Engine Primitives
 *
 * Location: backend/src/services/ai/queryEngine/primitives.js
 * Created: BQE-1, Jun 2026
 *
 * READ-ONLY data retrieval functions. Never mutate state.
 * All primitives accept a scope object for reuse across Org AI, Customer AI tab,
 * and future entity-scoped AI surfaces.
 *
 * Scope contract (mandatory for all primitives):
 *   scope: { type: 'org' | 'customer' | 'supplier' | 'product', entityId?: string }
 *
 * Rule: Primitives never call other primitives.
 *       Route handlers / queryRouter orchestrate combinations.
 *
 * Schema notes (verified Jun 2026):
 *   - customers: has status ('active'/'inactive'), NO is_active column
 *   - suppliers: has status ('active'), NO is_active column
 *   - invoices: status includes 'overdue' (persisted), also has due_date + amount_due for fallback
 *   - inventory: quantity + reorder_point; filter reorder_point > 0 to exclude untracked products
 *   - outstanding_payable on suppliers: added via migration, verified in schema_sql_v3.txt line 1847
 *
 * Modifies existing production surface: NO — new file only
 */

// ── P7: getOrgSummary ────────────────────────────────────────────────────────
// Compact business snapshot for business-aware LLM calls.
// Inject into: business queries, business advice, recommendations, analysis.
// Do NOT inject into: weather, definitions, translations, open-world questions.
//
// Returns machine-friendly object. Caller owns formatting.
export async function getOrgSummary({ orgId, scope = { type: 'org' }, supabase }) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  try {
    // 1. Active customers — count + total outstanding + count with outstanding + top 3
    const { data: customers } = await supabase
      .from('customers')
      .select('name, outstanding_balance')
      .eq('organisation_id', orgId)
      .eq('status', 'active');

    const activeCustomers = customers?.length || 0;
    const totalReceivables = customers?.reduce((s, c) => s + parseFloat(c.outstanding_balance || 0), 0) || 0;
    const customerCountWithOutstanding = (customers || []).filter(c => parseFloat(c.outstanding_balance) > 0).length;
    const topCustomers = (customers || [])
      .filter(c => parseFloat(c.outstanding_balance) > 0)
      .sort((a, b) => parseFloat(b.outstanding_balance) - parseFloat(a.outstanding_balance))
      .slice(0, 3)
      .map(c => ({ name: c.name, outstanding: Math.round(parseFloat(c.outstanding_balance) * 100) / 100 }));

    // 2. Total payables — from purchase_bills.amount_due (is_historical=false, exclude cancelled/paid)
    // NOTE: suppliers table is schema-only, never written to programmatically.
    // All supplier entities live in customers table. Payables live in purchase_bills.
    const { data: openBills } = await supabase
      .from('purchase_bills')
      .select('amount_due')
      .eq('organisation_id', orgId)
      .eq('is_historical', false)
      .not('status', 'in', '("paid","cancelled")');

    const totalPayables = openBills?.reduce((s, b) => s + parseFloat(b.amount_due || 0), 0) || 0;

    // 3. Invoices billed this month (is_historical=false, exclude cancelled)
    const { data: invoicesThisMonth } = await supabase
      .from('invoices')
      .select('total_amount')
      .eq('organisation_id', orgId)
      .eq('is_historical', false)
      .gte('issue_date', monthStart)
      .lte('issue_date', today)
      .neq('status', 'cancelled');

    const billedThisMonth = invoicesThisMonth?.reduce((s, inv) => s + parseFloat(inv.total_amount || 0), 0) || 0;

    // 4. Overdue invoices — use amount_due > 0 + due_date < today as primary signal
    //    (catches invoices with stale status AND those correctly marked 'overdue')
    const { data: allUnpaidInvoices } = await supabase
      .from('invoices')
      .select('total_amount, amount_due, due_date, status')
      .eq('organisation_id', orgId)
      .eq('is_historical', false)
      .not('status', 'in', '("paid","cancelled","draft")');

    // Filter in JS: overdue = past due_date with outstanding amount
    // Supabase does not support column-to-column comparisons
    const overdueInvoices = (allUnpaidInvoices || []).filter(inv =>
      inv.due_date && inv.due_date < today && parseFloat(inv.amount_due || 0) > 0
    );
    const overdueInvoiceCount = overdueInvoices.length;
    const overdueInvoiceAmount = overdueInvoices.reduce((s, inv) => s + parseFloat(inv.amount_due || 0), 0);

    // 5. Payments collected this month (is_historical=false)
    const { data: paymentsThisMonth } = await supabase
      .from('payments')
      .select('amount')
      .eq('organisation_id', orgId)
      .eq('is_historical', false)
      .gte('payment_date', monthStart)
      .lte('payment_date', today);

    const collectedThisMonth = paymentsThisMonth?.reduce((s, p) => s + parseFloat(p.amount || 0), 0) || 0;

    // 6. Low stock — inventory rows where quantity < reorder_point AND reorder_point > 0
    //    reorder_point > 0 filter implicitly excludes products not using reorder tracking
    //    Supabase does not support column-to-column comparisons — filter in JS
    const { data: inventoryRows } = await supabase
      .from('inventory')
      .select('quantity, reorder_point')
      .eq('organisation_id', orgId);

    const lowStockCount = (inventoryRows || []).filter(row =>
      parseFloat(row.reorder_point) > 0 &&
      parseFloat(row.quantity) < parseFloat(row.reorder_point)
    ).length;

    // 7. Pending + in-progress tasks
    const { data: tasks } = await supabase
      .from('tasks')
      .select('id')
      .eq('organisation_id', orgId)
      .in('status', ['pending', 'in_progress']);

    const pendingTaskCount = tasks?.length || 0;

    return {
      activeCustomers,
      customerCountWithOutstanding,
      totalReceivables: Math.round(totalReceivables * 100) / 100,
      totalPayables: Math.round(totalPayables * 100) / 100,
      billedThisMonth: Math.round(billedThisMonth * 100) / 100,
      collectedThisMonth: Math.round(collectedThisMonth * 100) / 100,
      overdueInvoiceCount,
      overdueInvoiceAmount: Math.round(overdueInvoiceAmount * 100) / 100,
      lowStockCount,
      pendingTaskCount,
      topCustomers,
      asOf: today,
      generatedAt: now.toISOString(),
    };
  } catch (err) {
    console.error('[getOrgSummary] error:', err.message);
    return null;
  }
}

// ── P8: searchEntityByName ───────────────────────────────────────────────────
// Unified entity name resolver. Routes to proven selectors — no new logic.
//
// Customers and suppliers both live in the customers table.
// Products live in the products table.
//
// For customers/suppliers: delegates to resolveCustomerSelector
//   (UUID → entity_aliases → ILIKE exact → ILIKE partial → trigram RPC, threshold 0.06)
// For products: delegates to resolveProductSelector
//   (UUID/category/name → ILIKE → trigram RPC, threshold 0.10)
//
// Returns:
//   { entity, candidates, entityType, error }
//   entity = single resolved record (null if ambiguous or not found)
//   candidates = array when multiple matches found (for clarification)
//
// Scope: always org-level for name search. Entity scoping happens in callers.
export async function searchEntityByName({ orgId, entityType, name, supabase }) {
  if (!orgId || !name || !entityType) {
    return { entity: null, candidates: [], entityType, error: 'orgId, name, entityType required' };
  }

  if (entityType === 'customer' || entityType === 'supplier') {
    // Both customer and supplier entities live in customers table
    const { resolveCustomerSelector } = await import(
      '../../capabilities/customerSelector.js'
    );
    const { customer, candidates, error } = await resolveCustomerSelector({
      selector: { name },
      orgId,
      supabase,
    });
    return { entity: customer, candidates: candidates || [], entityType, error };
  }

  if (entityType === 'product') {
    const { resolveProductSelector } = await import(
      '../../capabilities/productSelector.js'
    );
    const { products, error } = await resolveProductSelector({
      selector: { name },
      orgId,
      supabase,
    });
    // Single match → entity. Multiple → candidates. Zero → null.
    if (products?.length === 1) return { entity: products[0], candidates: [], entityType, error };
    if (products?.length > 1) return { entity: null, candidates: products, entityType, error };
    return { entity: null, candidates: [], entityType, error };
  }

  return { entity: null, candidates: [], entityType, error: `unsupported entityType: ${entityType}` };
}

// ── P1: getEntityProfile ─────────────────────────────────────────────────────
// Full profile of a single customer/supplier entity.
// Sources: customers + entity_memory + customer_addresses + purchase_bills
// Scope: requires { type: 'customer' | 'supplier', entityId: string }
//
// Returns facts only. Business analysis (risk, health, score) belongs in P5.
// Status filter intentionally omitted — profile should return even inactive entities.
//
// IMPORTANT: scope.type='supplier' still resolves through customers table.
// Supplier entities are represented by customer records in AssistMe.
// Do not query suppliers table for identity resolution.
// entity_memory: all entities stored as entity_type='customer' (verified Jun 2026).
export async function getEntityProfile({ orgId, scope, supabase }) {
  if (!orgId || !scope?.entityId) {
    return { profile: null, error: 'orgId and scope.entityId required' };
  }

  try {
    // 1. Core customer record (no status filter — return even inactive entities)
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, name, email, phone, company, outstanding_balance, credit_limit, payment_terms_days, status, currency, custom_fields, created_at')
      .eq('organisation_id', orgId)
      .eq('id', scope.entityId)
      .is('deleted_at', null)
      .maybeSingle();

    if (custErr || !customer) {
      return { profile: null, error: custErr?.message || 'entity not found' };
    }

    // 2. Entity memory — all behavioral signals
    // All entities stored as entity_type='customer' in entity_memory (verified Jun 2026).
    // Supplier scope maps to 'customer' — same DB record, same memory keys.
    const memoryEntityType = scope.type === 'supplier' ? 'customer' : (scope.type || 'customer');
    const { data: memoryRows } = await supabase
      .from('entity_memory')
      .select('memory_key, memory_value, confidence, updated_at')
      .eq('organisation_id', orgId)
      .eq('entity_type', memoryEntityType)
      .eq('entity_id', scope.entityId)
      .is('deleted_at', null);

    const memory = {};
    (memoryRows || []).forEach(row => {
      memory[row.memory_key] = {
        value: row.memory_value,
        confidence: row.confidence,
        updatedAt: row.updated_at,
      };
    });

    // 3. Primary address (city/state for geographic queries like "who in Pune")
    const { data: addresses } = await supabase
      .from('customer_addresses')
      .select('city, state, country, type, is_default')
      .eq('organisation_id', orgId)
      .eq('customer_id', scope.entityId)
      .is('deleted_at', null)
      .order('is_default', { ascending: false });

    const primaryAddress = addresses?.[0] || null;

    // 4. Payable position — purchase_bills.customer_id is canonical (supplier_id is legacy)
    const { data: openBills } = await supabase
      .from('purchase_bills')
      .select('amount_due')
      .eq('organisation_id', orgId)
      .eq('customer_id', scope.entityId)
      .eq('is_historical', false)
      .not('status', 'in', '("paid","cancelled")');

    const totalPayable = (openBills || []).reduce((s, b) => s + parseFloat(b.amount_due || 0), 0);

    return {
      profile: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        company: customer.company,
        status: customer.status,
        city: primaryAddress?.city || null,
        state: primaryAddress?.state || null,
        outstandingReceivable: parseFloat(customer.outstanding_balance || 0),
        totalPayable: Math.round(totalPayable * 100) / 100,
        creditLimit: parseFloat(customer.credit_limit || 0),
        paymentTermsDays: customer.payment_terms_days,
        currency: customer.currency,
        customerSince: customer.created_at?.slice(0, 10),
        memory,
        entityType: scope.type,
      },
      error: null,
    };
  } catch (err) {
    console.error('[getEntityProfile] error:', err.message);
    return { profile: null, error: err.message };
  }
}

// ── P2: getEntityTransactions ─────────────────────────────────────────────────
// Transaction history for one entity or across org.
// Sources: invoices + payments received + purchase_bills + supplier_payments
// Scope: 'org' (all entities) or 'customer'/'supplier' (one entity via entityId)
// Filters: { dateFrom, dateTo, type, limit, includeHistorical }
//
// Financial mode (default): is_historical=false — operational truth only
// Intelligence mode: includeHistorical=true — for pattern/trend analysis
// Flat chronological timeline deferred to P9 getEntityTimeline.
//
// IMPORTANT: All entity references use customer_id (canonical per Session F entity model).
// supplier_id on purchase_bills and supplier_payments is legacy — never write new code against it.
export async function getEntityTransactions({ orgId, scope, filters = {}, supabase }) {
  if (!orgId) return { transactions: {}, error: 'orgId required' };

  const { dateFrom, dateTo, type = 'all', limit = 20, includeHistorical = false } = filters;

  try {
    const results = {};

    // 1. Invoices (receivables)
    if (type === 'all' || type === 'invoices') {
      let q = supabase
        .from('invoices')
        .select('id, invoice_number, status, issue_date, due_date, total_amount, amount_paid, amount_due, customer_id')
        .eq('organisation_id', orgId)
        .is('deleted_at', null)
        .order('issue_date', { ascending: false })
        .limit(limit);

      if (!includeHistorical) q = q.eq('is_historical', false);
      if (scope?.entityId) q = q.eq('customer_id', scope.entityId);
      if (dateFrom) q = q.gte('issue_date', dateFrom);
      if (dateTo) q = q.lte('issue_date', dateTo);

      const { data, error } = await q;
      if (error) console.error('[getEntityTransactions] invoices:', error.message);
      results.invoices = data || [];
    }

    // 2. Payments received from customers
    if (type === 'all' || type === 'payments') {
      let q = supabase
        .from('payments')
        .select('id, amount, payment_date, payment_method, reference, customer_id')
        .eq('organisation_id', orgId)
        .is('deleted_at', null)
        .order('payment_date', { ascending: false })
        .limit(limit);

      if (!includeHistorical) q = q.eq('is_historical', false);
      if (scope?.entityId) q = q.eq('customer_id', scope.entityId);
      if (dateFrom) q = q.gte('payment_date', dateFrom);
      if (dateTo) q = q.lte('payment_date', dateTo);

      const { data, error } = await q;
      if (error) console.error('[getEntityTransactions] payments:', error.message);
      results.payments = data || [];
    }

    // 3. Purchase bills (payables to suppliers)
    if (type === 'all' || type === 'bills') {
      let q = supabase
        .from('purchase_bills')
        .select('id, bill_number, status, issue_date, due_date, total_amount, amount_paid, amount_due, customer_id')
        .eq('organisation_id', orgId)
        .is('deleted_at', null)
        .order('issue_date', { ascending: false })
        .limit(limit);

      if (!includeHistorical) q = q.eq('is_historical', false);
      if (scope?.entityId) q = q.eq('customer_id', scope.entityId);
      if (dateFrom) q = q.gte('issue_date', dateFrom);
      if (dateTo) q = q.lte('issue_date', dateTo);

      const { data, error } = await q;
      if (error) console.error('[getEntityTransactions] bills:', error.message);
      results.bills = data || [];
    }

    // 4. Supplier payments made (payments out)
    // customer_id is canonical per entity model (Session F) — supplier_id is legacy
    if (type === 'all' || type === 'supplier_payments') {
      let q = supabase
        .from('supplier_payments')
        .select('id, amount, payment_date, payment_method, reference, customer_id, bill_id')
        .eq('organisation_id', orgId)
        .is('deleted_at', null)
        .order('payment_date', { ascending: false })
        .limit(limit);

      if (scope?.entityId) q = q.eq('customer_id', scope.entityId);
      if (dateFrom) q = q.gte('payment_date', dateFrom);
      if (dateTo) q = q.lte('payment_date', dateTo);

      const { data, error } = await q;
      if (error) console.error('[getEntityTransactions] supplier_payments:', error.message);
      results.supplierPayments = data || [];
    }

    return { transactions: results, error: null };
  } catch (err) {
    console.error('[getEntityTransactions] error:', err.message);
    return { transactions: {}, error: err.message };
  }
}
