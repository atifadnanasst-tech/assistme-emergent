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
    { language }
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
      type: 'create_quote', execution_mode: null, entities: [], prefill: null,
    };
  } else if (overdueCount > 0) {
    next_action = {
      text: `${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue. ${outstandingEntities[0]?.customer_name}${othersStr} — send reminders immediately.`,
      type: 'send_reminder',
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
  }, 'total_outstanding', openai, { language });
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

  // Step 3: Fetch names for top 5 only (separate query)
  let ranked = [];
  if (topIds.length > 0) {
    const { data: custNames } = await supabase
      .from('customers')
      .select('id, name')
      .in('id', topIds);

    ranked = topIds.map(id => ({
      name: custNames?.find(c => c.id === id)?.name || 'Unknown',
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

  // Step 5: Nudge — concentration uses grandTotal (all org revenue, not just top 5)
  let next_action = null;
  if (ranked.length === 0) {
    next_action = { text: 'No sales this month yet. Create your first invoice to get started.' };
  } else if (grandTotal > 0 && ranked[0].total / grandTotal > 0.5) {
    next_action = { text: `${ranked[0].name} is over 50% of your revenue. Consider growing other accounts.` };
  } else {
    next_action = { text: `Follow up with ${ranked[0]?.name} to maintain the momentum.` };
  }

  // Step 6: GPT narration
  const response_text = await narrate({
    ranked: ranked.slice(0, 3),
    grandTotal,
    currency: orgCurrency,
    topName: ranked[0]?.name,
    topAmount: ranked[0]?.total,
  }, 'top_customers', openai, { language });

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
  }, 'revenue_this_month', openai, { language });

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
  }, 'invoices_due_this_week', openai, { language });

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
    execution_mode: targetEntities.length > 1 ? 'bulk' : targetEntities.length === 1 ? 'single' : null,
    entities: targetEntities,
    prefill: targetEntities.length === 1 ? { message: targetEntities[0].message, language: language || 'en' } : null,
  };

  const response_text = await narrate({
    direction, changePct, thisWeekTotal, lastWeekTotal, weeksOfData: weekSeries.length,
    topProducts: topProducts.map(p => ({ name: p.name, total: p.total })),
    dormantCount: dormantCustomers.length, dormantNames: dormantCustomers.map(c => c.customer_name),
    currency: orgCurrency,
  }, 'weekly_trend', openai, { language });

  console.log('[orgAi]', { fn: 'weeklyTrend', ms: Date.now() - start, weeks: weekSeries.length, dormant: dormantCustomers.length });
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
    case 'follow_up_today':
    case 'risk_alerts':
    case 'gone_silent':
    // Session B — Products
    case 'top_sellers':
    case 'low_stock':
    case 'slow_moving':
    // Session B — Ops
    case 'deliveries_today':
    case 'expiring_quotes':
    case 'todays_tasks':
    // Session B — Suppliers
    case 'what_i_owe':
    case 'overdue_payables':
    case 'top_supplier':
      result = {
        response_text: 'This feature is coming soon. Use the text input below to ask anything about your business.',
        chart_data: null,
        next_action: null,
      };
      break;

    default:
      result = {
        response_text: 'I did not recognise that request. Please try again.',
        chart_data: null,
        next_action: null,
      };
  }

  return { ...result, message_type: 'ai_response' };
}
