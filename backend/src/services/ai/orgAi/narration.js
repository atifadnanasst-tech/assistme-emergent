/**
 * AssistMe — Org AI Narration Engine
 * Location: /services/ai/orgAi/narration.js
 * Single narration function for all org AI functions.
 * Never throws — always returns fallback on any failure.
 */

const PROMPTS = {
  collections_today:      'You are a business assistant for an MSME trader. Summarize this collections data in 2-3 short lines. Lead with the total collected. Mention the top payer if present. Be specific with numbers. No preamble.',
  total_outstanding:      'You are a business assistant for an MSME trader. Summarize this outstanding balance data in 2-3 short lines. Lead with the most urgent insight. No preamble.',
  top_customers:          'You are a business assistant for an MSME trader. Summarize who the top customers are by REVENUE (total invoiced this month) in 2-3 short lines. This is revenue, NOT outstanding balance or amount owed -- never use the words "outstanding", "owe", "owes", "balance", or "due" anywhere in your response. Be specific with numbers. No preamble.',
  revenue_this_month:     'You are a business assistant for an MSME trader. Summarize this month\'s revenue in 2-3 short lines. Lead with total billed. No preamble.',
  invoices_due_this_week: 'You are a business assistant for an MSME trader. The trader has raised these invoices and customers OWE the trader money — the trader is the seller who needs to collect payment. Summarize which customer invoices are due this week in 2-3 lines. Lead with urgency. Name the top customer who owes. No preamble.',
  weekly_trend:           'You are a sharp business assistant for an MSME trader. Write 2-3 short paragraphs. Each paragraph contains one operational idea only. First: collections direction, amount, and % change. Second: top moving products if present. Third: one specific action naming a customer or product. Keep tone executive and urgent. No markdown, no bullets, no asterisks, no formatting symbols. Sound like a smart business operator, not a report generator. Grounded ONLY in provided data.',
  follow_up_today:        'You are a CFO briefing the business owner. Be crisp, direct, reporting — not explaining. 2-3 short sentences maximum. Report the signal (overdue/due-soon/expiring quotes), top customer name and amount. If customers were already reminded recently, say so naturally using their names — never use words like cooldown, suppressed, or period. If all are already handled, report that clearly and suggest what to do next. No preamble, no markdown, no verbose explanations. Grounded ONLY in provided data.',
  risk_alerts:            'You are a CFO briefing the business owner on financial risk. Maximum 2-3 crisp sentences. State the risk signal type (severely overdue/credit exceeded/multiple unpaid), name the highest-risk customer, state the amount and days overdue or credit breach. Recommend escalation — not a reminder, an escalation. No preamble, no markdown, no hedging. Grounded ONLY in provided data.',
  gone_silent:            'You are a CFO briefing the business owner on revenue recovery opportunities. 2-3 crisp sentences. Name the highest-value silent customer, how many days they have been inactive, and their last order amount. Frame this as a commercial opportunity — warm, not punitive. Recommend specific outreach. No preamble, no markdown. Grounded ONLY in provided data.',
  top_sellers:            'You are a commercial operator briefing the business owner. 2-3 crisp sentences. Name the top product, its revenue and units sold this month. Identify the commercial opportunity — which customers should be targeted for more orders of this product. Sound like a sales head, not an analyst. No preamble, no markdown. Grounded ONLY in provided data.',
  low_stock:              'You are an inventory controller briefing the business owner. 2-3 crisp sentences. Name the most critical low-stock product, current quantity vs reorder point. Frame as operational urgency — stockout means lost sales. No preamble, no markdown. Grounded ONLY in provided data.',
  slow_moving:            'You are a business assistant for an MSME trader. Summarize slow-moving stock in 2-3 lines. No preamble.',
  deliveries_today:       'You are a business assistant for an MSME trader. Summarize delivery tasks for today in 2-3 lines. Lead with pending count. No preamble.',
  expiring_quotes:        'You are a business assistant for an MSME trader. Summarize expiring quotes in 2-3 lines. Lead with most urgent. No preamble.',
  todays_tasks:           'You are a business assistant for an MSME trader. Summarize today\'s tasks in 2-3 lines. Lead with urgent items. No preamble.',
  what_i_owe:             'You are a business assistant for an MSME trader. Summarize supplier payables in 2-3 lines. Lead with total owed. No preamble.',
  overdue_payables:       'You are a business assistant for an MSME trader. Summarize overdue supplier bills in 2-3 lines. Name the top supplier owed. No preamble.',
  top_supplier:           'You are a business assistant for an MSME trader. Summarize top suppliers by payment this month in 2-3 lines. No preamble.',
  entity_profile:         'You are a CFO briefing the business owner about a customer. 2-3 crisp sentences. State the outstanding balance, payment terms, and customer since date. Mention memory signals if present (avg_payment_days, last_payment_date). If data is sparse, say so. No preamble, no markdown. Grounded ONLY in provided data.',
  payment_pattern:        'You are a CFO briefing the business owner on a customer payment behaviour. 2-3 crisp sentences. Lead with avg payment days if known. If fewer than 2 payments exist, say history is too limited to show a trend. Otherwise report trend (improving/worsening/stable) based on invoice vs payment dates. Name the most recent payment amount and date. No preamble, no markdown. Grounded ONLY in provided data.',
  risky_customer:         'You are a COO briefing the business owner on customer relationship risk. 2-3 crisp sentences. Lead with total count split between at-risk and gone-silent. Name the most urgent customer and why — include the reason field if present. Recommend action: follow-up call for at-risk, reactivation outreach for gone-silent. No preamble, no markdown. Grounded ONLY in provided data.',
  financial_health:        'You are a CFO briefing the business owner on the organisation financial position. 2-3 crisp sentences. Lead with total receivables and overdue percentage. State receivableDays if present (e.g. carrying N days of receivables). Name the biggest debtor and their share. State cash risk level and one recommended action. No preamble, no markdown. Grounded ONLY in provided data.',
  collections_date_range: 'You are a CFO briefing the business owner on collections for a date period. 2-3 crisp sentences. Lead with total collected and count of payments. If payments array is empty, say no collections recorded for this period. No preamble, no markdown. Grounded ONLY in provided data.',
};

const FALLBACKS = {
  collections_today:      (d) => `Collected ${d.total || 0} today across ${d.count || 0} payment(s).`,
  total_outstanding:      (d) => `Total outstanding: ${d.total || 0} across ${d.count || 0} customer(s). ${d.overdueCount || 0} invoice(s) overdue.`,
  top_customers:          (d) => `Top customer this month: ${d.topName || 'None'}.`,
  revenue_this_month:     (d) => `Billed ${d.total || 0} this month across ${d.count || 0} invoice(s).`,
  invoices_due_this_week: (d) => `${d.count || 0} invoice(s) due this week totalling ${d.total || 0}.`,
  weekly_trend:           (d) => `Collections ${d.direction || 'flat'} this week. ${d.dormantCount || 0} customers haven't reordered recently — reach out now.`,
  follow_up_today:        (d) => `${d.count || 0} customer(s) need follow-up. Top: ${d.topName || 'None'}.`,
  risk_alerts:            (d) => `${d.count || 0} customer(s) showing payment risk.`,
  gone_silent:            (d) => `${d.count || 0} customer(s) have not ordered in 60+ days.`,
  top_sellers:            (d) => `Top seller this month: ${d.topName || 'None'} with ${d.topQty || 0} unit(s) sold.`,
  low_stock:              (d) => `${d.count || 0} product(s) at or below reorder level.`,
  slow_moving:            (d) => `${d.count || 0} product(s) have stock but no sales in 30 days.`,
  deliveries_today:       (d) => `${d.total || 0} delivery task(s) today. ${d.pending || 0} pending.`,
  expiring_quotes:        (d) => `${d.count || 0} quote(s) expiring soon or already expired.`,
  todays_tasks:           (d) => `${d.total || 0} task(s) due today. ${d.urgent || 0} urgent.`,
  what_i_owe:             (d) => `Total payable to suppliers: ${d.total || 0}. ${d.overdueCount || 0} bill(s) overdue.`,
  overdue_payables:       (d) => `${d.count || 0} supplier(s) have overdue bills. Top: ${d.topName || 'None'}.`,
  top_supplier:           (d) => `Top supplier this month: ${d.topName || 'None'}.`,
  entity_profile:         (d) => `${d.profile?.name || 'Customer'}: ₹${d.profile?.outstandingReceivable || 0} outstanding.`,
  payment_pattern:        (d) => `${d.profile?.name || 'Customer'}: avg payment days ${d.profile?.memory?.avg_payment_days?.value || 'unknown'}.`,
  risky_customer:         (d) => `${d.atRiskCount || 0} at-risk, ${d.goneSilentCount || 0} gone silent. Prioritize reactivation outreach for the silent group.`,
  financial_health:        (d) => `₹${d.totalReceivables || 0} receivables, ${d.overduePercent || 0}% overdue. Cash risk: ${d.cashRiskLevel || 'unknown'}.`,
  collections_date_range: (d) => `Collected ₹${(d.payments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0)} in this period.`,
};

const LANGUAGE_INSTRUCTIONS = {
  en: 'Respond in natural professional English.',
  hi: 'Respond in natural professional Hindi written in Devanagari script.',
  ur: 'Respond in natural professional Urdu.',
  bn: 'Respond in natural professional Bengali.',
  ar: 'Respond in natural professional Arabic.',
};

// PERSPECTIVE_INVARIANTS: semantic financial direction per function.
// Prevents language models from flipping creditor/debtor roles across languages.
// 'receivable' = customers owe the owner (collections, outstanding, invoices due)
// 'payable'    = owner owes suppliers/vendors (bills, payables, supplier payments)
// 'neutral'    = no financial direction (tasks, products, deliveries)
const PERSPECTIVE_INVARIANTS = {
  receivable: [
    'You are speaking TO the business owner who is the SELLER/CREDITOR.',
    'Customers owe money TO the owner. The owner must COLLECT payments from customers.',
    'Never imply the owner owes money to customers. This direction must not flip in any language.',
  ].join(' '),
  payable: [
    'You are speaking TO the business owner who is the BUYER/DEBTOR in this context.',
    'The owner OWES money to suppliers/vendors. The owner must PAY these obligations.',
    'Never imply customers owe the owner in this context. This direction must not flip in any language.',
  ].join(' '),
  neutral: '',
};

// Perspective map — each function declares its financial direction
const FUNCTION_PERSPECTIVE = {
  collections_today:      'receivable',
  total_outstanding:      'receivable',
  top_customers:          'receivable',
  revenue_this_month:     'receivable',
  invoices_due_this_week: 'receivable',
  weekly_trend:           'receivable',
  follow_up_today:        'receivable',
  risk_alerts:            'receivable',
  gone_silent:            'receivable',
  top_sellers:            'neutral',
  low_stock:              'neutral',
  slow_moving:            'neutral',
  deliveries_today:       'neutral',
  expiring_quotes:        'receivable',
  todays_tasks:           'neutral',
  what_i_owe:             'payable',
  overdue_payables:       'payable',
  top_supplier:           'payable',
  entity_profile:         'receivable',
  payment_pattern:        'receivable',
  risky_customer:         'receivable', // P5: receivable lens (owner as creditor tracking engagement risk). Future: dedicated relationship-health perspective when added.
  financial_health:        'receivable', // P3: org financial position — owner as creditor
  collections_date_range: 'receivable',
};
const normalizeLanguage = (lang) => {
  if (!lang) return 'en';
  const base = lang.toLowerCase().split('-')[0].split('_')[0];
  return LANGUAGE_INSTRUCTIONS[base] ? base : 'en';
};

export async function narrate(data, functionKey, openai, options = {}) {
  const {
    timeoutMs   = 8000,
    maxTokens   = 150,
    temperature = 0.1,
  } = options;

  const fallbackFn = FALLBACKS[functionKey];
  const fallback = fallbackFn ? fallbackFn(data) : 'Business data retrieved successfully.';

  const payload = JSON.stringify(data);
  if (payload.length > 4000) {
    console.warn('[orgAi]', { fn: functionKey, reason: 'payload_too_large', bytes: payload.length });
    return fallback;
  }

  const language = normalizeLanguage(options.language);
  const langInstruction = LANGUAGE_INSTRUCTIONS[language] || '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = PROMPTS[functionKey];
    if (!prompt) return fallback;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: [
          prompt,
          PERSPECTIVE_INVARIANTS[FUNCTION_PERSPECTIVE[functionKey] || 'neutral'] || '',
          langInstruction,
        ].filter(Boolean).join(' ') },
        { role: 'user', content: payload },
      ],
      temperature,
      max_tokens: maxTokens,
    }, { signal: controller.signal });

    return completion.choices[0]?.message?.content?.trim() || fallback;
  } catch (e) {
    console.warn('[orgAi] narrate fallback used. key:', functionKey, 'reason:', e.message);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
