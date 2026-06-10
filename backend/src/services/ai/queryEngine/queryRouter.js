/**
 * AssistMe — Business Query Router (BQE-4)
 *
 * Location: backend/src/services/ai/queryEngine/queryRouter.js
 * Created: BQE-4, Jun 2026
 *
 * Intercepts unrecognized freeform intents at validPlan.length === 0
 * and answers using DB primitives + shared narrate() from narration.js.
 *
 * RULES:
 * - READ-ONLY: never writes to DB or entity_memory
 * - GPT for classification (tiny 1-call classifier, same pattern as planner)
 * - Narration via existing narrate() — never builds its own GPT call
 * - Returns null if no pattern matches → freeform falls through unchanged
 * - Does NOT intercept clarification_needed or no-plan paths
 *
 * TELEMETRY: writes to missing_capabilities table (reuses existing schema)
 *   detected_intent = 'query_router:answered:<pattern>'
 *   detected_intent = 'query_router:business_other'
 *   detected_intent = 'query_router:no_match'
 *   detected_intent = 'query_router:error'
 *
 * BQE-4.5 DEFERRED: pass unknownCapabilities[] as hints into classifyQuery
 *   to skip the second GPT call when planner already named the intent.
 *
 * Modifies existing production surface: NO — new file only
 */

import { getOrgSummary, searchEntityByName, getEntityProfile, getEntityTransactions } from './primitives.js';
import { narrate } from '../orgAi/narration.js';

// ── Telemetry ─────────────────────────────────────────────────────────────────
// Fire-and-forget. Uses missing_capabilities table (existing schema).

async function logQueryRouterEvent({ supabase, orgId, userPrompt, event }) {
  if (!supabase || !orgId) return;
  try {
    const detectedIntent = `query_router:${event}`;
    const { data: existing } = await supabase
      .from('missing_capabilities')
      .select('id, frequency')
      .eq('organisation_id', orgId)
      .eq('detected_intent', detectedIntent)
      .maybeSingle();

    if (existing) {
      await supabase.from('missing_capabilities')
        .update({ frequency: existing.frequency + 1, last_seen_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await supabase.from('missing_capabilities').insert({
        organisation_id: orgId,
        user_prompt: (userPrompt || '').substring(0, 500),
        detected_intent: detectedIntent,
      });
    }
  } catch (err) {
    console.warn('[queryRouter] telemetry write failed:', err.message);
  }
}

// ── GPT Classifier ────────────────────────────────────────────────────────────
// 1-call, same pattern as planner.js. Temperature 0, max 60 tokens.
// queryType values:
//   entity_profile        — about a specific customer/supplier
//   payment_pattern       — how a specific customer pays
//   collections_date_range— money collected over a time period
//   business_query_other  — business question but no primitive yet (logged, falls through)
//   unknown               — not a business data question (falls through silently)

const CLASSIFIER_SYSTEM = `You classify a business owner's question into one of these query types.
Return ONLY valid JSON. No explanation. No markdown.

QUERY TYPES:
- "entity_profile": owner asking about a specific customer or supplier (who they are, status, details, history)
- "payment_pattern": owner asking about a specific customer payment behaviour or track record
- "collections_date_range": owner asking about money collected/received over a time period (not one specific customer)
- "business_query_other": a business data question that does not fit the above three
- "unknown": not a business data question (weather, definitions, general knowledge)

OUTPUT FORMAT (strict JSON, no markdown):
{"queryType":"<type>","entityMention":"<raw name as owner said it, or null>"}

EXAMPLES:
"Tell me about Ahmed" -> {"queryType":"entity_profile","entityMention":"Ahmed"}
"Who is Ahmed Rashidi?" -> {"queryType":"entity_profile","entityMention":"Ahmed Rashidi"}
"Ahmed ke baare mein batao" -> {"queryType":"entity_profile","entityMention":"Ahmed"}
"How is Ahmed paying?" -> {"queryType":"payment_pattern","entityMention":"Ahmed"}
"Ahmed ki payment kaisi hai?" -> {"queryType":"payment_pattern","entityMention":"Ahmed"}
"Ahmed Rashidi ka payment track record kya hai?" -> {"queryType":"payment_pattern","entityMention":"Ahmed Rashidi"}
"Collections last month" -> {"queryType":"collections_date_range","entityMention":null}
"Is mahine kitna aaya?" -> {"queryType":"collections_date_range","entityMention":null}
"Pichle hafte payments?" -> {"queryType":"collections_date_range","entityMention":null}
"Which customers are becoming risky?" -> {"queryType":"business_query_other","entityMention":null}
"Who should I call today?" -> {"queryType":"business_query_other","entityMention":null}
"What is GST?" -> {"queryType":"unknown","entityMention":null}`;

export async function classifyQuery(message, openai) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        { role: 'user', content: message },
      ],
      temperature: 0,
      max_tokens: 60,
      response_format: { type: 'json_object' },
    }, { signal: controller.signal });
    clearTimeout(timeout);
    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return parsed.queryType ? parsed : null;
  } catch (err) {
    clearTimeout(timeout);
    console.warn('[queryRouter] classifier error:', err.message);
    return null;
  }
}

// ── Date range extractor (pure JS — no GPT needed) ───────────────────────────

function extractDateRange(message) {
  const n = (message || '').toLowerCase();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (n.includes('today') || n.includes('aaj')) {
    return { dateFrom: today, dateTo: today };
  }
  if (n.includes('yesterday') || n.includes('kal')) {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { dateFrom: y.toISOString().slice(0, 10), dateTo: y.toISOString().slice(0, 10) };
  }
  if (n.includes('this week') || n.includes('is hafte')) {
    const day = now.getDay();
    const monday = new Date(now); monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    return { dateFrom: monday.toISOString().slice(0, 10), dateTo: today };
  }
  if (n.includes('last week') || n.includes('pichle hafte')) {
    const day = now.getDay();
    const thisMonday = new Date(now); thisMonday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
    const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1);
    return { dateFrom: lastMonday.toISOString().slice(0, 10), dateTo: lastSunday.toISOString().slice(0, 10) };
  }
  if (n.includes('this month') || n.includes('is mahine')) {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    return { dateFrom: monthStart, dateTo: today };
  }
  if (n.includes('last month') || n.includes('pichle mahine')) {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { dateFrom: first.toISOString().slice(0, 10), dateTo: last.toISOString().slice(0, 10) };
  }
  return { dateFrom: null, dateTo: null };
}

// ── Pattern handlers ──────────────────────────────────────────────────────────

async function handleEntityQuestion({ message, orgId, supabase, openai, orgContext, entityMention, mode }) {
  if (!entityMention) return null;

  const searchResult = await searchEntityByName({ orgId, entityType: 'customer', name: entityMention, supabase });

  // Multiple candidates → return clarification response (not null — owner needs guidance)
  // candidates are full customer objects: { id, name, phone, outstanding_balance, ... }
  if (!searchResult.entity && searchResult.candidates?.length > 0) {
    const names = searchResult.candidates.slice(0, 4).map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    return {
      response_text: `I found ${searchResult.candidates.length} customers matching "${entityMention}". Which one did you mean?\n\n${names}`,
      chart_data: null,
      next_action: null,
      message_type: 'ai_response',
      execution_plan: null,
      pending_plan_id: null,
    };
  }

  // No match at all → fall through
  if (!searchResult.entity) {
    console.log('[queryRouter] entity not found:', entityMention);
    return null;
  }

  const entityId = searchResult.entity.id;
  const scope = { type: 'customer', entityId };

  const { profile } = await getEntityProfile({ orgId, scope, supabase });
  if (!profile) return null;

  const txFilters = mode === 'payment_pattern'
    ? { type: 'all', limit: 15, includeHistorical: true }
    : { type: 'all', limit: 5, includeHistorical: false };

  const { transactions } = await getEntityTransactions({ orgId, scope, filters: txFilters, supabase });

  const data = { profile, transactions };
  const narrateKey = mode === 'payment_pattern' ? 'payment_pattern' : 'entity_profile';
  const responseText = await narrate(data, narrateKey, openai, { language: orgContext?.language });

  return {
    response_text: responseText,
    chart_data: null,
    next_action: { text: `View ${profile.name}'s account` },
    message_type: 'ai_response',
    execution_plan: null,
    pending_plan_id: null,
    _query_meta: {
      answered: true,
      primitivesUsed: ['searchEntityByName', 'getEntityProfile', 'getEntityTransactions'],
      entityId,
      entityName: profile.name,
      pattern: mode,
    },
  };
}

async function handleCollectionsQuestion({ message, orgId, supabase, openai, orgContext }) {
  const { dateFrom, dateTo } = extractDateRange(message);

  const { transactions } = await getEntityTransactions({
    orgId,
    scope: { type: 'org' },
    filters: { type: 'payments', dateFrom, dateTo, limit: 50, includeHistorical: false },
    supabase,
  });

  const payments = transactions?.payments || [];
  const data = {
    payments,
    dateRange: dateFrom ? { from: dateFrom, to: dateTo } : 'all time',
    totalCollected: payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0),
    paymentCount: payments.length,
  };

  const responseText = await narrate(data, 'collections_date_range', openai, { language: orgContext?.language });

  return {
    response_text: responseText,
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    execution_plan: null,
    pending_plan_id: null,
    _query_meta: {
      answered: true,
      primitivesUsed: ['getEntityTransactions'],
      pattern: 'collections_date_range',
      dateFrom,
      dateTo,
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
// Called by freeform.js at validPlan.length === 0 only.
// Returns response object if pattern matched, null if not.
// Never throws — always falls through on any error.

export async function tryQueryRouter({ message, orgId, orgContext, supabase, precomputedClassification }) {
  if (!message || !orgId) return null;

  const openai = orgContext?.openai;
  if (!openai) {
    console.warn('[queryRouter] no openai instance — skipping');
    return null;
  }

  try {
    const classification = precomputedClassification ?? await classifyQuery(message, openai);

    if (!classification) {
      // Classifier failed (timeout/parse error) — fall through silently, never break existing behavior
      return null;
    }

    const { queryType, entityMention } = classification;
    console.log('[queryRouter]', { queryType, entityMention, input: message.substring(0, 60) });

    if (queryType === 'unknown') {
      // Not a business question — fall through to freeform open-world handling
      return null;
    }

    if (queryType === 'business_query_other') {
      // Business question but no primitive yet — log for roadmap, fall through
      await logQueryRouterEvent({ supabase, orgId, userPrompt: message, event: 'business_other' });
      return null;
    }

    let result = null;

    if (queryType === 'entity_profile') {
      result = await handleEntityQuestion({ message, orgId, supabase, openai, orgContext, entityMention, mode: 'entity_profile' });
    } else if (queryType === 'payment_pattern') {
      result = await handleEntityQuestion({ message, orgId, supabase, openai, orgContext, entityMention, mode: 'payment_pattern' });
    } else if (queryType === 'collections_date_range') {
      result = await handleCollectionsQuestion({ message, orgId, supabase, openai, orgContext });
    }

    if (result) {
      await logQueryRouterEvent({ supabase, orgId, userPrompt: message, event: `answered:${queryType}` });
    } else {
      await logQueryRouterEvent({ supabase, orgId, userPrompt: message, event: 'no_match' });
    }

    return result;

  } catch (err) {
    console.error('[queryRouter] unhandled error:', err.message);
    await logQueryRouterEvent({ supabase, orgId, userPrompt: message, event: 'error' });
    return null;
  }
}
