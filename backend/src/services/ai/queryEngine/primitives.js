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

    // 2. Suppliers — total payable (outstanding_payable added via migration)
    const { data: suppliers } = await supabase
      .from('suppliers')
      .select('outstanding_payable')
      .eq('organisation_id', orgId)
      .eq('status', 'active');

    const totalPayables = suppliers?.reduce((s, sup) => s + parseFloat(sup.outstanding_payable || 0), 0) || 0;

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
