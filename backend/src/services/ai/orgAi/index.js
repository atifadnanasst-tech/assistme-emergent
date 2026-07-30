/**
 * AssistMe — Org AI Deterministic Operations
 *
 * Location: /services/ai/orgAi/index.js
 * Created: 2026-05-21
 * Purpose: 18 deterministic business intelligence functions for Home AI tab.
 *
 * STANDARD RETURN CONTRACT (every function):
 * {
 *   response_text: string,       — GPT narration (2-3 lines, max 150 tokens)
 *   chart_data: object | null,   — built deterministically by backend, never by GPT
 *   next_action: { text: string } | null,  — rules engine nudge, never by GPT
 * }
 * message_type: 'ai_response' is injected by dispatchMenuQuery(), not individual functions.
 *
 * Architecture:
 *   Menu click → dispatchMenuQuery() → deterministic function
 *   SQL fetches truth → backend builds chart + nudge → GPT narrates only
 *   No [VIZ:...] tag protocol used — chart_data built directly, no parsing needed
 *
 * Currency:
 *   All functions receive orgCurrency from route context.
 *   formatCurrency(amount, orgCurrency) — never hardcode currency symbols.
 *   organisations.currency is the source of truth.
 *
 * TODO (before global expansion):
 *   - Replace IST hardcoding with organisations.timezone-aware date helpers
 *   - Replace toLocaleString('en-IN') with locale derived from organisations.country
 *   - Add SQL joins to replace N+1 customer name lookups at scale
 *
 * Session A: collectionsToday, totalOutstanding, topCustomers (3 of 18)
 * Session B: remaining 15 functions
 */

// OpenAI client is passed in via dispatchMenuQuery — never instantiated at module level.
// Use getOpenAI() from ai-routes.js, consistent with all other backend routes.

import { narrate } from './narration.js';
// ── Currency formatter (global-ready abstraction) ─────────────
// TODO: add locale-aware number formatting before global expansion
const CURRENCY_SYMBOLS = {
  INR: '₹', USD: '$', AED: 'AED ', GBP: '£', EUR: '€',
  BDT: '৳', SAR: 'SAR ', SGD: 'S$',
};

const formatCurrency = (amount, currency = 'INR') => {
  if (!amount && amount !== 0) return '0';
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return `${symbol}${Number(amount).toLocaleString('en-IN')}`;
};

// ── Date helpers ──────────────────────────────────────────────
// TODO: replace with organisations.timezone-aware helper before global expansion
// Currently hardcoded to IST (UTC+5:30) — acceptable for India-only v1
const todayIST = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};

const monthStartIST = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  ist.setDate(1);
  return ist.toISOString().split('T')[0];
};


// ── FUNCTION 1: Collections Today ─────────────────────────────
export async function collectionsToday(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();

  // Step 1: Payments today (IST date)
  const { data: payments, error } = await supabase
    .from('payments')
    .select('amount, customer_id, payment_date, payment_method')
    .eq('organisation_id', orgId)
    .eq('payment_date', todayIST())
    .eq('is_historical', false)
    .order('amount', { ascending: false });

  if (error) console.warn('[orgAi] collectionsToday payments error:', error.message);

  const total = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const count = (payments || []).length;

  // Step 2: Top payer name — separate query (no nested join assumption)
  let topPayerName = null;
  if (payments && payments.length > 0) {
    const { data: cust } = await supabase
      .from('customers')
      .select('name')
      .eq('id', payments[0].customer_id)
      .single();
    topPayerName = cust?.name || null;
  }

  // Step 3: Chart — deterministic from SQL result
  const chart_data = count === 0 ? {
    type: 'insight',
    title: 'Collections Today',
    text: 'No payments received today yet.',
    level: 'info',
  } : {
    type: 'metric_grid',
    title: 'Collections Today',
    currency: orgCurrency,
    cards: [
      { label: 'Total Collected', value: total, format: 'currency', trend_direction: 'up' },
      { label: 'Payments Received', value: count, format: 'number' },
      ...(topPayerName ? [{ label: 'Top Payer', value: topPayerName }] : []),
    ],
  };

  // Step 4: 7-day average — deterministic threshold, not hardcoded
  const sevenDaysAgo = new Date(new Date(todayIST() + 'T00:00:00').getTime() - 7 * 86400000).toISOString().split('T')[0];
  const { data: last7Payments } = await supabase
    .from('payments').select('amount')
    .eq('organisation_id', orgId).eq('is_historical', false)
    .gte('payment_date', sevenDaysAgo).lt('payment_date', todayIST()).is('deleted_at', null);
  const last7Total = (last7Payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const avgLast7 = last7Total / 7;
  const isStrongDay = total >= 1000 && (avgLast7 === 0 || total >= avgLast7 * 0.7);

  // Step 5: Top outstanding customers — for recovery/chase modes
  const { data: topOutstanding } = await supabase
    .from('customers').select('id, name, phone, outstanding_balance')
    .eq('organisation_id', orgId).eq('status', 'active')
    .is('deleted_at', null).gt('outstanding_balance', 0)
    .order('outstanding_balance', { ascending: false }).limit(3);
  const outstandingEntities = (topOutstanding || []).map(c => ({
    customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
    invoice_id: null, invoice_number: '', amount: c.outstanding_balance,
    message: `${c.name}, this is a reminder that your account has an outstanding balance of ${formatCurrency(c.outstanding_balance, orgCurrency)}. Kindly arrange payment today.`,
  }));

  // Step 6: Dormant customers — for strong/growth mode reactivation only
  let dormantEntities = [];
  if (isStrongDay) {
    const fourteenDaysAgo = new Date(new Date(todayIST() + 'T00:00:00').getTime() - 14 * 86400000).toISOString().split('T')[0];
    const { data: recentInvs } = await supabase
      .from('invoices').select('customer_id')
      .eq('organisation_id', orgId).eq('is_historical', false)
      .gte('issue_date', fourteenDaysAgo).is('deleted_at', null);
    const recentIds = new Set((recentInvs || []).map(i => i.customer_id));
    const { data: olderInvs } = await supabase
      .from('invoices').select('customer_id, total_amount')
      .eq('organisation_id', orgId).eq('is_historical', false)
      .gte('issue_date', sevenDaysAgo).lt('issue_date', fourteenDaysAgo).is('deleted_at', null);
    const dormantMap = {};
    for (const inv of olderInvs || []) {
      if (!recentIds.has(inv.customer_id)) {
        if (!dormantMap[inv.customer_id]) dormantMap[inv.customer_id] = { customer_id: inv.customer_id, total: 0 };
        dormantMap[inv.customer_id].total += Number(inv.total_amount || 0);
      }
    }
    const dormantIds = Object.keys(dormantMap);
    if (dormantIds.length > 0) {
      const { data: custData } = await supabase
        .from('customers').select('id, name, phone').in('id', dormantIds).eq('organisation_id', orgId);
      for (const c of custData || []) {
        if (dormantMap[c.id]) { dormantMap[c.id].customer_name = c.name; dormantMap[c.id].customer_phone = c.phone || null; }
      }
      dormantEntities = Object.values(dormantMap)
        .filter(c => c.customer_name).sort((a, b) => b.total - a.total).slice(0, 3)
        .map(c => ({
          customer_id: c.customer_id, customer_name: c.customer_name, customer_phone: c.customer_phone,
          invoice_id: null, invoice_number: '', amount: c.total,
          message: `${c.customer_name}, we noticed you haven't placed an order recently. Would love to reconnect and discuss your next order.`,
        }));
    }
  }

  // Step 7: Typed next_action — state-driven operating modes
  const totalOutstandingAmt = outstandingEntities.reduce((s, e) => s + e.amount, 0);
  let next_action = null;
  if (count === 0) {
    next_action = {
      text: outstandingEntities.length > 0
        ? `No collections yet today. ${formatCurrency(totalOutstandingAmt, orgCurrency)} outstanding across ${outstandingEntities.length} customer${outstandingEntities.length > 1 ? 's' : ''} — start chasing now.`
        : 'No collections yet today. No outstanding balances — create new invoices to build pipeline.',
      type: 'send_reminder',
      signal_type: 'revenue_recovery',
      source_surface: 'collections_today',
      execution_mode: outstandingEntities.length > 1 ? 'bulk' : outstandingEntities.length === 1 ? 'single' : null,
      entities: outstandingEntities,
      prefill: outstandingEntities.length === 1 ? {
        message: `${outstandingEntities[0].customer_name}, this is a reminder that your account has an outstanding balance of ${formatCurrency(outstandingEntities[0].amount, orgCurrency)}. Kindly arrange payment today.`,
        language: language || 'en',
      } : null,
    };
  } else if (!isStrongDay) {
    next_action = {
      text: outstandingEntities.length > 0
        ? `${formatCurrency(total, orgCurrency)} collected — below daily average. ${outstandingEntities[0].customer_name} has ${formatCurrency(outstandingEntities[0].amount, orgCurrency)} outstanding. Follow up now.`
        : `${formatCurrency(total, orgCurrency)} collected — below daily average. Push for more collections today.`,
      type: 'send_reminder',
      signal_type: 'proactive_collection',
      source_surface: 'collections_today',
      execution_mode: outstandingEntities.length > 1 ? 'bulk' : outstandingEntities.length === 1 ? 'single' : null,
      entities: outstandingEntities,
      prefill: outstandingEntities.length === 1 ? {
        message: `${outstandingEntities[0].customer_name}, this is a reminder that your account has an outstanding balance of ${formatCurrency(outstandingEntities[0].amount, orgCurrency)}. Kindly arrange payment today.`,
        language: language || 'en',
      } : null,
    };
  } else {
    const growthEntities = dormantEntities.length > 0 ? dormantEntities : outstandingEntities;
    const othersCount = growthEntities.length - 1;
    const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';
    next_action = {
      text: dormantEntities.length > 0
        ? `Strong day — ${formatCurrency(total, orgCurrency)} collected. ${dormantEntities[0].customer_name}${othersStr} haven't reordered recently — reach out now to expand revenue.`
        : `Strong day — ${formatCurrency(total, orgCurrency)} collected. Keep momentum — push outstanding customers to close the day even stronger.`,
      type: dormantEntities.length > 0 ? 'reactivate_customer' : 'send_reminder',
      signal_type: 'momentum_expansion',
      source_surface: 'collections_today',
      execution_mode: growthEntities.length > 1 ? 'bulk' : growthEntities.length === 1 ? 'single' : null,
      entities: growthEntities,
      prefill: growthEntities.length === 1 ? {
        message: growthEntities[0].message || `${growthEntities[0].customer_name}, we haven't heard from you in a while. Would love to reconnect.`,
        language: language || 'en',
      } : null,
    };
  }

  // Step 8: GPT narration — always last, never blocks core response
  const response_text = await narrate(
    { total, count, topPayerName, currency: orgCurrency, avgLast7: Math.round(avgLast7) },
    'collections_today',
    openai,
    { language, orgId, supabase }
  );

  console.log('[orgAi]', { fn: 'collectionsToday', ms: Date.now() - start, rows: count });
  return { response_text, chart_data, next_action };
}

// ── FUNCTION 2: Total Outstanding ─────────────────────────────
export async function totalOutstanding(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();

  // Step 1: Top 5 customers by outstanding (for chart display)
  const { data: topCustomers, error: custErr } = await supabase
    .from('customers')
    .select('id, name, phone, outstanding_balance')
    .eq('organisation_id', orgId)
    .eq('status', 'active')
    .gt('outstanding_balance', 0)
    .order('outstanding_balance', { ascending: false })
    .limit(5);

  if (custErr) console.warn('[orgAi] totalOutstanding customers error:', custErr.message);

  // Step 2: Org total from ALL customers (not just top 5 — correct aggregation)
  const { data: allOutstanding } = await supabase
    .from('customers')
    .select('outstanding_balance')
    .eq('organisation_id', orgId)
    .eq('status', 'active')
    .gt('outstanding_balance', 0);

  const total = (allOutstanding || []).reduce((s, c) => s + Number(c.outstanding_balance || 0), 0);
  const count = (allOutstanding || []).length;

  // Step 3: Overdue invoices count
  const { data: overdueInvoices } = await supabase
    .from('invoices')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .in('status', ['sent', 'viewed', 'partial', 'overdue'])
    .lt('due_date', todayIST())
    .gt('amount_due', 0)
    .is('deleted_at', null);

  const overdueCount = (overdueInvoices || []).length;

  // Step 4: Chart — deterministic
  const chart_data = count === 0 ? {
    type: 'insight',
    title: 'Outstanding Balance',
    text: 'All accounts are clear. No outstanding balances.',
    level: 'info',
  } : {
    type: 'ranked_list',
    title: 'Top Outstanding Customers',
    currency: orgCurrency,
    series: (topCustomers || []).map(c => ({
      label: c.name,
      value: Number(c.outstanding_balance || 0),
    })),
    highlight: `${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue`,
    level: total > 100000 ? 'warning' : 'info',
  };

  // Step 5: Typed next_action — state-driven, entities = pure business data
  // Reuses topCustomers already fetched — no extra DB queries
  const outstandingEntities = (topCustomers || []).map(c => ({
    customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
    invoice_id: null, invoice_number: '', amount: Number(c.outstanding_balance || 0),
  }));
  const othersCount = outstandingEntities.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';

  let next_action = null;
  if (count === 0) {
    next_action = {
      text: "All accounts clear. No outstanding receivables — create new quotes to build tomorrow's pipeline.",
      type: 'create_quote', signal_type: 'revenue_recovery', source_surface: 'total_outstanding', execution_mode: null, entities: [], prefill: null,
    };
  } else if (overdueCount > 0) {
    next_action = {
      text: `${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue. ${outstandingEntities[0]?.customer_name}${othersStr} — send reminders immediately.`,
      type: 'send_reminder',
      signal_type: 'overdue_collection',
      source_surface: 'total_outstanding',
      execution_mode: outstandingEntities.length > 1 ? 'bulk' : 'single',
      entities: outstandingEntities,
      prefill: outstandingEntities.length === 1 ? {
        message: `${outstandingEntities[0].customer_name}, your account has an outstanding balance of ${formatCurrency(outstandingEntities[0].amount, orgCurrency)} which is now overdue. Kindly arrange payment immediately.`,
        language: language || 'en',
      } : null,
    };
  } else {
    next_action = {
      text: `${formatCurrency(total, orgCurrency)} outstanding across ${count} customer${count !== 1 ? 's' : ''}. ${outstandingEntities[0]?.customer_name} owes ${formatCurrency(outstandingEntities[0]?.amount || 0, orgCurrency)} — send a reminder before it becomes overdue.`,
      type: 'send_reminder',
      signal_type: 'proactive_collection',
      source_surface: 'total_outstanding',
      execution_mode: outstandingEntities.length > 1 ? 'bulk' : 'single',
      entities: outstandingEntities,
      prefill: outstandingEntities.length === 1 ? {
        message: `${outstandingEntities[0].customer_name}, this is a reminder that your account has an outstanding balance of ${formatCurrency(outstandingEntities[0].amount, orgCurrency)}. Kindly arrange payment at your earliest convenience.`,
        language: language || 'en',
      } : null,
    };
  }

  // Step 6: GPT narration
  const response_text = await narrate({
    total, count, overdueCount, currency: orgCurrency,
    topCustomers: (topCustomers || []).slice(0, 3).map(c => ({
      name: c.name, amount: c.outstanding_balance,
    })),
  }, 'total_outstanding', openai, { language, orgId, supabase });
  console.log('[orgAi] totalOutstanding ms=' + (Date.now() - start));
  return { response_text, chart_data, next_action };
}

// ── FUNCTION 3: Top Customers ─────────────────────────────────
export async function topCustomers(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();

  // Step 1: All invoices this month
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('customer_id, total_amount')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .gte('issue_date', monthStartIST())
    .in('status', ['sent', 'viewed', 'paid', 'partial']);

  if (invErr) console.warn('[orgAi] topCustomers invoices error:', invErr.message);

  // Step 2: Aggregate ALL customers — grandTotal = true org revenue (correct concentration math)
  const customerTotals = {};
  for (const inv of invoices || []) {
    if (!customerTotals[inv.customer_id]) customerTotals[inv.customer_id] = 0;
    customerTotals[inv.customer_id] += Number(inv.total_amount || 0);
  }

  const grandTotal = Object.values(customerTotals).reduce((s, v) => s + v, 0);

  // Top 5 IDs by revenue
  const topIds = Object.entries(customerTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);

  // Step 3: Fetch names + phone for top 5 only (separate query)
  let ranked = [];
  if (topIds.length > 0) {
    const { data: custNames } = await supabase
      .from('customers')
      .select('id, name, phone')
      .in('id', topIds);

    ranked = topIds.map(id => ({
      id,
      name: custNames?.find(c => c.id === id)?.name || 'Unknown',
      phone: custNames?.find(c => c.id === id)?.phone || null,
      total: customerTotals[id],
    }));
  }

  // Step 4: Chart — deterministic
  const chart_data = ranked.length === 0 ? {
    type: 'insight',
    title: 'Top Customers',
    text: 'No invoices recorded this month yet.',
    level: 'info',
  } : {
    type: 'ranked_list',
    title: 'Top Customers This Month',
    currency: orgCurrency,
    series: ranked.map(c => ({ label: c.name, value: c.total })),
    highlight: ranked[0]
      ? `${ranked[0].name} leads with ${formatCurrency(ranked[0].total, orgCurrency)}`
      : null,
    level: 'info',
  };

  // Step 5: Typed next_action — relationship intelligence surface
  // Entities = pure business data, message generated at render time
  // Fallback always populated to ensure button renders
  // TODO: add 5-7 day cooldown filter via entity_memory.last_reminded_at when write side is wired

  // Build top customer entities from ranked list
  const topEntities = ranked.map(c => ({
    customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
    invoice_id: null, invoice_number: '', amount: c.total,
  }));

  // Fallback: outstanding customers if ranked is empty
  let fallbackEntities = [];
  if (topEntities.length === 0) {
    const { data: fallbackCusts } = await supabase
      .from('customers').select('id, name, phone, outstanding_balance')
      .eq('organisation_id', orgId).eq('status', 'active')
      .is('deleted_at', null).gt('outstanding_balance', 0)
      .order('outstanding_balance', { ascending: false }).limit(3);
    fallbackEntities = (fallbackCusts || []).map(c => ({
      customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
      invoice_id: null, invoice_number: '', amount: Number(c.outstanding_balance || 0),
    }));
  }

  let next_action = null;
  if (ranked.length === 0) {
    // RECOVERY MODE — no sales, reactivate with fallback outstanding customers
    const recoveryEntities = fallbackEntities;
    const rOthers = recoveryEntities.length - 1;
    const rOthersStr = rOthers > 0 ? ` and ${rOthers} other${rOthers > 1 ? 's' : ''}` : '';
    next_action = {
      text: recoveryEntities.length > 0
        ? `No sales this month yet. ${recoveryEntities[0].customer_name}${rOthersStr} have outstanding balances — reconnect and create fresh invoices.`
        : 'No sales this month yet. Create your first invoice to get started.',
      type: 'reactivate_customer',
      signal_type: 'customer_reactivation',
      source_surface: 'top_customers',
      execution_mode: recoveryEntities.length > 1 ? 'bulk' : recoveryEntities.length === 1 ? 'single' : null,
      entities: recoveryEntities,
      prefill: recoveryEntities.length === 1 ? {
        message: `${recoveryEntities[0].customer_name}, hope all is well. We would love to reconnect and discuss your next order.`,
        language: language || 'en',
      } : null,
    };
  } else if (grandTotal > 0 && ranked[0].total / grandTotal > 0.5) {
    // CONCENTRATION RISK — diversify, target other top buyers
    const diversifyEntities = topEntities.slice(1, 4); // exclude top customer, target others
    const dOthers = diversifyEntities.length - 1;
    const dOthersStr = dOthers > 0 ? ` and ${dOthers} other${dOthers > 1 ? 's' : ''}` : '';
    next_action = {
      text: diversifyEntities.length > 0
        ? `${ranked[0].name} is ${Math.round((ranked[0].total / grandTotal) * 100)}% of revenue — concentration risk. Reach out to ${diversifyEntities[0].customer_name}${dOthersStr} to grow other accounts.`
        : `${ranked[0].name} is ${Math.round((ranked[0].total / grandTotal) * 100)}% of revenue. Diversify by creating invoices for other customers this week.`,
      type: 'reactivate_customer',
      signal_type: 'concentration_risk',
      source_surface: 'top_customers',
      execution_mode: diversifyEntities.length > 1 ? 'bulk' : diversifyEntities.length === 1 ? 'single' : null,
      entities: diversifyEntities.length > 0 ? diversifyEntities : topEntities,
      prefill: diversifyEntities.length === 1 ? {
        message: `${diversifyEntities[0].customer_name}, hope all is well. We would love to discuss your next order — shall we put together a fresh quote?`,
        language: language || 'en',
      } : null,
    };
  } else {
    // HEALTHY SPREAD — deepen top relationships + push momentum
    const momentumEntities = topEntities.slice(0, 3);
    const mOthers = momentumEntities.length - 1;
    const mOthersStr = mOthers > 0 ? ` and ${mOthers} other${mOthers > 1 ? 's' : ''}` : '';
    next_action = {
      text: `${ranked[0].name} leads this month with ${formatCurrency(ranked[0].total, orgCurrency)}. Follow up with ${momentumEntities[0].customer_name}${mOthersStr} to deepen momentum and explore larger orders.`,
      type: 'reactivate_customer',
      signal_type: 'momentum_expansion',
      source_surface: 'top_customers',
      execution_mode: momentumEntities.length > 1 ? 'bulk' : 'single',
      entities: momentumEntities,
      prefill: momentumEntities.length === 1 ? {
        message: `${momentumEntities[0].customer_name}, great working with you this month. We would love to explore how we can support you further — any upcoming orders we can help with?`,
        language: language || 'en',
      } : null,
    };
  }

  // Step 6: GPT narration
  // Deterministic label prefix -- guarantees the owner always reads the
  // correct metric name regardless of model wording, even if the LLM
  // narration below still drifts despite the strengthened prompt. See
  // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI Financial Narration
  // Mislabeling" for the bug this fixes (revenue was being mislabeled as
  // outstanding balance in the actual chat response).
  const rawNarration = await narrate({
    ranked: ranked.slice(0, 3),
    grandTotal,
    currency: orgCurrency,
    topName: ranked[0]?.name,
    topAmount: ranked[0]?.total,
  }, 'top_customers', openai, { language, orgId, supabase });
  const response_text = `📈 Top customers by revenue this month:
${rawNarration}`;

  console.log('[orgAi] topCustomers ms=' + (Date.now() - start));
  return { response_text, chart_data, next_action };
}


// ── FINANCIAL PRIMITIVES ──────────────────────────────────────
// Section marker — all functions below are financial intelligence primitives.
// When extracting to /engines/financial/, move entire section together.

// ── FUNCTION 4: Revenue This Month ───────────────────────────
export async function revenueThisMonth(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();

  // Step 1: All confirmed invoices this month (IST)
  // getRevenueSummary({ rangeStart, rangeEnd }) — thin wrapper below for future range support
  const rangeStart = monthStartIST();

  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('customer_id, total_amount')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .gte('issue_date', rangeStart)
    .not('status', 'in', '("draft","cancelled")')
    .gt('total_amount', 0)
    .is('deleted_at', null);

  if (invErr) console.warn('[orgAi] revenueThisMonth invoices error:', invErr.message);

  const rows = invoices || [];

  // Step 2: Aggregate — deterministic JS arithmetic, never SQL aggregation
  const totalRevenue = rows.reduce((s, inv) => s + Number(inv.total_amount || 0), 0);
  const invoiceCount = rows.length;
  const avgInvoiceValue = invoiceCount === 0 ? 0 : Math.round((totalRevenue / invoiceCount) * 100) / 100;

  // Step 3: Top customer by revenue this month
  const customerTotals = {};
  for (const inv of rows) {
    if (!customerTotals[inv.customer_id]) customerTotals[inv.customer_id] = 0;
    customerTotals[inv.customer_id] += Number(inv.total_amount || 0);
  }

  let topCustomerId = null;
  let topCustomerRevenue = 0;
  let topCustomerPct = 0;
  let topCustomerName = null;

  for (const [id, rev] of Object.entries(customerTotals)) {
    if (rev > topCustomerRevenue) { topCustomerRevenue = rev; topCustomerId = id; }
  }

  if (topCustomerId && totalRevenue > 0) {
    topCustomerPct = Math.round((topCustomerRevenue / totalRevenue) * 100);
    const { data: cust } = await supabase
      .from('customers').select('name')
      .eq('id', topCustomerId).eq('organisation_id', orgId).maybeSingle();
    topCustomerName = cust?.name || null;
  }

  // Step 4: Chart — deterministic
  const chart_data = invoiceCount === 0 ? {
    type: 'insight',
    title: 'Revenue This Month',
    text: 'No invoices recorded this month yet.',
    level: 'info',
  } : {
    type: 'metric_grid',
    title: 'Revenue This Month',
    currency: orgCurrency,
    cards: [
      { label: 'Total Revenue', value: totalRevenue, format: 'currency', trend_direction: 'up' },
      { label: 'Invoices Raised', value: invoiceCount, format: 'number' },
      { label: 'Avg Invoice Value', value: avgInvoiceValue, format: 'currency' },
    ],
  };

  // Step 5: Lapsed buyer query — deterministic pipeline targets
  // Customers who bought in previous 30-60 day window but NOT this month
  const thirtyDaysAgo = new Date(new Date(todayIST() + 'T00:00:00').getTime() - 30 * 86400000).toISOString().split('T')[0];
  const sixtyDaysAgo = new Date(new Date(todayIST() + 'T00:00:00').getTime() - 60 * 86400000).toISOString().split('T')[0];

  const activeThisMonthIds = new Set(rows.map(inv => inv.customer_id));

  const { data: prevInvoices } = await supabase
    .from('invoices').select('customer_id, total_amount')
    .eq('organisation_id', orgId).eq('is_historical', false)
    .gte('issue_date', sixtyDaysAgo).lt('issue_date', rangeStart)
    .not('status', 'in', '("draft","cancelled")')
    .gt('total_amount', 0).is('deleted_at', null);

  const lapsedMap = {};
  for (const inv of prevInvoices || []) {
    if (!activeThisMonthIds.has(inv.customer_id)) {
      if (!lapsedMap[inv.customer_id]) lapsedMap[inv.customer_id] = { customer_id: inv.customer_id, total: 0 };
      lapsedMap[inv.customer_id].total += Number(inv.total_amount || 0);
    }
  }

  let lapsedEntities = [];
  const lapsedIds = Object.keys(lapsedMap);
  if (lapsedIds.length > 0) {
    const { data: lapsedCusts } = await supabase
      .from('customers').select('id, name, phone')
      .in('id', lapsedIds).eq('organisation_id', orgId);
    for (const c of lapsedCusts || []) {
      if (lapsedMap[c.id]) { lapsedMap[c.id].customer_name = c.name; lapsedMap[c.id].customer_phone = c.phone || null; }
    }
    lapsedEntities = Object.values(lapsedMap)
      .filter(c => c.customer_name).sort((a, b) => b.total - a.total).slice(0, 5)
      .map(c => ({
        customer_id: c.customer_id, customer_name: c.customer_name, customer_phone: c.customer_phone,
        invoice_id: null, invoice_number: '', amount: c.total,
      }));
  }

  // Step 6: Typed next_action — revenue surface = growth/sales domain, never collections
  const othersCount = lapsedEntities.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';
  let next_action = null;

  if (invoiceCount === 0) {
    next_action = {
      text: lapsedEntities.length > 0
        ? `No revenue this month yet. ${lapsedEntities[0].customer_name}${othersStr} bought recently — send them a fresh quote now to kick off the month.`
        : 'No invoices this month yet. Create your first quote or invoice to get started.',
      type: 'reactivate_customer',
      signal_type: 'pipeline_growth',
      source_surface: 'revenue_this_month',
      execution_mode: lapsedEntities.length > 1 ? 'bulk' : lapsedEntities.length === 1 ? 'single' : null,
      entities: lapsedEntities,
      prefill: lapsedEntities.length === 1 ? {
        message: `${lapsedEntities[0].customer_name}, hope all is well. We would love to discuss your next order — shall we put together a fresh quote for you?`,
        language: language || 'en',
      } : null,
    };
  } else if (topCustomerName && topCustomerPct > 50) {
    // Concentration risk — diversify. Use lapsed buyers or fall back to outstanding customers
    const { data: divCusts } = lapsedEntities.length === 0 ? await supabase
      .from('customers').select('id, name, phone, outstanding_balance')
      .eq('organisation_id', orgId).eq('status', 'active')
      .is('deleted_at', null).gt('outstanding_balance', 0)
      .order('outstanding_balance', { ascending: false }).limit(3)
      : { data: null };
    const divEntities = lapsedEntities.length > 0 ? lapsedEntities : (divCusts || []).map(c => ({
      customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
      invoice_id: null, invoice_number: '', amount: Number(c.outstanding_balance || 0),
    }));
    const divOthersCount = divEntities.length - 1;
    const divOthersStr = divOthersCount > 0 ? ` and ${divOthersCount} other${divOthersCount > 1 ? 's' : ''}` : '';
    next_action = {
      text: divEntities.length > 0
        ? `${topCustomerName} is contributing ${topCustomerPct}% of revenue. ${divEntities[0].customer_name}${divOthersStr} — reach out now to diversify your revenue base.`
        : `${topCustomerName} is contributing ${topCustomerPct}% of revenue. Reach out to other customers this week to diversify.`,
      type: 'reactivate_customer',
      signal_type: 'concentration_risk',
      source_surface: 'revenue_this_month',
      execution_mode: divEntities.length > 1 ? 'bulk' : divEntities.length === 1 ? 'single' : null,
      entities: divEntities,
      prefill: divEntities.length === 1 ? {
        message: `${divEntities[0].customer_name}, hope all is well. We would love to discuss your next order — shall we put together a fresh quote for you?`,
        language: language || 'en',
      } : null,
    };
  } else if (lapsedEntities.length > 0) {
    next_action = {
      text: `${formatCurrency(totalRevenue, orgCurrency)} billed this month. ${lapsedEntities[0].customer_name}${othersStr} bought recently but haven't ordered this month — send fresh quotes to accelerate revenue.`,
      type: 'reactivate_customer',
      signal_type: 'pipeline_growth',
      source_surface: 'revenue_this_month',
      execution_mode: lapsedEntities.length > 1 ? 'bulk' : 'single',
      entities: lapsedEntities,
      prefill: lapsedEntities.length === 1 ? {
        message: `${lapsedEntities[0].customer_name}, hope all is well. We would love to discuss your next order — shall we put together a fresh quote for you?`,
        language: language || 'en',
      } : null,
    };
  } else {
    // No lapsed buyers found — fall back to top outstanding customers as reactivation targets
    const { data: fallbackCusts } = await supabase
      .from('customers').select('id, name, phone, outstanding_balance')
      .eq('organisation_id', orgId).eq('status', 'active')
      .is('deleted_at', null).gt('outstanding_balance', 0)
      .order('outstanding_balance', { ascending: false }).limit(3);
    const fallbackEntities = (fallbackCusts || []).map(c => ({
      customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
      invoice_id: null, invoice_number: '', amount: Number(c.outstanding_balance || 0),
    }));
    next_action = {
      text: fallbackEntities.length > 0
        ? `${formatCurrency(totalRevenue, orgCurrency)} billed this month. ${fallbackEntities[0].customer_name} has ${formatCurrency(fallbackEntities[0].amount, orgCurrency)} outstanding — collect now to strengthen month-end position.`
        : `${formatCurrency(totalRevenue, orgCurrency)} billed across ${invoiceCount} invoice${invoiceCount !== 1 ? 's' : ''} this month. Keep the momentum going.`,
      type: 'send_reminder',
      signal_type: 'proactive_collection',
      source_surface: 'revenue_this_month',
      execution_mode: fallbackEntities.length > 1 ? 'bulk' : fallbackEntities.length === 1 ? 'single' : null,
      entities: fallbackEntities,
      prefill: fallbackEntities.length === 1 ? {
        message: `${fallbackEntities[0].customer_name}, this is a reminder that your account has an outstanding balance of ${formatCurrency(fallbackEntities[0].amount, orgCurrency)}. Kindly arrange payment at your earliest convenience.`,
        language: language || 'en',
      } : null,
    };
  }

  // Step 7: GPT narration — receives frozen computed truth, never raw rows
  // Step 6: GPT narration — receives frozen computed truth, never raw rows
  const response_text = await narrate({
    totalRevenue, invoiceCount, avgInvoiceValue,
    topCustomerName, topCustomerRevenue, topCustomerPct,
    currency: orgCurrency,
  }, 'revenue_this_month', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'revenueThisMonth', ms: Date.now() - start, rows: invoiceCount });
  return { response_text, chart_data, next_action };
}


// ── FUNCTION 5: Invoices Due This Week ───────────────────────
export async function invoicesDueThisWeek(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();

  const today = todayIST();
  // Derive weekEnd from IST-normalized today — keeps timezone semantics consistent
  const weekEndDate = new Date(today);
  weekEndDate.setDate(weekEndDate.getDate() + 7);
  const weekEnd = weekEndDate.toISOString().split('T')[0];

  // Step 1: Invoices due within next 7 days
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, invoice_number, customer_id, amount_due, due_date')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .in('status', ['sent', 'viewed', 'partial', 'overdue'])
    .gte('due_date', today)
    .lte('due_date', weekEnd)
    .not('due_date', 'is', null)
    .gt('amount_due', 0)
    .is('deleted_at', null)
    .order('due_date', { ascending: true });

  if (invErr) console.warn('[orgAi] invoicesDueThisWeek error:', invErr.message);

  const rows = invoices || [];
  const count = rows.length;
  const totalDue = rows.reduce((s, inv) => s + Number(inv.amount_due || 0), 0);

  // Step 2: Resolve customer names — filter null customer_id defensively
  let customerMap = {};
  if (count > 0) {
    const customerIds = [...new Set(rows.map(r => r.customer_id).filter(Boolean))];
    const { data: customers } = await supabase
      .from('customers')
      .select('id, name, phone')
      .in('id', customerIds)
      .eq('organisation_id', orgId);
    for (const c of customers || []) customerMap[c.id] = { name: c.name, phone: c.phone || null };
  }

  // Step 3: Build ranked list with deterministic days_until_due
  const ranked = rows.map(inv => {
    // Explicit T00:00:00 prevents timezone/UTC parsing drift
    const due = new Date(inv.due_date + 'T00:00:00');
    const base = new Date(today + 'T00:00:00');
    const daysUntilDue = Math.round((due - base) / 86400000);
    return {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      customer_id: inv.customer_id,
      customer_name: customerMap[inv.customer_id]?.name || 'Unknown',
      customer_phone: customerMap[inv.customer_id]?.phone || null,
      amount_due: Number(inv.amount_due),
      due_date: inv.due_date,
      days_until_due: daysUntilDue,
    };
  });

  // Step 4: Chart — deterministic
  const chart_data = count === 0 ? {
    type: 'insight',
    title: 'Invoices Due This Week',
    text: "No invoices due this week. You're clear.",
    level: 'info',
  } : {
    type: 'ranked_list',
    title: 'Invoices Due This Week',
    currency: orgCurrency,
    series: ranked.map(r => ({
      label: `${r.customer_name} — ${r.invoice_number}`,
      value: r.amount_due,
      sublabel: r.days_until_due === 0 ? 'Due TODAY' : `Due in ${r.days_until_due} day(s)`,
    })),
    highlight: `${count} invoice(s) — ${formatCurrency(totalDue, orgCurrency)} total`,
  };

  // Step 5: Typed next_action — rules engine
  // Contract: { text, type, execution_mode, entities[], prefill }
  // type = business intent (not transport/UI layer)
  // entities[] supports single and bulk execution paths
  // prefill: per-customer for single; null for bulk (execution layer generates individualized messages)
  // TODO: migrate prefill to { template_key, variables } for multilingual/multi-channel (Phase 2)
  const dueToday = ranked.filter(r => r.days_until_due === 0);
  const dueTodayTotal = dueToday.reduce((s, r) => s + r.amount_due, 0);
  let next_action = null;

  if (count === 0) {
    // No collections expected this week — push pipeline creation
    next_action = {
      text: "No invoices due this week. Strong week to create new quotes and grow the pipeline.",
      type: 'create_quote',
      signal_type: 'pipeline_growth',
      source_surface: 'invoices_due_this_week',
      execution_mode: null,
      entities: [],
      prefill: null,
    };
  } else if (dueToday.length > 0) {
    // Group by customer — one entity per customer, one combined message
    const todayByCustomer = {};
    for (const r of dueToday) {
      if (!todayByCustomer[r.customer_id]) {
        todayByCustomer[r.customer_id] = { customer_id: r.customer_id, customer_name: r.customer_name, customer_phone: r.customer_phone, invoices: [] };
      }
      todayByCustomer[r.customer_id].invoices.push({ invoice_id: r.invoice_id, invoice_number: r.invoice_number, amount: r.amount_due });
    }
    const urgentEntities = Object.values(todayByCustomer).map(c => {
      const invoiceList = c.invoices.map(i => `${i.invoice_number} (${formatCurrency(i.amount, orgCurrency)})`).join(', ');
      const totalAmt = c.invoices.reduce((s, i) => s + i.amount, 0);
      return {
        customer_id: c.customer_id, customer_name: c.customer_name, customer_phone: c.customer_phone,
        invoice_id: c.invoices[0].invoice_id,
        invoice_number: c.invoices.map(i => i.invoice_number).join(', '),
        amount: totalAmt,
        message: `${c.customer_name}, the following invoice(s) were due today: ${invoiceList}. Kindly arrange payment at your earliest.`,
      };
    });
    const uniqueTodayCustomers = urgentEntities.length;
    next_action = {
      text: `${dueToday.length} invoice(s) due TODAY totalling ${formatCurrency(dueTodayTotal, orgCurrency)}. Follow up immediately.`,
      type: 'send_reminder',
      signal_type: 'overdue_collection',
      source_surface: 'invoices_due_this_week',
      execution_mode: uniqueTodayCustomers > 1 ? 'bulk' : 'single',
      entities: urgentEntities,
      prefill: uniqueTodayCustomers === 1 ? {
        message: urgentEntities[0].message,
        language: language || 'en',
      } : null,
    };
  } else {
    // Due later this week — group by customer, one combined message
    const laterByCustomer = {};
    for (const r of ranked) {
      if (!laterByCustomer[r.customer_id]) {
        laterByCustomer[r.customer_id] = { customer_id: r.customer_id, customer_name: r.customer_name, customer_phone: r.customer_phone, invoices: [], days_until_due: r.days_until_due };
      }
      laterByCustomer[r.customer_id].invoices.push({ invoice_id: r.invoice_id, invoice_number: r.invoice_number, amount: r.amount_due, days: r.days_until_due });
    }
    const allEntities = Object.values(laterByCustomer).map(c => {
      const invoiceList = c.invoices.map(i => `${i.invoice_number} (${formatCurrency(i.amount, orgCurrency)}, due in ${i.days} day(s))`).join(', ');
      const totalAmt = c.invoices.reduce((s, i) => s + i.amount, 0);
      return {
        customer_id: c.customer_id, customer_name: c.customer_name, customer_phone: c.customer_phone,
        invoice_id: c.invoices[0].invoice_id,
        invoice_number: c.invoices.map(i => i.invoice_number).join(', '),
        amount: totalAmt,
        message: `${c.customer_name}, reminder: ${invoiceList}. Please arrange payment in advance.`,
      };
    });
    const uniqueLaterCustomers = allEntities.length;
    next_action = {
      text: `Next invoice due in ${allEntities[0].invoices?.[0]?.days || ranked[0].days_until_due} day(s) from ${allEntities[0].customer_name} — ${formatCurrency(allEntities[0].amount, orgCurrency)}.`,
      type: 'send_reminder',
      signal_type: 'proactive_collection',
      source_surface: 'invoices_due_this_week',
      execution_mode: uniqueLaterCustomers > 1 ? 'bulk' : 'single',
      entities: allEntities,
      prefill: uniqueLaterCustomers === 1 ? {
        message: allEntities[0].message,
        language: language || 'en',
      } : null,
    }
  }

  // Step 6: GPT narration — frozen computed truth only
  const response_text = await narrate({
    count, totalDue, ranked: ranked.slice(0, 3), currency: orgCurrency,
    dueTodayCount: dueToday.length,
  }, 'invoices_due_this_week', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'invoicesDueThisWeek', ms: Date.now() - start, rows: count });
  return { response_text, chart_data, next_action };
}

// ── FUNCTION 6: Weekly Trend ───────────────────────────────────────
// 3 deterministic queries: payment trend + product momentum + dormant customers
// GPT narrates only. issue_date used as commercial truth. Monday-start weeks.
export async function weeklyTrend(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();
  const sixWeeksAgo = new Date(new Date(today + 'T00:00:00').getTime() - 42 * 86400000).toISOString().split('T')[0];
  const fourteenDaysAgo = new Date(new Date(today + 'T00:00:00').getTime() - 14 * 86400000).toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(new Date(today + 'T00:00:00').getTime() - 30 * 86400000).toISOString().split('T')[0];

  // Query 1: 6-week payment trend
  const { data: payments, error: payErr } = await supabase
    .from('payments')
    .select('amount, payment_date')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .gte('payment_date', sixWeeksAgo)
    .is('deleted_at', null)
    .order('payment_date', { ascending: true });
  if (payErr) console.warn('[orgAi] weeklyTrend payments error:', payErr.message);

  // Monday-start week grouping (Indian business standard)
  const weeklyTotals = {};
  for (const p of payments || []) {
    const d = new Date(p.payment_date + 'T00:00:00');
    const daysToMonday = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - daysToMonday);
    const weekKey = weekStart.toISOString().split('T')[0];
    weeklyTotals[weekKey] = (weeklyTotals[weekKey] || 0) + Number(p.amount || 0);
  }
  const weeks = Object.keys(weeklyTotals).sort();
  const weekSeries = weeks.map(w => ({ week: w, total: weeklyTotals[w] }));
  const thisWeekTotal = weekSeries[weekSeries.length - 1]?.total || 0;
  const lastWeekTotal = weekSeries[weekSeries.length - 2]?.total || 0;
  let direction = 'flat', changePct = 0;
  if (lastWeekTotal > 0) {
    changePct = Math.round(((thisWeekTotal - lastWeekTotal) / lastWeekTotal) * 100);
    direction = changePct > 5 ? 'up' : changePct < -5 ? 'down' : 'flat';
  } else if (thisWeekTotal > 0) { direction = 'up'; changePct = 100; }

  // Query 2: Top moving products (use issue_date as commercial truth)
  const { data: recentInvoices } = await supabase
    .from('invoices')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .gte('issue_date', thirtyDaysAgo)
    .is('deleted_at', null);
  const recentInvIds = (recentInvoices || []).map(i => i.id);
  let topProducts = [];
  if (recentInvIds.length > 0) {
    const { data: items } = await supabase
      .from('invoice_items')
      .select('product_id, line_total, description')
      .eq('organisation_id', orgId)
      .in('invoice_id', recentInvIds)
      .is('deleted_at', null);
    const productTotals = {};
    for (const item of items || []) {
      const key = item.product_id || item.description;
      if (!productTotals[key]) productTotals[key] = { product_id: item.product_id, name: item.description, total: 0 };
      productTotals[key].total += Number(item.line_total || 0);
    }
    const productIds = Object.values(productTotals).map(p => p.product_id).filter(Boolean);
    if (productIds.length > 0) {
      const { data: prods } = await supabase.from('products').select('id, name').in('id', productIds).eq('organisation_id', orgId);
      for (const prod of prods || []) { if (productTotals[prod.id]) productTotals[prod.id].name = prod.name; }
    }
    topProducts = Object.values(productTotals).sort((a, b) => b.total - a.total).slice(0, 3);
  }

  // Query 3: Dormant customers — bought 14-42 days ago, not since (use issue_date)
  const { data: recentActiveInvs } = await supabase
    .from('invoices').select('customer_id')
    .eq('organisation_id', orgId).eq('is_historical', false)
    .gte('issue_date', fourteenDaysAgo).is('deleted_at', null);
  const recentCustomerIds = new Set((recentActiveInvs || []).map(i => i.customer_id));

  const { data: olderInvs } = await supabase
    .from('invoices').select('customer_id, total_amount')
    .eq('organisation_id', orgId).eq('is_historical', false)
    .gte('issue_date', sixWeeksAgo).lt('issue_date', fourteenDaysAgo).is('deleted_at', null);
  const dormantMap = {};
  for (const inv of olderInvs || []) {
    if (!recentCustomerIds.has(inv.customer_id)) {
      if (!dormantMap[inv.customer_id]) dormantMap[inv.customer_id] = { customer_id: inv.customer_id, total: 0 };
      dormantMap[inv.customer_id].total += Number(inv.total_amount || 0);
    }
  }
  let dormantCustomers = [];
  const dormantIds = Object.keys(dormantMap);
  if (dormantIds.length > 0) {
    const { data: custData } = await supabase.from('customers').select('id, name, phone').in('id', dormantIds).eq('organisation_id', orgId);
    for (const c of custData || []) { if (dormantMap[c.id]) { dormantMap[c.id].customer_name = c.name; dormantMap[c.id].customer_phone = c.phone || null; } }
    dormantCustomers = Object.values(dormantMap).filter(c => c.customer_name).sort((a, b) => b.total - a.total).slice(0, 3);
  }

  // Chart
  const chart_data = {
    type: 'bar', title: 'Weekly Collections Trend', currency: orgCurrency,
    series: weekSeries.map((w, i) => ({ label: `Wk ${i + 1}`, value: w.total, sublabel: w.week })),
    highlight: direction === 'up' ? `Up ${changePct}% vs last week` : direction === 'down' ? `Down ${Math.abs(changePct)}% vs last week` : 'Flat vs last week',
  };

  // Typed next_action — always action-oriented, never complacent
  const topProduct = topProducts[0];
  const targetEntities = dormantCustomers.map(c => ({
    customer_id: c.customer_id, customer_name: c.customer_name, customer_phone: c.customer_phone,
    invoice_id: null, invoice_number: '', amount: c.total,
    message: topProduct
      ? `${c.customer_name}, ${topProduct.name} is moving well right now. Would love to discuss your next order.`
      : `${c.customer_name}, we haven't heard from you in a while. Would love to reconnect and discuss your next order.`,
  }));
  const othersCount = targetEntities.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';

  let actionText;
  if (direction === 'up') {
    actionText = targetEntities.length > 0
      ? `Up ${changePct}% vs last week. ${targetEntities[0].customer_name}${othersStr} haven't reordered recently — reach out while momentum is high.`
      : `Up ${changePct}% vs last week — push to close remaining outstanding before month end.`;
  } else if (direction === 'down') {
    actionText = targetEntities.length > 0
      ? `Down ${Math.abs(changePct)}% vs last week. ${targetEntities[0].customer_name}${othersStr} haven't reordered — reconnect now to recover momentum.`
      : `Down ${Math.abs(changePct)}% vs last week. Focus on outstanding customers to recover this week's numbers.`;
  } else {
    actionText = targetEntities.length > 0
      ? `Collections flat. ${targetEntities[0].customer_name}${othersStr} are overdue for a reorder — reach out now.`
      : `Collections flat this week. Push your outstanding customers to accelerate numbers.`;
  }

  const next_action = {
    text: actionText,
    type: targetEntities.length > 0 ? 'reactivate_customer' : 'send_reminder',
      signal_type: direction === 'up' ? 'momentum_expansion' : direction === 'down' ? 'customer_reactivation' : 'customer_reactivation',
      source_surface: 'weekly_trend',
    execution_mode: targetEntities.length > 1 ? 'bulk' : targetEntities.length === 1 ? 'single' : null,
    entities: targetEntities,
    prefill: targetEntities.length === 1 ? { message: targetEntities[0].message, language: language || 'en' } : null,
  };

  const response_text = await narrate({
    direction, changePct, thisWeekTotal, lastWeekTotal, weeksOfData: weekSeries.length,
    topProducts: topProducts.map(p => ({ name: p.name, total: p.total })),
    dormantCount: dormantCustomers.length, dormantNames: dormantCustomers.map(c => c.customer_name),
    currency: orgCurrency,
  }, 'weekly_trend', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'weeklyTrend', ms: Date.now() - start, weeks: weekSeries.length, dormant: dormantCustomers.length });
  return { response_text, chart_data, next_action };
}



// ── FUNCTION 7: Follow Up Today ────────────────────────────────
// 3-signal priority waterfall: overdue → due-soon → expiring quotes
// Cooldown: suppresses customers actioned for same signal within 7 days (via action_log)
// Narration explains selection criteria naturally — builds owner trust and auditability
// Future extraction: signal generation, ranking, cooldown, execution → isolated modules
export async function followUpToday(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const threeDaysLater = new Date(todayDate.getTime() + 3 * 86400000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(todayDate.getTime() - 7 * 86400000).toISOString().split('T')[0];
  const SIGNAL_PRIORITY = ['follow_up_overdue','follow_up_due_soon','follow_up_quote_expiry'];
  const exhaustedSignals = [];
  const { data: recentOverdue } = await supabase.from('action_log').select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer').eq('signal_type', 'follow_up_overdue').gte('actioned_at', sevenDaysAgo);
  const { data: recentDueSoon } = await supabase.from('action_log').select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer').eq('signal_type', 'follow_up_due_soon').gte('actioned_at', sevenDaysAgo);
  const { data: recentQuote } = await supabase.from('action_log').select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer').eq('signal_type', 'follow_up_quote_expiry').gte('actioned_at', sevenDaysAgo);
  const cooldownOverdue = new Set((recentOverdue || []).map(r => r.entity_id));
  const cooldownDueSoon = new Set((recentDueSoon || []).map(r => r.entity_id));
  const cooldownQuote = new Set((recentQuote || []).map(r => r.entity_id));
  const { data: overdueInvs } = await supabase.from('invoices').select('customer_id, amount_due, due_date, invoice_number').eq('organisation_id', orgId).eq('is_historical', false).in('status', ['sent', 'viewed', 'partial', 'overdue']).lt('due_date', today).gt('amount_due', 0).is('deleted_at', null);
  const overdueByCustomer = {};
  for (const inv of overdueInvs || []) {
    if (!overdueByCustomer[inv.customer_id]) overdueByCustomer[inv.customer_id] = { total: 0, invoices: [] };
    overdueByCustomer[inv.customer_id].total += Number(inv.amount_due || 0);
    overdueByCustomer[inv.customer_id].invoices.push(inv.invoice_number);
  }
  const overdueSuppressedCount = Object.keys(overdueByCustomer).filter(id => cooldownOverdue.has(id)).length;
  const overdueActive = Object.entries(overdueByCustomer).filter(([id]) => !cooldownOverdue.has(id));
  if (overdueActive.length === 0 && Object.keys(overdueByCustomer).length > 0) exhaustedSignals.push('follow_up_overdue');
  const { data: dueSoonInvs } = await supabase.from('invoices').select('customer_id, amount_due, due_date, invoice_number').eq('organisation_id', orgId).eq('is_historical', false).in('status', ['sent', 'viewed', 'partial']).gte('due_date', today).lte('due_date', threeDaysLater).gt('amount_due', 0).is('deleted_at', null);
  const dueSoonByCustomer = {};
  for (const inv of dueSoonInvs || []) {
    if (!dueSoonByCustomer[inv.customer_id]) dueSoonByCustomer[inv.customer_id] = { total: 0, invoices: [], due_date: inv.due_date };
    dueSoonByCustomer[inv.customer_id].total += Number(inv.amount_due || 0);
    dueSoonByCustomer[inv.customer_id].invoices.push(inv.invoice_number);
  }
  const dueSoonSuppressedCount = Object.keys(dueSoonByCustomer).filter(id => cooldownDueSoon.has(id)).length;
  const dueSoonActive = Object.entries(dueSoonByCustomer).filter(([id]) => !cooldownDueSoon.has(id));
  if (dueSoonActive.length === 0 && Object.keys(dueSoonByCustomer).length > 0) exhaustedSignals.push('follow_up_due_soon');
  const { data: expiringQuotes } = await supabase.from('quotations').select('customer_id, total_amount, expiry_date, quote_number').eq('organisation_id', orgId).in('status', ['sent', 'viewed']).gte('expiry_date', today).lte('expiry_date', threeDaysLater).gt('total_amount', 0).is('deleted_at', null);
  const quoteByCustomer = {};
  for (const q of expiringQuotes || []) {
    if (!quoteByCustomer[q.customer_id]) quoteByCustomer[q.customer_id] = { total: 0, quotes: [], expiry_date: q.expiry_date };
    quoteByCustomer[q.customer_id].total += Number(q.total_amount || 0);
    quoteByCustomer[q.customer_id].quotes.push(q.quote_number);
  }
  const quoteSuppressedCount = Object.keys(quoteByCustomer).filter(id => cooldownQuote.has(id)).length;
  const quoteActive = Object.entries(quoteByCustomer).filter(([id]) => !cooldownQuote.has(id));
  if (quoteActive.length === 0 && Object.keys(quoteByCustomer).length > 0) exhaustedSignals.push('follow_up_quote_expiry');
  let activeSignal = null, activeEntries = [], suppressedCount = 0, signalType = null;
  if (overdueActive.length > 0) { activeSignal = 'overdue'; activeEntries = overdueActive; suppressedCount = overdueSuppressedCount; signalType = 'follow_up_overdue'; }
  else if (dueSoonActive.length > 0) { activeSignal = 'due_soon'; activeEntries = dueSoonActive; suppressedCount = dueSoonSuppressedCount; signalType = 'follow_up_due_soon'; }
  else if (quoteActive.length > 0) { activeSignal = 'quote_expiry'; activeEntries = quoteActive; suppressedCount = quoteSuppressedCount; signalType = 'follow_up_quote_expiry'; }
  let followUpEntities = [];
  if (activeEntries.length > 0) {
    const customerIds = activeEntries.map(([id]) => id);
    const { data: custData } = await supabase.from('customers').select('id, name, phone').in('id', customerIds).eq('organisation_id', orgId);
    const custMap = {};
    for (const c of custData || []) custMap[c.id] = c;
    followUpEntities = activeEntries.sort((a, b) => b[1].total - a[1].total).slice(0, 5).map(([id, data]) => ({
      customer_id: id, customer_name: custMap[id]?.name || 'Unknown', customer_phone: custMap[id]?.phone || null,
      invoice_id: null, invoice_number: (data.invoices || data.quotes || []).join(', '), amount: data.total,
    })).filter(e => e.customer_name !== 'Unknown');
  }
  const signalLabel = activeSignal === 'overdue' ? 'Overdue Invoices' : activeSignal === 'due_soon' ? 'Due in 3 Days' : activeSignal === 'quote_expiry' ? 'Expiring Quotes' : null;
  const totalSuppressed = overdueSuppressedCount + dueSoonSuppressedCount + quoteSuppressedCount;
  const chart_data = followUpEntities.length === 0 ? {
    type: 'insight', title: 'Follow Up Today',
    text: totalSuppressed > 0 ? `All ${totalSuppressed} customer(s) were already followed up within the last 7 days. Check back tomorrow.` : 'No follow-up actions needed today. All invoices and quotes are current.',
    level: 'info',
  } : {
    type: 'ranked_list', title: signalLabel || 'Follow Up Today', currency: orgCurrency,
    series: followUpEntities.map(e => ({ label: e.customer_name, value: e.amount })),
    highlight: activeSignal === 'overdue' ? `${followUpEntities.length} overdue — act now` : activeSignal === 'due_soon' ? `${followUpEntities.length} due within 3 days` : `${followUpEntities.length} quotes expiring soon`,
    level: activeSignal === 'overdue' ? 'warning' : 'info',
  };
  const othersCount = followUpEntities.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';
  let next_action = null;
  if (followUpEntities.length === 0) {
    next_action = { text: totalSuppressed > 0 ? `All ${totalSuppressed} follow-up customer(s) were already contacted within the last 7 days. Check back tomorrow.` : 'No follow-ups needed today. All invoices and quotes are current.', type: 'send_reminder', signal_type: signalType, source_surface: 'follow_up_today', execution_mode: null, entities: [], prefill: null };
  } else {
    const actionText = activeSignal === 'overdue' ? `${followUpEntities[0].customer_name}${othersStr} ${followUpEntities.length > 1 ? 'have' : 'has'} overdue invoices totalling ${formatCurrency(followUpEntities.reduce((s, e) => s + e.amount, 0), orgCurrency)} — send reminders immediately.` : activeSignal === 'due_soon' ? `${followUpEntities[0].customer_name}${othersStr} ${followUpEntities.length > 1 ? 'have' : 'has'} invoices due within 3 days — follow up now before they slip.` : `${followUpEntities[0].customer_name}${othersStr} ${followUpEntities.length > 1 ? 'have' : 'has'} quotes expiring within 3 days — follow up to protect the pipeline.`;
    next_action = {
      text: actionText, type: 'send_reminder', signal_type: signalType, source_surface: 'follow_up_today',
      execution_mode: followUpEntities.length > 1 ? 'bulk' : 'single', entities: followUpEntities,
      prefill: followUpEntities.length === 1 ? {
        message: activeSignal === 'overdue' ? `${followUpEntities[0].customer_name}, your invoice(s) ${followUpEntities[0].invoice_number} totalling ${formatCurrency(followUpEntities[0].amount, orgCurrency)} are overdue. Kindly arrange payment immediately.` : activeSignal === 'due_soon' ? `${followUpEntities[0].customer_name}, a reminder that your invoice(s) ${followUpEntities[0].invoice_number} totalling ${formatCurrency(followUpEntities[0].amount, orgCurrency)} are due within 3 days. Kindly arrange payment in advance.` : `${followUpEntities[0].customer_name}, your quote ${followUpEntities[0].invoice_number} totalling ${formatCurrency(followUpEntities[0].amount, orgCurrency)} is expiring soon. Please let us know if you would like to proceed.`,
        language: language || 'en',
      } : null,
    };
  }
  // FIX B: Fetch suppressed customer names for transparent narration
  // Owner hears "Ania Adnan was already reminded" not "6 customers suppressed"
  let suppressedNames = [];
  const allCooldownIds = [...cooldownOverdue, ...cooldownDueSoon, ...cooldownQuote];
  const uniqueCooldownIds = [...new Set(allCooldownIds)];
  if (uniqueCooldownIds.length > 0) {
    const { data: suppressedCusts } = await supabase
      .from('customers').select('name')
      .in('id', uniqueCooldownIds).eq('organisation_id', orgId);
    suppressedNames = (suppressedCusts || []).map(c => c.name).slice(0, 4);
  }

  // FIX C: Fallback entities when all signals exhausted — no empty card
  if (followUpEntities.length === 0 && next_action.entities.length === 0) {
    const { data: fallbackCusts } = await supabase
      .from('customers').select('id, name, phone, outstanding_balance')
      .eq('organisation_id', orgId).eq('status', 'active')
      .is('deleted_at', null).gt('outstanding_balance', 0)
      .order('outstanding_balance', { ascending: false }).limit(3);
    if (fallbackCusts && fallbackCusts.length > 0) {
      const fallbackEntities = fallbackCusts.map(c => ({
        customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null,
        invoice_id: null, invoice_number: '', amount: Number(c.outstanding_balance || 0),
      }));
      next_action = {
        text: suppressedNames.length > 0
          ? `${suppressedNames.slice(0, 2).join(', ')}${suppressedNames.length > 2 ? ` and ${suppressedNames.length - 2} others` : ''} were recently reminded. While you wait, consider chasing ${fallbackEntities[0].customer_name}'s outstanding balance.`
          : `No urgent follow-ups today. Consider chasing ${fallbackEntities[0].customer_name}'s outstanding balance of ${formatCurrency(fallbackEntities[0].amount, orgCurrency)}.`,
        type: 'send_reminder',
        signal_type: 'proactive_collection',
        source_surface: 'follow_up_today',
        execution_mode: fallbackEntities.length > 1 ? 'bulk' : 'single',
        entities: fallbackEntities,
        prefill: null,
      };
    }
  }

  const response_text = await narrate({
    activeSignal, signalLabel,
    count: followUpEntities.length,
    topName: followUpEntities[0]?.customer_name,
    topAmount: followUpEntities[0]?.amount,
    suppressedCount: totalSuppressed,
    suppressedNames,
    exhaustedSignals,
    totalOverdue: overdueActive.length,
    totalDueSoon: dueSoonActive.length,
    totalQuoteExpiry: quoteActive.length,
    currency: orgCurrency,
  }, 'follow_up_today', openai, { language, orgId, supabase });
  console.log('[orgAi]', { fn: 'followUpToday', ms: Date.now() - start, signal: activeSignal, count: followUpEntities.length, suppressed: totalSuppressed, exhausted: exhaustedSignals });
  return { response_text, chart_data, next_action };
}



// ── FUNCTION 8: Risk Alerts ────────────────────────────────────
// 3 structural risk signals: severely overdue + multiple unpaid + credit exceeded
// Different from followUpToday: severity-based not timing-based
// risk_level + risk_reason fields enable future UI tiers and escalation workflows
// TODO: extract buildRiskEntities(), getRiskCooldowns(), buildRiskChart() when > 3 signals
export async function riskAlerts(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const thirtyDaysAgo = new Date(todayDate.getTime() - 30 * 86400000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(todayDate.getTime() - 7 * 86400000).toISOString().split('T')[0];
  const { data: recentOverdueRisk } = await supabase.from('action_log').select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer').eq('signal_type', 'risk_alert_overdue').gte('actioned_at', sevenDaysAgo);
  const { data: recentCreditRisk } = await supabase.from('action_log').select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer').eq('signal_type', 'risk_alert_credit_exceeded').gte('actioned_at', sevenDaysAgo);
  const cooldownOverdueRisk = new Set((recentOverdueRisk || []).map(r => r.entity_id));
  const cooldownCreditRisk = new Set((recentCreditRisk || []).map(r => r.entity_id));
  const { data: overdueInvs } = await supabase.from('invoices').select('customer_id, amount_due, due_date, invoice_number').eq('organisation_id', orgId).eq('is_historical', false).in('status', ['sent', 'viewed', 'partial', 'overdue']).lt('due_date', thirtyDaysAgo).gt('amount_due', 0).is('deleted_at', null);
  const severeByCustomer = {};
  for (const inv of overdueInvs || []) {
    if (!severeByCustomer[inv.customer_id]) severeByCustomer[inv.customer_id] = { total: 0, invoices: [], max_days_overdue: 0 };
    const daysOverdue = Math.floor((todayDate - new Date(`${inv.due_date}T00:00:00Z`)) / 86400000);
    severeByCustomer[inv.customer_id].total += Number(inv.amount_due || 0);
    severeByCustomer[inv.customer_id].invoices.push(inv.invoice_number);
    severeByCustomer[inv.customer_id].max_days_overdue = Math.max(severeByCustomer[inv.customer_id].max_days_overdue, daysOverdue);
  }
  const { data: allOverdueInvs } = await supabase.from('invoices').select('customer_id, amount_due, invoice_number').eq('organisation_id', orgId).eq('is_historical', false).in('status', ['sent', 'viewed', 'partial', 'overdue']).lt('due_date', today).gt('amount_due', 0).is('deleted_at', null);
  const multipleByCustomer = {};
  for (const inv of allOverdueInvs || []) {
    if (!multipleByCustomer[inv.customer_id]) multipleByCustomer[inv.customer_id] = { total: 0, invoices: [] };
    multipleByCustomer[inv.customer_id].total += Number(inv.amount_due || 0);
    multipleByCustomer[inv.customer_id].invoices.push(inv.invoice_number);
  }
  const multipleRisk = Object.entries(multipleByCustomer).filter(([id, data]) => data.invoices.length >= 2 && !severeByCustomer[id]);
  const { data: creditBreached } = await supabase.from('customers').select('id, name, phone, outstanding_balance, credit_limit').eq('organisation_id', orgId).eq('status', 'active').is('deleted_at', null).gt('credit_limit', 0);
  const creditRisk = (creditBreached || []).filter(c => Number(c.outstanding_balance) > Number(c.credit_limit)).map(c => ({ customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null, outstanding: Number(c.outstanding_balance), limit: Number(c.credit_limit), breach: Number(c.outstanding_balance) - Number(c.credit_limit) }));
  const allRiskIds = [...new Set([...Object.keys(severeByCustomer), ...multipleRisk.map(([id]) => id)])];
  let custMap = {};
  if (allRiskIds.length > 0) {
    const { data: custData } = await supabase.from('customers').select('id, name, phone').in('id', allRiskIds).eq('organisation_id', orgId);
    for (const c of custData || []) custMap[c.id] = c;
  }
  const riskEntities = [];
  const addedIds = new Set();
  for (const [id, data] of Object.entries(severeByCustomer).sort((a, b) => b[1].total - a[1].total)) {
    if (cooldownOverdueRisk.has(id)) continue;
    const cust = custMap[id];
    if (!cust) continue;
    riskEntities.push({ customer_id: id, customer_name: cust.name, customer_phone: cust.phone || null, invoice_id: null, invoice_number: data.invoices.join(', '), amount: data.total, risk_signal: 'severely_overdue', risk_reason: `${data.max_days_overdue} days overdue`, days_overdue: data.max_days_overdue });
    addedIds.add(id);
  }
  for (const [id, data] of multipleRisk.sort((a, b) => b[1].total - a[1].total)) {
    if (cooldownOverdueRisk.has(id) || addedIds.has(id)) continue;
    const cust = custMap[id];
    if (!cust) continue;
    riskEntities.push({ customer_id: id, customer_name: cust.name, customer_phone: cust.phone || null, invoice_id: null, invoice_number: data.invoices.join(', '), amount: data.total, risk_signal: 'multiple_overdue', risk_reason: `${data.invoices.length} unpaid invoices`, days_overdue: null });
    addedIds.add(id);
  }
  for (const c of creditRisk.filter(c => !cooldownCreditRisk.has(c.customer_id) && !addedIds.has(c.customer_id)).slice(0, 3)) {
    riskEntities.push({ customer_id: c.customer_id, customer_name: c.customer_name, customer_phone: c.customer_phone, invoice_id: null, invoice_number: '', amount: c.outstanding, risk_signal: 'credit_exceeded', risk_reason: `Exceeded credit limit by ${formatCurrency(c.breach, orgCurrency)}`, days_overdue: null });
    addedIds.add(c.customer_id);
  }
  const topEntities = riskEntities.slice(0, 5);
  const hasSevere = Object.keys(severeByCustomer).some(id => !cooldownOverdueRisk.has(id));
  const hasMultiple = multipleRisk.some(([id]) => !cooldownOverdueRisk.has(id));
  const hasCreditBreach = creditRisk.some(c => !cooldownCreditRisk.has(c.customer_id));
  const risk_level = hasSevere ? 'danger' : (hasMultiple || hasCreditBreach) ? 'warning' : 'low';
  const primarySignal = hasSevere ? 'severely_overdue' : hasMultiple ? 'multiple_overdue' : hasCreditBreach ? 'credit_exceeded' : null;
  const chartLevel = risk_level === 'danger' ? 'warning' : 'info';
  const chart_data = topEntities.length === 0 ? { type: 'insight', title: 'Risk Alerts', text: 'No active risk signals. All accounts are within normal parameters.', level: 'info' } : { type: 'ranked_list', title: 'Risk Accounts', currency: orgCurrency, series: topEntities.map(e => ({ label: e.customer_name, value: e.amount, sublabel: e.risk_reason })), highlight: hasSevere ? `${Object.keys(severeByCustomer).length} account(s) 30+ days overdue` : hasMultiple ? `${multipleRisk.length} account(s) with multiple unpaid invoices` : `${creditRisk.length} account(s) over credit limit`, level: chartLevel };
  const othersCount = topEntities.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';
  let next_action = null;
  if (topEntities.length === 0) {
    next_action = { text: 'No risk accounts detected. All relationships are within normal parameters.', type: 'send_reminder', signal_type: null, source_surface: 'risk_alerts', risk_level: 'low', execution_mode: null, entities: [], prefill: null };
  } else {
    const topEntity = topEntities[0];
    const daysStr = topEntity.days_overdue ? `${topEntity.days_overdue} days overdue` : topEntity.risk_reason;
    const actionText = primarySignal === 'severely_overdue' ? `${topEntity.customer_name}${othersStr} ${topEntities.length > 1 ? 'are' : 'is'} ${daysStr} — escalate immediately.` : primarySignal === 'multiple_overdue' ? `${topEntity.customer_name}${othersStr} ${topEntities.length > 1 ? 'have' : 'has'} ${topEntity.risk_reason} — behavioral pattern, not a one-off delay.` : `${topEntity.customer_name}${othersStr} ${topEntities.length > 1 ? 'have' : 'has'} exceeded credit limit — consider pausing new orders.`;
    const escalationMsg = primarySignal === 'severely_overdue' ? `${topEntity.customer_name}, your invoice(s) ${topEntity.invoice_number} totalling ${formatCurrency(topEntity.amount, orgCurrency)} ${topEntity.days_overdue ? `are ${topEntity.days_overdue} days overdue` : 'are significantly overdue'}. This requires immediate settlement.` : primarySignal === 'multiple_overdue' ? `${topEntity.customer_name}, you have ${topEntity.risk_reason} totalling ${formatCurrency(topEntity.amount, orgCurrency)}. Kindly arrange payment for all outstanding amounts immediately.` : `${topEntity.customer_name}, your outstanding balance of ${formatCurrency(topEntity.amount, orgCurrency)} has exceeded your agreed credit limit. Kindly settle at your earliest to continue our business relationship.`;
    next_action = { text: actionText, type: 'send_reminder', signal_type: primarySignal === 'credit_exceeded' ? 'risk_alert_credit_exceeded' : 'risk_alert_overdue', source_surface: 'risk_alerts', risk_level, execution_mode: topEntities.length > 1 ? 'bulk' : 'single', entities: topEntities, prefill: topEntities.length === 1 ? { message: escalationMsg, language: language || 'en' } : null };
  }
  const response_text = await narrate({ primarySignal, risk_level, count: topEntities.length, topName: topEntities[0]?.customer_name, topAmount: topEntities[0]?.amount, topRiskReason: topEntities[0]?.risk_reason, daysOverdue: topEntities[0]?.days_overdue || null, severeOverdueCount: Object.keys(severeByCustomer).length, multipleOverdueCount: multipleRisk.length, creditBreachCount: creditRisk.length, currency: orgCurrency }, 'risk_alerts', openai, { language, orgId, supabase });
  console.log('[orgAi]', { fn: 'riskAlerts', ms: Date.now() - start, risk_level, count: topEntities.length, signal: primarySignal });
  return { response_text, chart_data, next_action };
}



// ── FUNCTION 9: Gone Silent ────────────────────────────────────
// Identifies high-value customers who stopped buying (30-90 day window)
// NOT collections — this is revenue decay / relationship reactivation
// Minimum threshold: total >= 1000 to filter noise at scale
// days_silent + last_order_amount enable rich narration and future scoring
// action_log tracks reactivation attempts → future churn scoring via repeated silence
export async function goneSilent(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const thirtyDaysAgo = new Date(todayDate.getTime() - 30 * 86400000).toISOString().split('T')[0];
  const ninetyDaysAgo = new Date(todayDate.getTime() - 90 * 86400000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(todayDate.getTime() - 7 * 86400000).toISOString().split('T')[0];

  // COOLDOWN — 7-day window, reactivation-specific signal
  const { data: recentReactivation } = await supabase.from('action_log').select('entity_id')
    .eq('organisation_id', orgId).eq('entity_type', 'customer')
    .eq('signal_type', 'gone_silent_reactivation').gte('actioned_at', sevenDaysAgo);
  const cooldownReactivation = new Set((recentReactivation || []).map(r => r.entity_id));

  // Customers active in last 30 days — exclude (still buying)
  const { data: recentActiveInvs } = await supabase.from('invoices').select('customer_id')
    .eq('organisation_id', orgId).eq('is_historical', false)
    .gte('issue_date', thirtyDaysAgo).is('deleted_at', null);
  const activeCustomerIds = new Set((recentActiveInvs || []).map(i => i.customer_id));

  // Customers who bought in 30-90 day window — these went silent
  const { data: silentInvs } = await supabase.from('invoices')
    .select('customer_id, total_amount, issue_date')
    .eq('organisation_id', orgId).eq('is_historical', false)
    .gte('issue_date', ninetyDaysAgo).lt('issue_date', thirtyDaysAgo)
    .not('status', 'in', '("draft","cancelled")')
    .gt('total_amount', 0).is('deleted_at', null);

  // Group by customer — compute total value + most recent order
  const silentByCustomer = {};
  for (const inv of silentInvs || []) {
    if (activeCustomerIds.has(inv.customer_id)) continue;
    if (!silentByCustomer[inv.customer_id]) silentByCustomer[inv.customer_id] = { total: 0, last_issue_date: null, last_order_amount: 0 };
    silentByCustomer[inv.customer_id].total += Number(inv.total_amount || 0);
    if (!silentByCustomer[inv.customer_id].last_issue_date || inv.issue_date > silentByCustomer[inv.customer_id].last_issue_date) {
      silentByCustomer[inv.customer_id].last_issue_date = inv.issue_date;
      silentByCustomer[inv.customer_id].last_order_amount = Number(inv.total_amount || 0);
    }
  }

  // Enrich with customer name + phone
  const silentIds = Object.keys(silentByCustomer);
  let custMap = {};
  if (silentIds.length > 0) {
    const { data: custData } = await supabase.from('customers').select('id, name, phone')
      .in('id', silentIds).eq('organisation_id', orgId);
    for (const c of custData || []) custMap[c.id] = c;
  }

  // Build entities — minimum threshold 1000 to filter noise
  // Sort by total historical value (highest lost opportunity first)
  const silentEntities = Object.entries(silentByCustomer)
    .filter(([id, data]) => data.total >= 1000 && !cooldownReactivation.has(id) && custMap[id])
    .map(([id, data]) => {
      const days_silent = Math.floor((todayDate - new Date(`${data.last_issue_date}T00:00:00Z`)) / 86400000);
      return {
        customer_id: id, customer_name: custMap[id].name, customer_phone: custMap[id].phone || null,
        invoice_id: null, invoice_number: '', amount: data.total,
        days_silent, last_order_amount: data.last_order_amount,
      };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const suppressedCount = Object.keys(silentByCustomer).filter(id => cooldownReactivation.has(id)).length;
  const totalSilent = Object.keys(silentByCustomer).filter(([id, data]) => silentByCustomer[id].total >= 1000).length;

  // Chart
  const chart_data = silentEntities.length === 0 ? {
    type: 'insight', title: 'Gone Silent',
    text: suppressedCount > 0
      ? `${suppressedCount} silent customer(s) were recently contacted. Check back in a few days.`
      : 'No recently silent customers. All significant buyers are engaged.',
    level: 'info',
  } : {
    type: 'ranked_list', title: 'Gone Silent', currency: orgCurrency,
    series: silentEntities.map(e => ({ label: e.customer_name, value: e.amount, sublabel: `${e.days_silent} days silent` })),
    highlight: `${silentEntities.length} customer${silentEntities.length > 1 ? 's' : ''} inactive 30+ days`,
    level: 'info',
  };

  // Typed next_action — warm reactivation, not collections
  const othersCount = silentEntities.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';
  let next_action = null;

  if (silentEntities.length === 0) {
    next_action = {
      text: suppressedCount > 0
        ? `${suppressedCount} silent customer(s) were already reached out to recently. Check back in a few days.`
        : 'No silent customers to reactivate. All significant buyers are engaged.',
      type: 'reactivate_customer', signal_type: 'gone_silent_reactivation',
      source_surface: 'gone_silent', execution_mode: null, entities: [], prefill: null,
    };
  } else {
    const topEntity = silentEntities[0];
    next_action = {
      text: `${topEntity.customer_name}${othersStr} ${silentEntities.length > 1 ? 'have' : 'has'} been inactive for ${topEntity.days_silent} days. Last order: ${formatCurrency(topEntity.last_order_amount, orgCurrency)}. Reach out now before the relationship cools further.`,
      type: 'reactivate_customer', signal_type: 'gone_silent_reactivation',
      source_surface: 'gone_silent',
      execution_mode: silentEntities.length > 1 ? 'bulk' : 'single',
      entities: silentEntities,
      prefill: silentEntities.length === 1 ? {
        message: `${topEntity.customer_name}, it has been a while since your last order. We value your business and would love to reconnect — is there anything we can help you with or a new order we can assist you on?`,
        language: language || 'en',
      } : null,
    };
  }

  const response_text = await narrate({
    count: silentEntities.length,
    topName: silentEntities[0]?.customer_name,
    topDaysSilent: silentEntities[0]?.days_silent,
    topLastOrderAmount: silentEntities[0]?.last_order_amount,
    topTotalValue: silentEntities[0]?.amount,
    suppressedCount, totalSilent, currency: orgCurrency,
  }, 'gone_silent', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'goneSilent', ms: Date.now() - start, count: silentEntities.length, suppressed: suppressedCount });
  return { response_text, chart_data, next_action };
}



// -- FUNCTION 10: Top Sellers
export async function topSellers(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const rangeStart = monthStartIST();
  const today = todayIST();
  const sevenDaysAgo = new Date(new Date(today + 'T00:00:00Z').getTime() - 7 * 86400000).toISOString().split('T')[0];
  const { data: recentOutreach } = await supabase.from('action_log').select('entity_id').eq('organisation_id', orgId).eq('entity_type', 'customer').eq('signal_type', 'product_momentum_outreach').gte('actioned_at', sevenDaysAgo);
  const cooldownOutreach = new Set((recentOutreach || []).map(r => r.entity_id));
  const { data: monthInvoices } = await supabase.from('invoices').select('id, customer_id').eq('organisation_id', orgId).eq('is_historical', false).gte('issue_date', rangeStart).not('status', 'in', '("draft","cancelled")').is('deleted_at', null);
  const invoiceIds = (monthInvoices || []).map(i => i.id);
  const invoiceCustomerMap = {};
  for (const inv of monthInvoices || []) invoiceCustomerMap[inv.id] = inv.customer_id;
  const productTotals = {};
  if (invoiceIds.length > 0) {
    const { data: items } = await supabase.from('invoice_items').select('product_id, description, quantity, line_total, invoice_id').eq('organisation_id', orgId).in('invoice_id', invoiceIds).is('deleted_at', null);
    for (const item of items || []) {
      const key = item.product_id || ('desc:' + item.description);
      if (!productTotals[key]) productTotals[key] = { product_id: item.product_id || null, name: item.description, revenue: 0, units_sold: 0, customer_ids: new Set() };
      productTotals[key].revenue += Number(item.line_total || 0);
      productTotals[key].units_sold += Number(item.quantity || 0);
      const custId = invoiceCustomerMap[item.invoice_id];
      if (custId) productTotals[key].customer_ids.add(custId);
    }
  }
  const linkedProductIds = Object.values(productTotals).map(p => p.product_id).filter(Boolean);
  if (linkedProductIds.length > 0) {
    const { data: prodData } = await supabase.from('products').select('id, name, category').in('id', linkedProductIds).eq('organisation_id', orgId);
    for (const prod of prodData || []) { if (productTotals[prod.id]) productTotals[prod.id].name = prod.name; }
  }
  const rankedProducts = Object.values(productTotals)
    .map(p => ({ product_id: p.product_id, name: p.name, revenue: p.revenue, units_sold: p.units_sold, unique_customer_count: p.customer_ids.size }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  let reactivationEntities = [];
  if (rankedProducts.length > 0 && rankedProducts[0].product_id) {
    const topProductId = rankedProducts[0].product_id;
    const { data: historicalItems } = await supabase.from('invoice_items').select('invoice_id').eq('organisation_id', orgId).eq('product_id', topProductId).is('deleted_at', null);
    const historicalInvoiceIds = (historicalItems || []).map(i => i.invoice_id);
    if (historicalInvoiceIds.length > 0) {
      const { data: historicalInvs } = await supabase.from('invoices').select('customer_id').eq('organisation_id', orgId).in('id', historicalInvoiceIds).is('deleted_at', null);
      const allBuyers = new Set((historicalInvs || []).map(i => i.customer_id));
      const thisMonthBuyerIds = new Set((monthInvoices || []).map(i => i.customer_id));
      const lapsedBuyerIds = [...allBuyers].filter(id => !thisMonthBuyerIds.has(id) && !cooldownOutreach.has(id));
      if (lapsedBuyerIds.length > 0) {
        const { data: lapsedCusts } = await supabase.from('customers').select('id, name, phone').in('id', lapsedBuyerIds).eq('organisation_id', orgId);
        reactivationEntities = (lapsedCusts || []).slice(0, 5).map(c => ({ customer_id: c.id, customer_name: c.name, customer_phone: c.phone || null, invoice_id: null, invoice_number: '', amount: 0 }));
      }
    }
  }
  const totalRevenue = rankedProducts.reduce((s, p) => s + p.revenue, 0);
  const chart_data = rankedProducts.length === 0
    ? { type: 'insight', title: 'Top Sellers', text: 'No product sales recorded this month.', level: 'info' }
    : { type: 'ranked_list', title: 'Top Sellers This Month', currency: orgCurrency, series: rankedProducts.map(p => ({ label: p.name, value: p.revenue, sublabel: Math.round(p.units_sold) + ' units' })), highlight: formatCurrency(totalRevenue, orgCurrency) + ' total from ' + rankedProducts.length + ' product' + (rankedProducts.length !== 1 ? 's' : ''), level: 'info' };
  const topProduct = rankedProducts[0];
  let next_action = null;
  if (rankedProducts.length === 0) {
    next_action = { text: 'No product sales this month.', type: 'create_quote', signal_type: 'product_momentum_outreach', source_surface: 'top_sellers', execution_mode: null, entities: [], prefill: null };
  } else if (reactivationEntities.length > 0) {
    const othersCount = reactivationEntities.length - 1;
    const othersStr = othersCount > 0 ? ' and ' + othersCount + ' other' + (othersCount > 1 ? 's' : '') : '';
    next_action = { text: topProduct.name + ' is your top product. ' + reactivationEntities[0].customer_name + othersStr + ' bought it before but not this month — reach out now.', type: 'reactivate_customer', signal_type: 'product_momentum_outreach', source_surface: 'top_sellers', execution_mode: reactivationEntities.length > 1 ? 'bulk' : 'single', entities: reactivationEntities, prefill: reactivationEntities.length === 1 ? { message: reactivationEntities[0].customer_name + ', ' + topProduct.name + ' is moving well this month. Would you like to place your next order?', language: language || 'en' } : null };
  } else {
    next_action = { text: topProduct.name + ' leads with ' + formatCurrency(topProduct.revenue, orgCurrency) + ' and ' + Math.round(topProduct.units_sold) + ' units. Create new quotes to keep the momentum.', type: 'create_quote', signal_type: 'product_momentum_outreach', source_surface: 'top_sellers', execution_mode: null, entities: [], prefill: null };
  }
  const response_text = await narrate({ count: rankedProducts.length, topProductName: topProduct?.name, topProductRevenue: topProduct?.revenue, topProductUnits: topProduct ? Math.round(topProduct.units_sold) : 0, topProductBuyers: topProduct?.unique_customer_count, lapsedBuyerCount: reactivationEntities.length, lapsedBuyerName: reactivationEntities[0]?.customer_name, totalRevenue, currency: orgCurrency }, 'top_sellers', openai, { language, orgId, supabase });
  console.log('[orgAi]', { fn: 'topSellers', ms: Date.now() - start, products: rankedProducts.length, lapsedBuyers: reactivationEntities.length });
  return { response_text, chart_data, next_action };
}



// -- FUNCTION 11: Low Stock
// Flags products at or below reorder_point with track_inventory=true
// Severity = qty/reorder_point ratio (lower = more critical)
// Entities reuse customer fields for supplier (v1 pragmatic reuse of ActionExecutionModal)
// TODO: add entity_type:'supplier' when ActionExecutionModal supports non-customer entities
export async function lowStock(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const { data: allInv } = await supabase
    .from('inventory').select('product_id, quantity, reorder_point, reorder_qty')
    .eq('organisation_id', orgId).gt('reorder_point', 0).is('deleted_at', null);
  const lowInvItems = (allInv || []).filter(i => Number(i.quantity) <= Number(i.reorder_point));
  if (lowInvItems.length === 0) {
    const response_text = await narrate({ count: 0, topProductName: null, topQty: null, topReorderPoint: null, currency: orgCurrency }, 'low_stock', openai, { language, orgId, supabase });
    return {
      response_text,
      chart_data: { type: 'insight', title: 'Low Stock', text: 'All products are adequately stocked. No reorder action required.', level: 'info' },
      next_action: { text: 'All products are adequately stocked. No reorder needed.', type: 'create_purchase_order', signal_type: 'low_stock_reorder', source_surface: 'low_stock', execution_mode: null, entities: [], prefill: null },
    };
  }
  const productIds = lowInvItems.map(i => i.product_id);
  const { data: products } = await supabase
    .from('products').select('id, name, category, unit')
    .in('id', productIds).eq('organisation_id', orgId)
    .eq('is_active', true).eq('track_inventory', true).is('deleted_at', null);
  const productMap = {};
  for (const p of products || []) productMap[p.id] = p;
  const { data: supplierProducts } = await supabase
    .from('supplier_products').select('product_id, supplier_id, lead_time_days, min_order_qty, is_preferred')
    .eq('organisation_id', orgId).in('product_id', productIds).is('deleted_at', null);
  const supplierByProduct = {};
  for (const sp of supplierProducts || []) {
    if (!supplierByProduct[sp.product_id] || sp.is_preferred) supplierByProduct[sp.product_id] = sp;
  }
  const supplierIds = [...new Set(Object.values(supplierByProduct).map(sp => sp.supplier_id))];
  const supplierMap = {};
  if (supplierIds.length > 0) {
    const { data: suppliers } = await supabase
      .from('suppliers').select('id, name, phone')
      .in('id', supplierIds).eq('organisation_id', orgId);
    for (const s of suppliers || []) supplierMap[s.id] = s;
  }
  const lowStockItems = lowInvItems
    .filter(i => productMap[i.product_id])
    .map(i => {
      const product = productMap[i.product_id];
      const sp = supplierByProduct[i.product_id];
      const supplier = sp ? supplierMap[sp.supplier_id] : null;
      const qty = Number(i.quantity);
      const reorderPoint = Number(i.reorder_point);
      const reorderQty = Number(i.reorder_qty) || reorderPoint * 2;
      return {
        product_id: i.product_id, product_name: product.name,
        category: product.category, unit: product.unit,
        quantity: qty, reorder_point: reorderPoint, reorder_qty: reorderQty,
        severity: reorderPoint > 0 ? qty / reorderPoint : 0,
        supplier_id: supplier?.id || null, supplier_name: supplier?.name || null,
        supplier_phone: supplier?.phone || null, lead_time_days: sp?.lead_time_days || 0,
      };
    })
    .sort((a, b) => a.severity - b.severity)
    .slice(0, 5);
  const chart_data = {
    type: 'ranked_list', title: 'Low Stock Alert', currency: null,
    series: lowStockItems.map(i => ({ label: i.product_name, value: i.quantity, sublabel: i.quantity + ' ' + i.unit + ' left \u00b7 reorder at ' + i.reorder_point })),
    highlight: lowStockItems.length + ' product' + (lowStockItems.length !== 1 ? 's' : '') + ' need reordering',
    level: 'warning',
  };
  const supplierEntities = lowStockItems
    .filter(i => i.supplier_id)
    .map(i => ({
      customer_id: i.supplier_id, customer_name: i.supplier_name,
      customer_phone: i.supplier_phone, invoice_id: null,
      invoice_number: i.product_name, amount: i.reorder_qty,
    }));
  const topItem = lowStockItems[0];
  const othersCount = lowStockItems.length - 1;
  const othersStr = othersCount > 0 ? ' and ' + othersCount + ' other' + (othersCount > 1 ? 's' : '') : '';
  const next_action = {
    text: topItem.product_name + othersStr + ' ' + (lowStockItems.length > 1 ? 'are' : 'is') + ' below reorder point. ' + (topItem.supplier_name ? 'Contact ' + topItem.supplier_name + ' to reorder.' : 'Place a reorder immediately.'),
    type: 'create_purchase_order', signal_type: 'low_stock_reorder', source_surface: 'low_stock',
    execution_mode: supplierEntities.length > 1 ? 'bulk' : supplierEntities.length === 1 ? 'single' : null,
    entities: supplierEntities,
    prefill: supplierEntities.length === 1 ? {
      message: supplierEntities[0].customer_name + ', we need to reorder ' + supplierEntities[0].invoice_number + '. Current stock is critically low. Please confirm availability of ' + supplierEntities[0].amount + ' units.',
      language: language || 'en',
    } : null,
  };
  const response_text = await narrate({
    count: lowStockItems.length, topProductName: topItem?.product_name,
    topQty: topItem?.quantity, topReorderPoint: topItem?.reorder_point,
    topSupplierName: topItem?.supplier_name, topLeadTime: topItem?.lead_time_days,
    currency: orgCurrency,
  }, 'low_stock', openai, { language, orgId, supabase });
  console.log('[orgAi]', { fn: 'lowStock', ms: Date.now() - start, count: lowStockItems.length });
  return { response_text, chart_data, next_action };
}



// ── whatIOwe ─────────────────────────────────────────────────
// Total outstanding payables across all entities with purchase bills.
// Grouped by entity, sorted by oldest due date first.
// Gives owner their daily "what do I need to pay today" view.
export async function whatIOwe(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();

  const { data: bills } = await supabase
    .from('purchase_bills')
    .select('customer_id, amount_due, total_amount, due_date, status')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .is('deleted_at', null)
    .not('customer_id', 'is', null)
    .not('status', 'in', '("paid","cancelled")')
    .gt('amount_due', 0);

  const allBills = bills || [];

  if (allBills.length === 0) {
    const response_text = await narrate({ total: 0, count: 0, overdueCount: 0, currency: orgCurrency }, 'what_i_owe', openai, { language, orgId, supabase });
    return {
      response_text,
      chart_data: { type: 'insight', title: 'What I Owe', text: 'No outstanding payables. All supplier bills are settled.', level: 'info' },
      next_action: { text: 'No outstanding payables. All supplier bills are settled.', type: 'none', signal_type: 'proactive_collection', source_surface: 'what_i_owe', execution_mode: null, entities: [], prefill: null },
    };
  }

  const byEntity = {};
  for (const bill of allBills) {
    const cid = bill.customer_id;
    if (!byEntity[cid]) byEntity[cid] = { amount_due: 0, oldest_due_date: null, bill_count: 0 };
    byEntity[cid].amount_due = Math.round((byEntity[cid].amount_due + Number(bill.amount_due)) * 100) / 100;
    byEntity[cid].bill_count++;
    if (!byEntity[cid].oldest_due_date || (bill.due_date && bill.due_date < byEntity[cid].oldest_due_date)) {
      byEntity[cid].oldest_due_date = bill.due_date;
    }
  }

  const entityIds = Object.keys(byEntity);
  const { data: customers } = await supabase
    .from('customers').select('id, name, phone')
    .in('id', entityIds).eq('organisation_id', orgId);
  const custMap = {};
  for (const c of customers || []) custMap[c.id] = c;

  const totalOwed = Object.values(byEntity).reduce((s, e) => s + e.amount_due, 0);
  const overdueCount = allBills.filter(b => b.due_date && b.due_date < today).length;

  const entries = Object.entries(byEntity)
    .filter(([id]) => custMap[id])
    .map(([id, data]) => ({
      customer_id: id,
      customer_name: custMap[id].name,
      customer_phone: custMap[id].phone || null,
      invoice_id: null, invoice_number: '',
      amount: data.amount_due,
      oldest_due_date: data.oldest_due_date,
      bill_count: data.bill_count,
    }))
    .sort((a, b) => {
      if (!a.oldest_due_date) return 1;
      if (!b.oldest_due_date) return -1;
      return a.oldest_due_date.localeCompare(b.oldest_due_date);
    })
    .slice(0, 5);

  const chart_data = {
    type: 'ranked_list', title: 'What I Owe', currency: orgCurrency,
    series: entries.map(e => ({
      label: e.customer_name,
      value: e.amount,
      sublabel: e.oldest_due_date
        ? (e.oldest_due_date < today ? `Overdue since ${e.oldest_due_date}` : `Due ${e.oldest_due_date}`)
        : `${e.bill_count} bill(s)`,
    })),
    highlight: `${formatCurrency(Math.round(totalOwed * 100) / 100, orgCurrency)} total payable`,
    level: overdueCount > 0 ? 'warning' : 'info',
  };

  const topEntity = entries[0];
  const othersCount = entries.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';

  const next_action = {
    text: `${topEntity.customer_name}${othersStr} — ${formatCurrency(Math.round(totalOwed * 100) / 100, orgCurrency)} total outstanding. ${overdueCount > 0 ? `${overdueCount} bill(s) are overdue.` : ''}`,
    type: 'record_supplier_payment',
    signal_type: 'overdue_collection',
    source_surface: 'what_i_owe',
    execution_mode: entries.length > 1 ? 'bulk' : 'single',
    entities: entries,
    prefill: null,
  };

  const response_text = await narrate({
    total: formatCurrency(Math.round(totalOwed * 100) / 100, orgCurrency),
    count: entries.length,
    overdueCount,
    topName: topEntity?.customer_name,
    currency: orgCurrency,
  }, 'what_i_owe', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'whatIOwe', ms: Date.now() - start, count: entries.length, total: totalOwed });
  return { response_text, chart_data, next_action };
}

// ── overduePayables ───────────────────────────────────────────
// Purchase bills past their due date. Shows who owner is late paying
// and by how many days — suppliers at risk of cutting off supply.
export async function overduePayables(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();

  const { data: bills } = await supabase
    .from('purchase_bills')
    .select('customer_id, amount_due, total_amount, due_date, bill_number, status')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .is('deleted_at', null)
    .not('customer_id', 'is', null)
    .not('status', 'in', '("paid","cancelled")')
    .gt('amount_due', 0)
    .lt('due_date', today);

  const overdueBills = bills || [];

  if (overdueBills.length === 0) {
    const response_text = await narrate({ count: 0, topName: null, currency: orgCurrency }, 'overdue_payables', openai, { language, orgId, supabase });
    return {
      response_text,
      chart_data: { type: 'insight', title: 'Overdue Payables', text: 'No overdue supplier bills. All payables are within terms.', level: 'info' },
      next_action: { text: 'No overdue supplier bills. All payables are within terms.', type: 'none', signal_type: 'overdue_collection', source_surface: 'overdue_payables', execution_mode: null, entities: [], prefill: null },
    };
  }

  const byEntity = {};
  const todayDate = new Date(`${today}T00:00:00Z`);
  for (const bill of overdueBills) {
    const cid = bill.customer_id;
    const daysOverdue = bill.due_date
      ? Math.floor((todayDate - new Date(`${bill.due_date}T00:00:00Z`)) / 86400000)
      : 0;
    if (!byEntity[cid]) byEntity[cid] = { amount_due: 0, max_days_overdue: 0, bill_count: 0 };
    byEntity[cid].amount_due = Math.round((byEntity[cid].amount_due + Number(bill.amount_due)) * 100) / 100;
    byEntity[cid].bill_count++;
    if (daysOverdue > byEntity[cid].max_days_overdue) byEntity[cid].max_days_overdue = daysOverdue;
  }

  const entityIds = Object.keys(byEntity);
  const { data: customers } = await supabase
    .from('customers').select('id, name, phone')
    .in('id', entityIds).eq('organisation_id', orgId);
  const custMap = {};
  for (const c of customers || []) custMap[c.id] = c;

  const entries = Object.entries(byEntity)
    .filter(([id]) => custMap[id])
    .map(([id, data]) => ({
      customer_id: id,
      customer_name: custMap[id].name,
      customer_phone: custMap[id].phone || null,
      invoice_id: null, invoice_number: '',
      amount: data.amount_due,
      days_overdue: data.max_days_overdue,
      bill_count: data.bill_count,
    }))
    .sort((a, b) => b.days_overdue - a.days_overdue)
    .slice(0, 5);

  const chart_data = {
    type: 'risk_list', title: 'Overdue Payables', currency: orgCurrency,
    series: entries.map(e => ({
      label: e.customer_name,
      value: e.amount,
      sublabel: `${e.days_overdue} days overdue`,
      risk_level: e.days_overdue > 30 ? 'danger' : 'warning',
    })),
    highlight: `${entries.length} supplier${entries.length > 1 ? 's' : ''} with overdue bills`,
    level: 'warning',
  };

  const topEntity = entries[0];
  const othersCount = entries.length - 1;
  const othersStr = othersCount > 0 ? ` and ${othersCount} other${othersCount > 1 ? 's' : ''}` : '';

  const next_action = {
    text: `${topEntity.customer_name}${othersStr} — payment overdue by ${topEntity.days_overdue} days. Pay now to protect supply relationships.`,
    type: 'record_supplier_payment',
    signal_type: 'overdue_collection',
    source_surface: 'overdue_payables',
    execution_mode: entries.length > 1 ? 'bulk' : 'single',
    entities: entries,
    prefill: null,
  };

  const response_text = await narrate({
    count: entries.length,
    topName: topEntity?.customer_name,
    topDaysOverdue: topEntity?.days_overdue,
    topAmount: formatCurrency(topEntity?.amount, orgCurrency),
    currency: orgCurrency,
  }, 'overdue_payables', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'overduePayables', ms: Date.now() - start, count: entries.length });
  return { response_text, chart_data, next_action };
}

// ── topSupplier ───────────────────────────────────────────────
// Who the owner buys from most by total purchase value this month.
// Identifies which supplier relationships are most critical to protect.
export async function topSupplier(supabase, orgId, orgCurrency, openai, language = 'en') {
  const start = Date.now();
  const today = todayIST();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const thirtyDaysAgo = new Date(todayDate.getTime() - 30 * 86400000).toISOString().split('T')[0];

  const { data: bills } = await supabase
    .from('purchase_bills')
    .select('customer_id, total_amount, issue_date')
    .eq('organisation_id', orgId)
    .eq('is_historical', false)
    .is('deleted_at', null)
    .not('customer_id', 'is', null)
    .gte('issue_date', thirtyDaysAgo);

  const allBills = bills || [];

  if (allBills.length === 0) {
    const response_text = await narrate({ topName: null, currency: orgCurrency }, 'top_supplier', openai, { language, orgId, supabase });
    return {
      response_text,
      chart_data: { type: 'insight', title: 'Top Supplier', text: 'No purchase bills recorded this month.', level: 'info' },
      next_action: { text: 'No purchase bills recorded this month.', type: 'none', signal_type: 'low_stock_reorder', source_surface: 'top_supplier', execution_mode: null, entities: [], prefill: null },
    };
  }

  const byEntity = {};
  for (const bill of allBills) {
    const cid = bill.customer_id;
    if (!byEntity[cid]) byEntity[cid] = { total: 0, bill_count: 0, last_purchase_date: null };
    byEntity[cid].total = Math.round((byEntity[cid].total + Number(bill.total_amount)) * 100) / 100;
    byEntity[cid].bill_count++;
    if (!byEntity[cid].last_purchase_date || bill.issue_date > byEntity[cid].last_purchase_date) {
      byEntity[cid].last_purchase_date = bill.issue_date;
    }
  }

  const entityIds = Object.keys(byEntity);
  const { data: customers } = await supabase
    .from('customers').select('id, name, phone')
    .in('id', entityIds).eq('organisation_id', orgId);
  const custMap = {};
  for (const c of customers || []) custMap[c.id] = c;

  const entries = Object.entries(byEntity)
    .filter(([id]) => custMap[id])
    .map(([id, data]) => ({
      customer_id: id,
      customer_name: custMap[id].name,
      customer_phone: custMap[id].phone || null,
      invoice_id: null, invoice_number: '',
      amount: data.total,
      bill_count: data.bill_count,
      last_purchase_date: data.last_purchase_date,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const topEntity = entries[0];

  const chart_data = {
    type: 'ranked_list', title: 'Top Suppliers (30 days)', currency: orgCurrency,
    series: entries.map(e => ({
      label: e.customer_name,
      value: e.amount,
      sublabel: `${e.bill_count} bill${e.bill_count > 1 ? 's' : ''} · last ${e.last_purchase_date}`,
    })),
    highlight: `${entries.length} supplier${entries.length > 1 ? 's' : ''} this month`,
    level: 'info',
  };

  const next_action = {
    text: `${topEntity.customer_name} is your top supplier this month at ${formatCurrency(topEntity.amount, orgCurrency)}.`,
    type: 'none',
    signal_type: 'low_stock_reorder',
    source_surface: 'top_supplier',
    execution_mode: null,
    entities: entries,
    prefill: null,
  };

  const response_text = await narrate({
    topName: topEntity?.customer_name,
    topAmount: formatCurrency(topEntity?.amount, orgCurrency),
    topBillCount: topEntity?.bill_count,
    count: entries.length,
    currency: orgCurrency,
  }, 'top_supplier', openai, { language, orgId, supabase });

  console.log('[orgAi]', { fn: 'topSupplier', ms: Date.now() - start, count: entries.length });
  return { response_text, chart_data, next_action };
}

// ── Dispatcher ────────────────────────────────────────────────
// Single entry point for all menu queries.
// message_type injected here — individual functions do not set it.
export async function dispatchMenuQuery(menuId, supabase, orgId, orgCurrency, openai, language = 'en') {
  let result;

  switch (menuId) {
    // Session A — implemented
    case 'collections_today':  result = await collectionsToday(supabase, orgId, orgCurrency, openai, language); break;
    case 'total_outstanding':  result = await totalOutstanding(supabase, orgId, orgCurrency, openai, language); break;
    case 'top_customers':      result = await topCustomers(supabase, orgId, orgCurrency, openai, language); break;

    // Session B — Finance
    case 'revenue_this_month': result = await revenueThisMonth(supabase, orgId, orgCurrency, openai, language); break;
    case 'invoices_due_this_week': result = await invoicesDueThisWeek(supabase, orgId, orgCurrency, openai, language); break;
    case 'weekly_trend': result = await weeklyTrend(supabase, orgId, orgCurrency, openai, language); break;
    // Session B — Customers
    case 'follow_up_today': result = await followUpToday(supabase, orgId, orgCurrency, openai, language); break;
    case 'risk_alerts': result = await riskAlerts(supabase, orgId, orgCurrency, openai, language); break;
    case 'gone_silent': result = await goneSilent(supabase, orgId, orgCurrency, openai, language); break;
    // Session B — Products
    case 'top_sellers': result = await topSellers(supabase, orgId, orgCurrency, openai, language); break;
    case 'low_stock': result = await lowStock(supabase, orgId, orgCurrency, openai, language); break;
    case 'slow_moving':
    // Session B — Ops
    case 'deliveries_today':
    case 'expiring_quotes':
    case 'todays_tasks':
    // Session F — Suppliers
    case 'what_i_owe': result = await whatIOwe(supabase, orgId, orgCurrency, openai, language); break;
    case 'overdue_payables': result = await overduePayables(supabase, orgId, orgCurrency, openai, language); break;
    case 'top_supplier': result = await topSupplier(supabase, orgId, orgCurrency, openai, language); break;

    default:
      result = {
        response_text: 'I did not recognise that request. Please try again.',
        chart_data: null,
        next_action: null,
      };
  }

  return { ...result, message_type: 'ai_response' };
}
