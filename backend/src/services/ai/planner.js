import { recordAiUsage } from '../billing/usageTracking.js';
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
10. When a business concept is recognised but maps to NO available capability:
    - First, offer 2-3 industry-standard options that match the concept (use your business knowledge).
    - Example: "buyer scorecard" → suggest Payment Health, Revenue Contribution, Relationship Health.
    - Ask the owner to choose ONE.
    - Only use clarification_needed when you can genuinely help the owner narrow down intent.
    - Do NOT ask open-ended questions like "what do you want in the scorecard?" — propose concrete options instead.
    - If after one round of guidance the intent still maps to nothing, emit the closest descriptive capability name
      (e.g. "create_buyer_scorecard", "generate_supplier_report") so it can be logged.
11. PRICE CHANGE TYPES — choose correctly:
    "5% badha do" / "increase by 5 percent" → change_type="increase_pct", value=5
    "₹50 badha do" / "increase by ₹50" / "50 rupee zyada karo" → change_type="increase_abs", value=50
    "1150 kar do" / "set to 1150" → change_type="set_price", value=1150
    KEY: if owner says ₹ before a number with "badha/increase", it is ABSOLUTE amount increase, NOT percentage.
12. INDIAN CURRENCY FORMATS — always parse these correctly:
    "1000/-" = 1000, "5,000" = 5000, "1.5L" = 150000, "50k" = 50000
    "₹3600" = 3600, "Rs 500" = 500, "3600 rupee" = 3600
    The "/- " suffix is a common Indian notation — ignore it and use the number only.
    NEVER extract partial digits. "1000/-" is 1000, not 11 or 100.
12. If owner specifies an EXPLICIT TARGET PRICE ("make it 1150", "set to 550", "1150 kar do", "price 199 rakhna"):
    ALWAYS use change_type="set_price" with the exact number as value.
    NEVER use increase_pct or decrease_pct for explicit target prices.

PARAM EXAMPLES:
- set_entity_field customer credit limit: { "mutation_key": "customer.credit_limit.set", "entity": { "type": "customer", "name": "Ania Adnan" }, "new_value": "200000" }
- set_entity_field payment terms: { "mutation_key": "customer.payment_terms.set", "entity": { "type": "customer", "name": "Noor" }, "new_value": "45" }
- set_entity_field phone: { "mutation_key": "customer.phone.set", "entity": { "type": "customer", "name": "Shahid" }, "new_value": "9876543210" }
- set_entity_field product category: { "mutation_key": "product.category.set", "entity": { "type": "product", "name": "Attar Mogra" }, "new_value": "attar" }
- set_entity_field product unit: { "mutation_key": "product.unit.set", "entity": { "type": "product", "name": "Rose Water" }, "new_value": "litre" }
- mutate_product all products % increase: { "operation": "bulk_price_change", "selector": { "all": true }, "change_type": "increase_pct", "value": 5 }
- mutate_product bulk % increase: { "operation": "bulk_price_change", "selector": { "category": "attar" }, "change_type": "increase_pct", "value": 10 }
- mutate_product set absolute price: { "operation": "bulk_price_change", "selector": { "name": "Attar Mogra" }, "change_type": "set_price", "value": 1150 }
- mutate_product % decrease: { "operation": "bulk_price_change", "selector": { "category": "perfume" }, "change_type": "decrease_pct", "value": 5 }
- mutate_invoice create invoice: { "operation": "create_invoice", "customer": { "name": "Ania Adnan" }, "items": [{ "name": "Attar Mogra", "quantity": 2 }] }
- mutate_invoice multiple items: { "operation": "create_invoice", "customer": { "name": "Noor Suppliers" }, "items": [{ "name": "Attar Rose", "quantity": 1 }, { "name": "Musk Al Tahara", "quantity": 3 }] }
- mutate_invoice with quantity: { "operation": "create_invoice", "customer": { "name": "ABC Traders" }, "items": [{ "name": "Mogra", "quantity": 5 }] }
- mutate_payment record payment: { "operation": "record_payment", "customer": { "name": "ABC Traders" }, "amount": 5000 }
- mutate_payment with date: { "operation": "record_payment", "customer": { "name": "Ania" }, "amount": 3600, "date": "2026-06-04" }
- mutate_payment with method: { "operation": "record_payment", "customer": { "name": "XYZ" }, "amount": 10000, "method": "upi" }
- query_customers: { "filter": "overdue" }
- send_payment_reminder: { "target": "all_overdue" }
- set_business_profile GSTIN: { "field_key": "gstin", "new_value": "27AAAAA0000A1Z5" }
- set_business_profile name: { "field_key": "business_name", "new_value": "BW Solution Technologies" }
- set_business_profile address: { "field_key": "address_line1", "new_value": "11/2A McLeod Street" }
- set_business_profile city: { "field_key": "city", "new_value": "Kolkata" }
- set_business_profile state: { "field_key": "state", "new_value": "West Bengal" }
- set_business_profile phone: { "field_key": "phone", "new_value": "9007188402" }
- set_business_profile email: { "field_key": "email", "new_value": "contact@mybusiness.com" }
- record_opening_position (NEW customer/entity with ZERO prior invoices, payments, or purchase bills -- a one-time declaration of a pre-existing balance when starting to use AssistMe): { "amount": 10000, "direction": "receivable", "customer": { "name": "Ramesh" } } -- use when owner says "Ramesh owes me 10000" or "Ramesh ka opening balance 10000 hai"
- record_opening_position (owner owes a NEW entity, e.g. a supplier-style relationship -- still the customers table, direction flips): { "amount": 5000, "direction": "payable", "customer": { "name": "Noor" } } -- use when owner says "I owe Noor 5000" or "Noor ko 5000 dena hai, opening balance"
  IMPORTANT: record_opening_position is for a ONE-TIME declaration about a customer/entity with NO existing invoices, payments, or purchase bills.
  Do NOT use it if the owner is asking a QUESTION about an existing balance (e.g. "Amir currently owes how much", "what is Amir's balance") -- that is query_customers or financial_health, not record_opening_position.
  Do NOT use it for correcting/adjusting an existing customer's balance (e.g. "set Ramesh balance to 12000", "we reconciled, balance is now 6000") -- that is not supported yet; set clarification_needed and explain this is not available.`;
}

export async function planExecution({ userMessage, scope = 'org', orgContext = {}, conversationHistory = [], openai, orgId, supabase }) {
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

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget,
    // tracking only. Only fires if the caller supplied orgId+supabase.
    if (orgId && supabase) {
      recordAiUsage({
        orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    }

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
