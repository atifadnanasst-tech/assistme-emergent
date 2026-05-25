/**
 * AssistMe — Org AI Narration Engine
 * Location: /services/ai/orgAi/narration.js
 * Single narration function for all org AI functions.
 * Never throws — always returns fallback on any failure.
 */

const PROMPTS = {
  collections_today:      'You are a business assistant for an MSME trader. Summarize this collections data in 2-3 short lines. Lead with the total collected. Mention the top payer if present. Be specific with numbers. No preamble.',
  total_outstanding:      'You are a business assistant for an MSME trader. Summarize this outstanding balance data in 2-3 short lines. Lead with the most urgent insight. No preamble.',
  top_customers:          'You are a business assistant for an MSME trader. Summarize who the top customers are by revenue in 2-3 short lines. Be specific with numbers. No preamble.',
  revenue_this_month:     'You are a business assistant for an MSME trader. Summarize this month\'s revenue in 2-3 short lines. Lead with total billed. No preamble.',
  invoices_due_this_week: 'You are a business assistant for an MSME trader. The trader has raised these invoices and customers OWE the trader money — the trader is the seller who needs to collect payment. Summarize which customer invoices are due this week in 2-3 lines. Lead with urgency. Name the top customer who owes. No preamble.',
  weekly_trend:           'You are a business assistant for an MSME trader. Analyze the data and respond in this exact format: Line 1: Collections direction + amount + % change vs last week. Line 2: Top moving product(s) if any. Line 3: One specific action with a customer or product name. Use bold for numbers and names. Keep each line under 15 words. No preamble. No paragraph. Grounded ONLY in provided data.',
  follow_up_today:        'You are a business assistant for an MSME trader. Summarize which customers need follow-up today in 2-3 lines. Lead with the most important one. No preamble.',
  risk_alerts:            'You are a business assistant for an MSME trader. Summarize payment risk alerts in 2-3 lines. Be direct. No preamble.',
  gone_silent:            'You are a business assistant for an MSME trader. Summarize customers who have gone silent in 2-3 lines. No preamble.',
  top_sellers:            'You are a business assistant for an MSME trader. Summarize top selling products this month in 2-3 lines. No preamble.',
  low_stock:              'You are a business assistant for an MSME trader. Summarize low stock products in 2-3 lines. Lead with most urgent. No preamble.',
  slow_moving:            'You are a business assistant for an MSME trader. Summarize slow-moving stock in 2-3 lines. No preamble.',
  deliveries_today:       'You are a business assistant for an MSME trader. Summarize delivery tasks for today in 2-3 lines. Lead with pending count. No preamble.',
  expiring_quotes:        'You are a business assistant for an MSME trader. Summarize expiring quotes in 2-3 lines. Lead with most urgent. No preamble.',
  todays_tasks:           'You are a business assistant for an MSME trader. Summarize today\'s tasks in 2-3 lines. Lead with urgent items. No preamble.',
  what_i_owe:             'You are a business assistant for an MSME trader. Summarize supplier payables in 2-3 lines. Lead with total owed. No preamble.',
  overdue_payables:       'You are a business assistant for an MSME trader. Summarize overdue supplier bills in 2-3 lines. Name the top supplier owed. No preamble.',
  top_supplier:           'You are a business assistant for an MSME trader. Summarize top suppliers by payment this month in 2-3 lines. No preamble.',
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
