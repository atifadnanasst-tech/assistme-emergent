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
export async function collectionsToday(supabase, orgId, orgCurrency, openai) {
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

  // Step 4: Nudge — rules engine, never GPT
  let next_action = null;
  if (count === 0) {
    next_action = { text: 'No collections yet today. Send payment reminders to your overdue customers.' };
  } else if (total < 10000) {
    next_action = { text: `Only ${formatCurrency(total, orgCurrency)} collected. Chase your top outstanding customers.` };
  } else {
    next_action = { text: "Good collection day. Check tomorrow's pending deliveries." };
  }

  // Step 5: GPT narration — always last, never blocks core response
  const response_text = await narrate(
    { total, count, topPayerName, currency: orgCurrency },
    'collections_today',
    openai
  );

  console.log('[orgAi]', { fn: 'collectionsToday', ms: Date.now() - start, rows: count });
  return { response_text, chart_data, next_action };
}

// ── FUNCTION 2: Total Outstanding ─────────────────────────────
export async function totalOutstanding(supabase, orgId, orgCurrency, openai) {
  const start = Date.now();

  // Step 1: Top 5 customers by outstanding (for chart display)
  const { data: topCustomers, error: custErr } = await supabase
    .from('customers')
    .select('id, name, outstanding_balance')
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
    .in('status', ['sent', 'viewed', 'partial', 'overdue'])
    .lt('due_date', todayIST());

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

  // Step 5: Nudge — rules engine
  let next_action = null;
  if (count === 0) {
    next_action = { text: 'All accounts clear. Great financial health.' };
  } else if (overdueCount > 5) {
    next_action = { text: `${overdueCount} invoices are overdue. Send bulk reminders now.` };
  } else if (topCustomers && topCustomers.length > 0) {
    next_action = { text: `Call ${topCustomers[0].name} first — ${formatCurrency(topCustomers[0].outstanding_balance, orgCurrency)} outstanding.` };
  }

  // Step 6: GPT narration
  const response_text = await narrate({
    total, count, overdueCount, currency: orgCurrency,
    topCustomers: (topCustomers || []).slice(0, 3).map(c => ({
      name: c.name, amount: c.outstanding_balance,
    })),
  }, 'total_outstanding', openai);

  console.log('[orgAi] totalOutstanding ms=' + (Date.now() - start));
  return { response_text, chart_data, next_action };
}

// ── FUNCTION 3: Top Customers ─────────────────────────────────
export async function topCustomers(supabase, orgId, orgCurrency, openai) {
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
  }, 'top_customers', openai);

  console.log('[orgAi] topCustomers ms=' + (Date.now() - start));
  return { response_text, chart_data, next_action };
}


// ── FINANCIAL PRIMITIVES ──────────────────────────────────────
// Section marker — all functions below are financial intelligence primitives.
// When extracting to /engines/financial/, move entire section together.

// ── FUNCTION 4: Revenue This Month ───────────────────────────
export async function revenueThisMonth(supabase, orgId, orgCurrency, openai) {
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

  // Step 5: Nudge — deterministic rules engine, percentages computed above (never by GPT)
  let next_action = null;
  if (invoiceCount === 0) {
    next_action = { text: 'No invoices this month yet. Create your first invoice to get started.' };
  } else if (topCustomerName && topCustomerPct > 50) {
    next_action = { text: `${topCustomerName} contributed ${topCustomerPct}% of this month's revenue (${formatCurrency(topCustomerRevenue, orgCurrency)}). Consider reducing concentration risk.` };
  } else {
    next_action = { text: `${formatCurrency(totalRevenue, orgCurrency)} billed across ${invoiceCount} invoice${invoiceCount !== 1 ? 's' : ''} this month. Keep the momentum going.` };
  }

  // Step 6: GPT narration — receives frozen computed truth, never raw rows
  const response_text = await narrate({
    totalRevenue, invoiceCount, avgInvoiceValue,
    topCustomerName, topCustomerRevenue, topCustomerPct,
    currency: orgCurrency,
  }, 'revenue_this_month', openai);

  console.log('[orgAi]', { fn: 'revenueThisMonth', ms: Date.now() - start, rows: invoiceCount });
  return { response_text, chart_data, next_action };
}

// ── Dispatcher ────────────────────────────────────────────────
// Single entry point for all menu queries.
// message_type injected here — individual functions do not set it.
export async function dispatchMenuQuery(menuId, supabase, orgId, orgCurrency, openai) {
  let result;

  switch (menuId) {
    // Session A — implemented
    case 'collections_today':  result = await collectionsToday(supabase, orgId, orgCurrency, openai); break;
    case 'total_outstanding':  result = await totalOutstanding(supabase, orgId, orgCurrency, openai); break;
    case 'top_customers':      result = await topCustomers(supabase, orgId, orgCurrency, openai); break;

    // Session B — Finance
    case 'revenue_this_month': result = await revenueThisMonth(supabase, orgId, orgCurrency, openai); break;
    case 'invoices_due_this_week':
    case 'weekly_trend':
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
