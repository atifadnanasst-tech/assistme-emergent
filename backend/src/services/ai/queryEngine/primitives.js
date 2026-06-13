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


// ── P5: getRelationshipSignals + classifyRelationship ─────────────────────────
// BQE-5, Jun 2026
//
// getRelationshipSignals — pure data primitive, no classification, no narration.
// classifyRelationship   — pure function, no DB. Accepts signals + optional thresholds.
//
// Data sources (all verified against schema_sql_v3):
//   invoices          → daysSinceLastInvoice (all-time), totalRevenueL90d (windowed)
//   payments          → daysSinceLastPayment (payments.is_historical confirmed)
//   messages          → daysSinceLastInteraction via conversations.entity_id
//   action_log        → inCooldown (signal_type, actioned_at, entity_id confirmed)
//   customer_addresses → city/state for geographic queries ("Pune meetings")
//
// WHY messages, not ai_conversations:
//   ai_conversations.last_message_at only updates when owner opens the AI tab.
//   It does NOT update for owner<->customer WhatsApp messages.
//   messages table via conversations.entity_id is the canonical interaction source.
//
// Modifies existing production surface: NO — additive only

export const DEFAULT_RELATIONSHIP_THRESHOLDS = {
  activeDays: 30,
  atRiskDays: 60,
  goneSilentDays: 90,
  // Future: load from ai_context or organisation.settings per org
  // (daily supplier: activeDays=7; seasonal contractor: activeDays=180)
};

export async function getRelationshipSignals({ orgId, scope, supabase }) {
  if (!orgId || !scope) return { signals: null, error: 'orgId and scope required' };

  const today = new Date();
  const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400000).toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86400000).toISOString();

  try {
    let customerIds = [];
    let customerMap = {};

    if (scope.type === 'customer' && scope.entityId) {
      customerIds = [scope.entityId];
      const { data: c } = await supabase.from('customers')
        .select('id, name, phone').eq('id', scope.entityId).eq('organisation_id', orgId).maybeSingle();
      if (c) customerMap[c.id] = c;
    } else if (scope.type === 'org') {
      const { data: customers } = await supabase.from('customers')
        .select('id, name, phone').eq('organisation_id', orgId).eq('status', 'active').is('deleted_at', null);
      for (const c of customers || []) { customerIds.push(c.id); customerMap[c.id] = c; }
    } else {
      return { signals: null, error: `unsupported scope type: ${scope.type}` };
    }

    if (customerIds.length === 0) return { signals: [], error: null };

    // ── Query A: All-time invoices (no date window) ───────────────────────────
    // Used for: daysSinceLastInvoice, lastOrderAmount, hasEverInvoiced, totalRevenueL90d
    // Supabase does not support GROUP BY MAX — fetch all and reduce in JS.
    // P5 PERFORMANCE NOTE:
    // Org-scope currently loads all historical invoices and reduces in JS.
    // Future optimization: move latest-invoice and L90d revenue aggregation
    // into SQL/RPC to avoid loading full invoice history for large orgs.
    const { data: allTimeInvs } = await supabase.from('invoices')
      .select('customer_id, total_amount, issue_date')
      .eq('organisation_id', orgId).eq('is_historical', false)
      .not('status', 'in', '("draft","cancelled")')
      .gt('total_amount', 0).is('deleted_at', null)
      .in('customer_id', customerIds)
      .order('issue_date', { ascending: false });

    // Single pass: build latestInvoiceMap (all-time) and revenueMap (L90d window)
    const latestInvoiceMap = {};
    const revenueMap = {};
    for (const inv of allTimeInvs || []) {
      if (!latestInvoiceMap[inv.customer_id]) {
        latestInvoiceMap[inv.customer_id] = {
          lastInvoiceDate: inv.issue_date,
          lastOrderAmount: Number(inv.total_amount || 0),
          hasEverInvoiced: true,
        };
      }
      if (inv.issue_date >= ninetyDaysAgo) {
        if (!revenueMap[inv.customer_id]) revenueMap[inv.customer_id] = { totalL90d: 0, isActiveL30d: false };
        revenueMap[inv.customer_id].totalL90d += Number(inv.total_amount || 0);
        if (inv.issue_date >= thirtyDaysAgo) revenueMap[inv.customer_id].isActiveL30d = true;
      }
    }

    // ── Payment signals ───────────────────────────────────────────────────────
    const { data: recentPayments } = await supabase.from('payments')
      .select('customer_id, payment_date')
      .eq('organisation_id', orgId).eq('is_historical', false)
      .in('customer_id', customerIds).order('payment_date', { ascending: false });
    const paymentMap = {};
    for (const p of recentPayments || []) {
      if (!paymentMap[p.customer_id]) paymentMap[p.customer_id] = p.payment_date;
    }

    // ── Interaction signals (messages via conversations.entity_id) ────────────
    // P5 OPTIMIZATION NOTE (future): replace with SQL MAX(created_at) GROUP BY
    // conversation_id via supabase.rpc() for large orgs (10k+ customers).
    const { data: convRows } = await supabase.from('conversations')
      .select('entity_id, id').eq('organisation_id', orgId).eq('entity_type', 'customer')
      .in('entity_id', customerIds);
    const convIdToCustomer = {};
    for (const c of convRows || []) convIdToCustomer[c.id] = c.entity_id;
    const convIds = Object.keys(convIdToCustomer);

    const interactionMap = {};
    if (convIds.length > 0) {
      const { data: lastMsgs } = await supabase.from('messages')
        .select('conversation_id, created_at').in('conversation_id', convIds)
        .order('created_at', { ascending: false });
      const seenConv = new Set();
      for (const m of lastMsgs || []) {
        if (seenConv.has(m.conversation_id)) continue;
        seenConv.add(m.conversation_id);
        const customerId = convIdToCustomer[m.conversation_id];
        if (!customerId) continue;
        if (!interactionMap[customerId] || m.created_at > interactionMap[customerId])
          interactionMap[customerId] = m.created_at;
      }
    }

    // ── Cooldown (action_log) ─────────────────────────────────────────────────
    const { data: recentActions } = await supabase.from('action_log')
      .select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer')
      .eq('signal_type', 'gone_silent_reactivation').gte('actioned_at', sevenDaysAgo)
      .in('entity_id', customerIds);
    const cooldownSet = new Set((recentActions || []).map(a => a.entity_id));

    // ── City (customer_addresses) ─────────────────────────────────────────────
    const { data: addresses } = await supabase.from('customer_addresses')
      .select('customer_id, city, state').eq('organisation_id', orgId).eq('is_default', true)
      .in('customer_id', customerIds);
    const cityMap = {};
    for (const a of addresses || []) cityMap[a.customer_id] = { city: a.city, state: a.state };

    // ── Assemble signals ──────────────────────────────────────────────────────
    const daysDiff = (dateStr) => dateStr ? Math.floor((today - new Date(dateStr)) / 86400000) : null;

    const signals = customerIds.map(customerId => {
      const latest = latestInvoiceMap[customerId] || null;
      const revenue = revenueMap[customerId] || null;
      const lastPaymentDate = paymentMap[customerId] || null;
      const lastInteractionDate = interactionMap[customerId] || null;
      const loc = cityMap[customerId] || null;
      const customer = customerMap[customerId] || {};

      const candidates = [
        { type: 'message', date: lastInteractionDate },
        { type: 'payment', date: lastPaymentDate },
        { type: 'invoice', date: latest?.lastInvoiceDate || null },
      ].filter(c => c.date).sort((a, b) => new Date(b.date) - new Date(a.date));

      return {
        entityId: customerId,
        entityName: customer.name || null,
        phone: customer.phone || null,
        city: loc?.city || null,
        state: loc?.state || null,
        daysSinceLastInvoice: daysDiff(latest?.lastInvoiceDate),
        daysSinceLastPayment: daysDiff(lastPaymentDate),
        daysSinceLastInteraction: daysDiff(lastInteractionDate),
        lastOrderAmount: latest?.lastOrderAmount || 0,
        totalRevenueL90d: revenue?.totalL90d || 0,
        isActiveL30d: revenue?.isActiveL30d || false,
        hasEverInvoiced: latest?.hasEverInvoiced || false,
        inCooldown: cooldownSet.has(customerId),
        lastInteractionType: candidates[0]?.type || null,
        lastInteractionDate: candidates[0]?.date || null,
      };
    });

    return { signals, error: null };

  } catch (err) {
    console.error('[getRelationshipSignals] error:', err.message);
    return { signals: null, error: err.message };
  }
}

// ── classifyRelationship ──────────────────────────────────────────────────────
// Pure function — no DB.
// Classification source: most recent relationship signal wins across message, payment, invoice.
// We do not hard-prioritize channels — recency is the deciding factor.
// 'new' = hasEverInvoiced is false (never purchased — NOT "purchased long ago").
// Thresholds configurable — pass overrides for per-org customization.
//
// Returns:
//   { relationshipStatus, relationshipReason, lastInteractionType, lastInteractionDate, lastActivityDays }
//   relationshipStatus: 'new' | 'active' | 'at_risk' | 'gone_silent' | 'inactive'

export function classifyRelationship(signals, thresholds = {}) {
  const { activeDays, atRiskDays, goneSilentDays } = {
    ...DEFAULT_RELATIONSHIP_THRESHOLDS,
    ...thresholds,
  };

  const {
    daysSinceLastInvoice, daysSinceLastPayment, daysSinceLastInteraction,
    lastInteractionType, lastInteractionDate, hasEverInvoiced,
  } = signals;

  // 'new' = never purchased (not "purchased long ago")
  if (!hasEverInvoiced) {
    return {
      relationshipStatus: 'new',
      relationshipReason: 'No purchase history on record',
      lastInteractionType,
      lastInteractionDate,
      lastActivityDays: null,
    };
  }

  // Most recent signal across all channels wins
  const bestDays = Math.min(
    daysSinceLastInteraction ?? Infinity,
    daysSinceLastPayment ?? Infinity,
    daysSinceLastInvoice ?? Infinity,
  );

  if (bestDays === Infinity) {
    return {
      relationshipStatus: 'inactive',
      relationshipReason: 'No recent activity found',
      lastInteractionType,
      lastInteractionDate,
      lastActivityDays: null,
    };
  }

  if (bestDays <= activeDays) {
    const label = lastInteractionType === 'message' ? 'Customer messaged'
      : lastInteractionType === 'payment' ? 'Payment received' : 'Invoice issued';
    return {
      relationshipStatus: 'active',
      relationshipReason: `${label} ${bestDays} day${bestDays === 1 ? '' : 's'} ago`,
      lastInteractionType,
      lastInteractionDate,
      lastActivityDays: bestDays,
    };
  }

  if (bestDays <= atRiskDays) {
    return {
      relationshipStatus: 'at_risk',
      relationshipReason: `No significant activity in ${bestDays} days`,
      lastInteractionType,
      lastInteractionDate,
      lastActivityDays: bestDays,
    };
  }

  if (bestDays <= goneSilentDays) {
    return {
      relationshipStatus: 'gone_silent',
      relationshipReason: `Relationship cooling — inactive for ${bestDays} days`,
      lastInteractionType,
      lastInteractionDate,
      lastActivityDays: bestDays,
    };
  }

  return {
    relationshipStatus: 'inactive',
    relationshipReason: `No activity for over ${goneSilentDays} days`,
    lastInteractionType,
    lastInteractionDate,
    lastActivityDays: bestDays,
  };
}


// ── P3: getFinancialPosition + classifyFinancialRisk ─────────────────────────
// BQE-6, Jun 2026
//
// getFinancialPosition — pure data primitive, no classification, no narration.
// classifyFinancialRisk — pure function, no DB. Mirrors P5 classifyRelationship() pattern.
//
// CANONICAL SOURCE RULE (ChatGPT audit, Jun 2026):
//   totalReceivables uses invoices.amount_due — NOT customers.outstanding_balance.
//   customers.outstanding_balance is derived/cached and can become stale.
//   invoices.amount_due is transactional truth.
//   customers.outstanding_balance retained for largestDebtors ranking (fast path only).
//   shareOfReceivables denominator = invoice-based totalReceivables (canonical).
//   receivableConcentration numerator = customers.outstanding_balance (fast path, close enough for v1).
//   FUTURE: replace concentration numerator with sum(invoices.amount_due) per customer.
//
// cashGap = collectionsL30d - purchasesL30d (operating velocity — NOT totalPayables).
//   totalPayables = balance-sheet exposure (all unpaid regardless of timing).
//   purchasesL30d = what was purchased in last 30 days (cash velocity signal).
//
// purchase_bills uses customer_id (canonical per Finding 4 — supplier_id is legacy).
//
// concentrationRisk is separate from financialRiskLevel (customer scope):
//   financialRiskLevel = payment risk ("will this customer pay?")
//   concentrationRisk  = portfolio exposure ("do I depend too much on this customer?")
//   A customer can be low financial risk but high concentration risk.
//   Never merge into a single label — they require different owner actions.
//
// OPTIMIZATION NOTE (future):
//   _getCustomerFinancialPosition() re-queries all org invoices for shareOfReceivables.
//   If called in a loop (top_debtors, entity_profile enrichment), extract org total
//   as a shared parameter to avoid N+1 invoice scans.
//
// Modifies existing production surface: NO — additive only

export const DEFAULT_FINANCIAL_RISK_THRESHOLDS = {
  // Overdue ratio thresholds (overdueReceivables / totalReceivables)
  overdueCritical:             0.50,
  overdueHigh:                 0.30,
  overdueMedium:               0.15,
  // Concentration thresholds (customer shareOfReceivables)
  concentrationCritical:       0.40,
  concentrationHigh:           0.25,
  concentrationMedium:         0.15,
  // Credit utilization thresholds (outstandingBalance / creditLimit)
  creditUtilizationCritical:   1.0,
  creditUtilizationHigh:       0.8,
  // Org concentration (single customer / totalReceivables)
  orgConcentrationCritical:    0.60,
  orgConcentrationHigh:        0.40,
  // Future: load from ai_context or organisation.settings per org
};

export async function getFinancialPosition({ orgId, scope, supabase }) {
  if (!orgId || !scope) return { position: null, error: 'orgId and scope required' };

  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  try {
    if (scope.type === 'org') {
      return await _getOrgFinancialPosition({ orgId, supabase, today, thirtyDaysAgo });
    } else if (scope.type === 'customer' && scope.entityId) {
      return await _getCustomerFinancialPosition({ orgId, entityId: scope.entityId, supabase, today });
    } else {
      return { position: null, error: `unsupported scope type: ${scope.type}` };
    }
  } catch (err) {
    console.error('[getFinancialPosition] error:', err.message);
    return { position: null, error: err.message };
  }
}

async function _getOrgFinancialPosition({ orgId, supabase, today, thirtyDaysAgo }) {
  // ── Receivables: canonical = invoices.amount_due ──────────────────────────
  const { data: unpaidInvs } = await supabase.from('invoices')
    .select('customer_id, amount_due, due_date')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .in('status', ['sent', 'viewed', 'partial', 'overdue'])
    .gt('amount_due', 0)
    .is('deleted_at', null);

  const allUnpaid = unpaidInvs || [];
  const totalReceivables = allUnpaid.reduce((s, i) => s + Number(i.amount_due || 0), 0);
  const overdueInvs = allUnpaid.filter(i => i.due_date && i.due_date < today);
  const overdueReceivables = overdueInvs.reduce((s, i) => s + Number(i.amount_due || 0), 0);
  const overdueInvoiceCount = overdueInvs.length;

  // ── Collections L30d (for receivableDays + cashGap) ──────────────────────
  const { data: recentPayments } = await supabase.from('payments')
    .select('amount')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .gte('payment_date', thirtyDaysAgo)
    .is('deleted_at', null);
  const collectionsL30d = (recentPayments || []).reduce((s, p) => s + Number(p.amount || 0), 0);

  // receivableDays = DSO approximation
  const avgDailyCollections = collectionsL30d / 30;
  const receivableDays = avgDailyCollections > 0
    ? Math.round(totalReceivables / avgDailyCollections)
    : null;

  // ── Payables: purchase_bills.amount_due (balance-sheet exposure) ──────────
  const { data: bills } = await supabase.from('purchase_bills')
    .select('customer_id, amount_due, due_date, total_amount, issue_date')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .not('status', 'in', '("paid","cancelled")')
    .gt('amount_due', 0)
    .is('deleted_at', null);

  const allBills = bills || [];
  const totalPayables = allBills.reduce((s, b) => s + Number(b.amount_due || 0), 0);
  const overdueBills = allBills.filter(b => b.due_date && b.due_date < today);
  const overduePayables = overdueBills.reduce((s, b) => s + Number(b.amount_due || 0), 0);
  const overduePayableCount = overdueBills.length;

  // purchasesL30d = operating cash velocity (cashGap numerator)
  const purchasesL30d = allBills
    .filter(b => b.issue_date && b.issue_date >= thirtyDaysAgo)
    .reduce((s, b) => s + Number(b.total_amount || 0), 0);

  const cashGap = Math.round((collectionsL30d - purchasesL30d) * 100) / 100;

  // ── Largest debtors (ranking: customers.outstanding_balance — fast path) ──
  const { data: topCusts } = await supabase.from('customers')
    .select('id, name, outstanding_balance, credit_limit')
    .eq('organisation_id', orgId)
    .eq('status', 'active')
    .gt('outstanding_balance', 0)
    .is('deleted_at', null)
    .order('outstanding_balance', { ascending: false })
    .limit(5);

  const largestDebtors = (topCusts || []).map(c => ({
    entityId: c.id,
    name: c.name,
    amount: Number(c.outstanding_balance || 0),
    shareOfReceivables: totalReceivables > 0
      ? Math.round((Number(c.outstanding_balance || 0) / totalReceivables) * 100) / 100
      : null,
    creditUtilization: (c.credit_limit && Number(c.credit_limit) > 0)
      ? Math.round((Number(c.outstanding_balance || 0) / Number(c.credit_limit)) * 100) / 100
      : null,
  }));

  // ── Largest creditors (purchase_bills grouped by customer_id per Finding 4) ─
  const billsBySupplier = {};
  for (const b of allBills) {
    if (!b.customer_id) continue;
    if (!billsBySupplier[b.customer_id]) billsBySupplier[b.customer_id] = 0;
    billsBySupplier[b.customer_id] += Number(b.amount_due || 0);
  }
  const supplierIds = Object.keys(billsBySupplier);
  const { data: supplierNames } = supplierIds.length > 0
    ? await supabase.from('customers').select('id, name').in('id', supplierIds).eq('organisation_id', orgId)
    : { data: [] };
  const supplierNameMap = {};
  for (const s of supplierNames || []) supplierNameMap[s.id] = s.name;

  const largestCreditors = Object.entries(billsBySupplier)
    .map(([id, amount]) => ({ entityId: id, name: supplierNameMap[id] || id, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // receivableConcentration: top debtor (cached) / totalReceivables (invoice-based)
  const topDebtorAmount = largestDebtors[0]?.amount || 0;
  const receivableConcentration = totalReceivables > 0
    ? Math.round((topDebtorAmount / totalReceivables) * 100) / 100
    : 0;

  return {
    position: {
      totalReceivables: Math.round(totalReceivables * 100) / 100,
      overdueReceivables: Math.round(overdueReceivables * 100) / 100,
      overdueInvoiceCount,
      collectionsL30d: Math.round(collectionsL30d * 100) / 100,
      purchasesL30d: Math.round(purchasesL30d * 100) / 100,
      receivableDays,
      totalPayables: Math.round(totalPayables * 100) / 100,
      overduePayables: Math.round(overduePayables * 100) / 100,
      overduePayableCount,
      cashGap,
      receivableConcentration,
      largestDebtors,
      largestCreditors,
    },
    error: null,
  };
}

async function _getCustomerFinancialPosition({ orgId, entityId, supabase, today }) {
  // ── Unpaid invoices (canonical) ───────────────────────────────────────────
  const { data: custInvs } = await supabase.from('invoices')
    .select('amount_due, due_date')
    .eq('organisation_id', orgId).eq('customer_id', entityId)
    .eq('is_historical', false)
    .in('status', ['sent', 'viewed', 'partial', 'overdue'])
    .gt('amount_due', 0).is('deleted_at', null);

  const unpaid = custInvs || [];
  const outstandingBalance = unpaid.reduce((s, i) => s + Number(i.amount_due || 0), 0);
  const overdueInvs = unpaid.filter(i => i.due_date && i.due_date < today);
  const overdueAmount = overdueInvs.reduce((s, i) => s + Number(i.amount_due || 0), 0);
  const overdueInvoiceCount = overdueInvs.length;

  // ── Last invoice + payment dates ──────────────────────────────────────────
  const { data: lastInv } = await supabase.from('invoices')
    .select('issue_date').eq('organisation_id', orgId).eq('customer_id', entityId)
    .eq('is_historical', false).is('deleted_at', null)
    .order('issue_date', { ascending: false }).limit(1);
  const lastInvoiceDate = lastInv?.[0]?.issue_date || null;

  const { data: lastPay } = await supabase.from('payments')
    .select('payment_date').eq('organisation_id', orgId).eq('customer_id', entityId)
    .eq('is_historical', false).order('payment_date', { ascending: false }).limit(1);
  const lastPaymentDate = lastPay?.[0]?.payment_date || null;

  // ── Credit info ───────────────────────────────────────────────────────────
  const { data: custRow } = await supabase.from('customers')
    .select('credit_limit, payment_terms_days')
    .eq('id', entityId).eq('organisation_id', orgId).maybeSingle();
  const creditLimit = Number(custRow?.credit_limit || 0);
  const creditUtilization = (creditLimit > 0 && outstandingBalance > 0)
    ? Math.round((outstandingBalance / creditLimit) * 100) / 100
    : null;

  // ── avg_payment_days from entity_memory ───────────────────────────────────
  const { data: memRow } = await supabase.from('entity_memory')
    .select('memory_value').eq('organisation_id', orgId).eq('entity_type', 'customer')
    .eq('entity_id', entityId).eq('memory_key', 'avg_payment_days').is('deleted_at', null).maybeSingle();
  const _memVal = Number(memRow?.memory_value);
const averagePaymentDelay = memRow?.memory_value && !isNaN(_memVal) ? _memVal : null;

  // ── shareOfReceivables: invoice-based denominator (canonical) ─────────────
  // OPTIMIZATION NOTE: re-queries all org invoices. If called in a loop,
  // pass orgTotalReceivables as a parameter to avoid N+1 scans.
  const { data: orgUnpaid } = await supabase.from('invoices')
    .select('amount_due').eq('organisation_id', orgId).eq('is_historical', false)
    .in('status', ['sent', 'viewed', 'partial', 'overdue']).gt('amount_due', 0).is('deleted_at', null);
  const orgTotalReceivables = (orgUnpaid || []).reduce((s, i) => s + Number(i.amount_due || 0), 0);
  const shareOfReceivables = orgTotalReceivables > 0
    ? Math.round((outstandingBalance / orgTotalReceivables) * 100) / 100
    : 0;

  return {
    position: {
      entityId,
      outstandingBalance: Math.round(outstandingBalance * 100) / 100,
      overdueAmount: Math.round(overdueAmount * 100) / 100,
      overdueInvoiceCount,
      lastInvoiceDate,
      lastPaymentDate,
      averagePaymentDelay,
      creditLimit,
      creditUtilization,
      shareOfReceivables,
      paymentTermsDays: custRow?.payment_terms_days || 30,
    },
    error: null,
  };
}

// ── classifyFinancialRisk ─────────────────────────────────────────────────────
// Pure function — no DB. Mirrors classifyRelationship() from P5.
// Accepts position from getFinancialPosition() + optional threshold overrides.
//
// Customer scope returns: financialRiskLevel + financialRiskReason + concentrationRisk
// Org scope returns: cashRiskLevel + cashRiskReason
//
// financialRiskLevel  = payment risk only ("will this customer pay?")
// concentrationRisk   = portfolio exposure ("do I depend too much on this customer?")
// These are separate dimensions. Never merge. Different owner actions required.

export function classifyFinancialRisk(position, thresholds = {}) {
  const t = { ...DEFAULT_FINANCIAL_RISK_THRESHOLDS, ...thresholds };
  if (!position) return {
    financialRiskLevel: 'unknown', financialRiskReason: 'No data',
    cashRiskLevel: null, cashRiskReason: null, concentrationRisk: null,
  };

  // ── Customer scope ────────────────────────────────────────────────────────
  if (position.entityId) {
    const { outstandingBalance, overdueAmount, creditUtilization, shareOfReceivables } = position;
    const overdueRatio = outstandingBalance > 0 ? overdueAmount / outstandingBalance : 0;

    let financialRiskLevel, financialRiskReason;
    if (creditUtilization >= t.creditUtilizationCritical || overdueRatio > t.overdueCritical) {
      financialRiskLevel = 'critical';
      financialRiskReason = creditUtilization >= t.creditUtilizationCritical
        ? `Credit limit exceeded — ${Math.round(creditUtilization * 100)}% utilized`
        : `Over ${Math.round(t.overdueCritical * 100)}% of outstanding balance is overdue`;
    } else if (creditUtilization >= t.creditUtilizationHigh || overdueRatio > t.overdueHigh) {
      financialRiskLevel = 'high';
      financialRiskReason = creditUtilization >= t.creditUtilizationHigh
        ? `Credit utilization at ${Math.round(creditUtilization * 100)}% — approaching limit`
        : `${Math.round(overdueRatio * 100)}% of outstanding balance is overdue`;
    } else if (overdueAmount > 0) {
      financialRiskLevel = 'medium';
      financialRiskReason = 'Some overdue amount present — monitor closely';
    } else {
      financialRiskLevel = 'low';
      financialRiskReason = 'No overdue amounts. Payment health is good.';
    }

    // concentrationRisk: separate portfolio exposure dimension
    let concentrationRisk;
    if (shareOfReceivables > t.concentrationCritical) concentrationRisk = 'critical';
    else if (shareOfReceivables > t.concentrationHigh) concentrationRisk = 'high';
    else if (shareOfReceivables > t.concentrationMedium) concentrationRisk = 'medium';
    else concentrationRisk = 'low';

    return { financialRiskLevel, financialRiskReason, concentrationRisk, cashRiskLevel: null, cashRiskReason: null };
  }

  // ── Org scope ─────────────────────────────────────────────────────────────
  const { totalReceivables, overdueReceivables, receivableConcentration, cashGap } = position;
  const overdueRatio = totalReceivables > 0 ? overdueReceivables / totalReceivables : 0;

  let cashRiskLevel, cashRiskReason;
  if (overdueRatio > t.overdueCritical || receivableConcentration > t.orgConcentrationCritical) {
    cashRiskLevel = 'critical';
    cashRiskReason = overdueRatio > t.overdueCritical
      ? `Over ${Math.round(t.overdueCritical * 100)}% of receivables overdue — immediate collection action needed`
      : `Single customer holds ${Math.round(receivableConcentration * 100)}% of receivables — extreme concentration risk`;
  } else if (overdueRatio > t.overdueHigh || receivableConcentration > t.orgConcentrationHigh) {
    cashRiskLevel = 'high';
    cashRiskReason = overdueRatio > t.overdueHigh
      ? `${Math.round(overdueRatio * 100)}% of receivables overdue — escalate collections`
      : `Top customer holds ${Math.round(receivableConcentration * 100)}% of receivables`;
  } else if (overdueRatio > t.overdueMedium) {
    cashRiskLevel = 'medium';
    cashRiskReason = `${Math.round(overdueRatio * 100)}% of receivables overdue — monitor and follow up`;
  } else {
    cashRiskLevel = 'low';
    cashRiskReason = cashGap < 0
      ? `Collections healthy but purchases exceeded collections this month — watch cash timing`
      : 'Receivables healthy. Overdue ratio within acceptable range.';
  }

  return { cashRiskLevel, cashRiskReason, financialRiskLevel: null, financialRiskReason: null, concentrationRisk: null };
}
