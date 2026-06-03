/**
 * AssistMe — AI Planner
 *
 * Location: /backend/src/services/ai/planner.js
 * Created: Session I-A, Jun 2026
 *
 * PURPOSE: Converts owner's natural language into a structured execution plan.
 *          Single GPT call. Returns JSON. Nothing is executed here.
 *
 * FIRST-PERSON RULE: Owner speaks about their own business.
 *   "meri products" = this org's products
 *   "mera customer" = this org's customers
 *   Never ask "which organisation?" — always implicit from context.
 */

import { getCapabilitiesForScope } from './capabilityRegistry.js';

function buildSystemPrompt(scope, orgContext) {
  const capabilities = getCapabilitiesForScope(scope);

  const capabilityList = capabilities
    .map(c => `  "${c.name}": ${c.description} [confirmation: ${c.confirmation}]`)
    .join('\n');

  return `You are the business action planner for this owner's private business operating system.

CONTEXT:
- Business currency: ${orgContext.currency || 'INR'}
- Language preference: ${orgContext.language || 'en'}

FIRST-PERSON RULE (critical):
The owner always speaks about their OWN business.
"meri products" = this business's products
"mera customer" = this business's customers
"mere suppliers" = this business's suppliers
"meri sales" = this business's sales
Never ask "which organisation?" — it is always this one.

YOUR JOB:
Convert the owner's natural language into a structured execution plan.
Use ONLY the available capabilities listed below.
Return ONLY valid JSON. No explanation. No markdown. No preamble.

AVAILABLE CAPABILITIES:
${capabilityList}

OUTPUT FORMAT (strict JSON only):
{
  "plan": [
    {
      "capability": "<exact name from list>",
      "params": {},
      "label": "<human-readable description in owner's language>"
    }
  ],
  "confidence": 0.0,
  "clarification_needed": null
}

RULES:
1. Only use capability names from the list. Never invent new ones.
2. Multi-step intents produce multiple plan steps.
3. If intent is unclear, set clarification_needed and return empty plan [].
4. confidence: exact match = 0.9+, reasonable inference = 0.7-0.89, unclear = below 0.5.
5. If confidence < 0.5, always set clarification_needed.
6. params must use business-domain language only. Never use table names or column names.
7. "meri attar products" → params.selector.category = "attar".
8. For bulk operations use selector, not individual IDs.
9. label should match the language the owner used (Hindi/English/mixed).
10. If owner specifies an EXPLICIT TARGET PRICE ("make it 1150", "set to 550", "1150 kar do", "price 199 rakhna"):
    ALWAYS use change_type="set_price" with the exact number as value.
    NEVER use increase_pct or decrease_pct for explicit target prices.

PARAM EXAMPLES:
- mutate_product bulk % increase: { "operation": "bulk_price_change", "selector": { "category": "attar" }, "change_type": "increase_pct", "value": 10 }
- mutate_product set absolute price: { "operation": "bulk_price_change", "selector": { "name": "Attar Mogra" }, "change_type": "set_price", "value": 1150 }
- mutate_product % decrease: { "operation": "bulk_price_change", "selector": { "category": "perfume" }, "change_type": "decrease_pct", "value": 5 }
- mutate_payment: { "operation": "record_payment", "customer_name": "ABC", "amount": 5000 }
- query_customers: { "filter": "overdue" }
- send_payment_reminder: { "target": "all_overdue" }`;
}

export async function planExecution({ userMessage, scope = 'org', orgContext = {}, conversationHistory = [], openai }) {
  if (!openai) throw new Error('[planner] OpenAI client not provided');
  if (!userMessage?.trim()) throw new Error('[planner] Empty user message');

  const systemPrompt = buildSystemPrompt(scope, orgContext);

  const historyMessages = conversationHistory
    .slice(-8)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userMessage },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const completion = await openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        max_tokens: 800,
      },
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    const raw = completion.choices[0].message.content;
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[planner] JSON parse failed. Raw:', raw);
      return { plan: [], confidence: 0, clarification_needed: 'Could not understand that request. Please rephrase.', _parse_error: true };
    }

    if (!Array.isArray(parsed.plan)) parsed.plan = [];
    if (typeof parsed.confidence !== 'number') parsed.confidence = 0.5;
    if (parsed.clarification_needed !== null && typeof parsed.clarification_needed !== 'string') {
      parsed.clarification_needed = null;
    }

    const hasMutations = parsed.plan.some(s =>
      s.capability?.startsWith('mutate_') || s.capability === 'send_payment_reminder'
    );
    if (hasMutations && parsed.confidence < 0.7 && !parsed.clarification_needed) {
      parsed.clarification_needed = 'Kya aap thoda aur detail de sakte hain?';
      parsed.plan = [];
    }

    console.log('[planner]', {
      input: userMessage.substring(0, 60),
      scope,
      steps: parsed.plan.length,
      confidence: parsed.confidence,
      clarification: !!parsed.clarification_needed,
    });

    return parsed;

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('[planner] timeout');
      return { plan: [], confidence: 0, clarification_needed: 'Request timed out. Please try again.', _timeout: true };
    }
    console.error('[planner] OpenAI error:', err.message);
    throw err;
  }
}
