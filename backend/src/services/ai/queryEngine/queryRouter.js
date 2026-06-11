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

import { getOrgSummary, searchEntityByName, getEntityProfile, getEntityTransactions, getRelationshipSignals, classifyRelationship } from './primitives.js';
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
//   risky_customer        — which customers are at risk / going silent
//   business_query_other  — business question but no primitive yet (logged, falls through)
//   unknown               — not a business data question (falls through silently)

const CLASSIFIER_SYSTEM = `You classify a business owner's question into one of these query types.
Return ONLY valid JSON. No explanation. No markdown.

QUERY TYPES:
- "entity_profile": owner asking about a specific customer or supplier (who they are, status, details, history)
- "payment_pattern": owner asking about a specific customer payment behaviour or track record
- "collections_date_range": owner asking about money collected/received over a time period (not one specific customer)
- "risky_customer": owner asking which customers are at risk, going silent, or need follow-up (no specific customer named)
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
"Which customers are becoming risky?" -> {"queryType":"risky_customer","entityMention":null}
"Kaun at risk hai?" -> {"queryType":"risky_customer","entityMention":null}
"Kaun haath se nikal raha hai?" -> {"queryType":"risky_customer","entityMention":null}
"Who should I follow up with?" -> {"queryType":"risky_customer","entityMention":null}
"candidate_selection": owner is responding to a previous ambiguity list (typing "1", "2", or a name from that list)
- "risky_customer": owner asking which customers are at risk, going silent, or need follow-up (no specific customer named)
- "business_query_other": a business data question that does not fit the above types
- "unknown": not a business data question

OUTPUT FORMAT (strict JSON, no markdown):
{"queryType":"<type>","entityMention":"<raw name or null>","selectionIndex":<1-based integer or null>,"selectedText":"<name typed for candidate_selection, or null>"}

EXAMPLES:
"Tell me about Ahmed" -> {"queryType":"entity_profile","entityMention":"Ahmed","selectionIndex":null,"selectedText":null}
"Ahmed ke baare mein batao" -> {"queryType":"entity_profile","entityMention":"Ahmed","selectionIndex":null,"selectedText":null}
"How is Ahmed paying?" -> {"queryType":"payment_pattern","entityMention":"Ahmed","selectionIndex":null,"selectedText":null}
"Ahmed ki payment kaisi hai?" -> {"queryType":"payment_pattern","entityMention":"Ahmed","selectionIndex":null,"selectedText":null}
"Collections last month" -> {"queryType":"collections_date_range","entityMention":null,"selectionIndex":null,"selectedText":null}
"Is mahine kitna aaya?" -> {"queryType":"collections_date_range","entityMention":null,"selectionIndex":null,"selectedText":null}
"1" [after assistant listed candidates] -> {"queryType":"candidate_selection","entityMention":null,"selectionIndex":1,"selectedText":null}
"Ahmed Rashidi" [after assistant listed candidates] -> {"queryType":"candidate_selection","entityMention":null,"selectionIndex":null,"selectedText":"Ahmed Rashidi"}
"Which customers are becoming risky?" -> {"queryType":"risky_customer","entityMention":null,"selectionIndex":null,"selectedText":null}
"Kaun at risk hai?" -> {"queryType":"risky_customer","entityMention":null,"selectionIndex":null,"selectedText":null}
"Kaun haath se nikal raha hai?" -> {"queryType":"risky_customer","entityMention":null,"selectionIndex":null,"selectedText":null}
"Who should I follow up with?" -> {"queryType":"risky_customer","entityMention":null,"selectionIndex":null,"selectedText":null}
"What is GST?" -> {"queryType":"unknown","entityMention":null,"selectionIndex":null,"selectedText":null}`;

export async function classifyQuery(message, openai, conversationHistory = []) {
  // CSF (BQE-4.2): history always injected — LLM determines relevance, not heuristics.
  // Never revert to passing only the current message; that recreates stateless chat.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM },
        ...(conversationHistory || []).slice(-6).map(m => {
          // CSF (BQE-4.2): surface pending_context to classifier for intent detection.
          // Compact form only — candidate IDs excluded (resolution happens in tryQueryRouter).
          // Classifier detects intent; tryQueryRouter resolves state from full metadata.
          const pc = m.metadata?.pending_context;
          const text = typeof m.content === 'string' ? m.content : '';
          const ctx = pc ? JSON.stringify({
            type: pc.type,
            queryType: pc.queryType,
            entityMention: pc.entityMention,
            candidates: pc.candidates?.map(c => c.name),
          }) : null;
          return {
            role: m.role === 'user' ? 'user' : 'assistant',
            content: ctx ? `${text}
[pending_context: ${ctx}]` : text,
          };
        }),
        { role: 'user', content: message },
      ],
      temperature: 0,
      max_tokens: 80,
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

async function handleEntityQuestion({ message, orgId, supabase, openai, orgContext, entityMention, mode, resolvedEntityId }) {
  // CSF (BQE-4.2): resolvedEntityId bypass — when candidate is already known from
  // pending_context, skip searchEntityByName entirely. Without this, candidate_selection
  // would still trigger a second DB search, defeating the purpose of stored state.
  // FUTURE: once CSF matures, candidate selections should resolve before the classifier
  // entirely — "1" is deterministic and should not need a GPT call.
  let entityId = resolvedEntityId || null;

  if (!entityId) {
    if (!entityMention) return null;

    const searchResult = await searchEntityByName({ orgId, entityType: 'customer', name: entityMention, supabase });

    if (!searchResult.entity && searchResult.candidates?.length > 0) {
      const names = searchResult.candidates.slice(0, 4).map((c, i) => `${i + 1}. ${c.name}`).join('\n');
      return {
        response_text: `I found ${searchResult.candidates.length} customers matching "${entityMention}". Which one did you mean?\n\n${names}`,
        chart_data: null,
        next_action: null,
        message_type: 'ai_response',
        execution_plan: null,
        pending_plan_id: null,
        // CSF: persisted by routes.js into message metadata. Next turn reads candidates
        // to resolve selection without re-querying DB. createdAt enables 30-min expiry.
        // Future state types (date_clarification, invoice_selection, yes_no_confirmation)
        // follow this same envelope — never add new top-level response fields for state.
        _pending_context: {
          type: 'candidate_selection',
          queryType: mode,
          entityMention,
          candidates: searchResult.candidates.slice(0, 4).map(c => ({ id: c.id, name: c.name })),
          createdAt: Date.now(),
        },
      };
    }

    if (!searchResult.entity) {
      console.log('[queryRouter] entity not found:', entityMention);
      return null;
    }

    entityId = searchResult.entity.id;
  }
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

// ── Candidate selection handler (CSF v1) ─────────────────────────────────────
// Resolves owner selection after an ambiguity response ("1", "Rashidi", "first one").
// This is the first implementation of the Conversation State Framework.
// Resolution order: index match → name fragment match → fresh search fallback.
// Fresh search handles "actually Ahmed Enterprise" (name not in original candidate list).
//
// FUTURE: candidate selections are deterministic ("1", "2", ordinals, name fragments).
// Once CSF matures, resolve pending_context BEFORE the classifier to remove one GPT call.
// The classifier should only run when no pending_context exists.
async function handleCandidateSelection({ orgId, supabase, openai, orgContext, conversationHistory, classification }) {
  const EXPIRY_MS = 30 * 60 * 1000; // 30 min — long enough for a work session, avoids Monday→Tuesday stale state

  const pendingMsg = [...conversationHistory].reverse().find(m =>
    m.role === 'assistant' && m.metadata?.pending_context?.type === 'candidate_selection'
  );

  if (!pendingMsg) {
    console.log('[queryRouter] candidate_selection: no pending_context in history');
    return null;
  }

  const pc = pendingMsg.metadata.pending_context;

  if (pc.createdAt && Date.now() - pc.createdAt > EXPIRY_MS) {
    console.log('[queryRouter] candidate_selection: pending_context expired');
    return null;
  }

  const { candidates, queryType, entityMention } = pc;
  const { selectionIndex, selectedText } = classification;
  let resolved = null;

  if (selectionIndex >= 1 && selectionIndex <= candidates.length) {
    resolved = candidates[selectionIndex - 1];
  }
  if (!resolved && selectedText) {
    const norm = selectedText.toLowerCase().trim();
    resolved = candidates.find(c =>
      c.name.toLowerCase().includes(norm) || norm.includes(c.name.toLowerCase())
    );
  }
  // Fallback: name not in list → treat as fresh entity query, not an error
  if (!resolved && selectedText) {
    console.log('[queryRouter] candidate_selection: name not in list, fresh search:', selectedText);
    return handleEntityQuestion({ message: selectedText, orgId, supabase, openai, orgContext, entityMention: selectedText, mode: queryType });
  }
  if (!resolved) {
    console.log('[queryRouter] candidate_selection: could not resolve');
    return null;
  }

  console.log('[queryRouter] candidate_selection resolved:', resolved.name, 'queryType:', queryType);
  return handleEntityQuestion({ orgId, supabase, openai, orgContext, mode: queryType, resolvedEntityId: resolved.id });
}

// ── P5: handleRiskyCustomers ─────────────────────────────────────────────────
// BQE-5, Jun 2026. Consumes getRelationshipSignals() + classifyRelationship().
// Keeps at_risk and gone_silent separate — different urgency, different actions.
// Sort: severity DESC (gone_silent=2, at_risk=1) then lastActivityDays DESC.
// value = totalRevenueL90d (current commercial importance, not last invoice amount).
// Modifies existing production surface: NO — new function only

async function handleRiskyCustomers({ orgId, supabase, openai, orgContext }) {
  const { signals, error } = await getRelationshipSignals({ orgId, scope: { type: 'org' }, supabase });
  if (error || !signals) return null;

  const classified = signals
    .map(s => ({ ...s, ...classifyRelationship(s) }))
    .filter(s => ['at_risk', 'gone_silent'].includes(s.relationshipStatus) && !s.inCooldown);

  const severityScore = (status) => status === 'gone_silent' ? 2 : status === 'at_risk' ? 1 : 0;
  classified.sort((a, b) => {
    const sd = severityScore(b.relationshipStatus) - severityScore(a.relationshipStatus);
    if (sd !== 0) return sd;
    return (b.lastActivityDays || 0) - (a.lastActivityDays || 0);
  });

  const top = classified.slice(0, 8);
  const atRiskGroup = top.filter(s => s.relationshipStatus === 'at_risk');
  const goneSilentGroup = top.filter(s => s.relationshipStatus === 'gone_silent');
  const atRiskCount = atRiskGroup.length;
  const goneSilentCount = goneSilentGroup.length;
  const orgCurrency = orgContext?.currency || 'INR';

  if (top.length === 0) {
    const chart_data = { type: 'insight', title: 'Customers Needing Attention', text: 'All customers are actively engaged. No at-risk or silent accounts detected.', level: 'info' };
    const next_action = { text: 'All customers are actively engaged.', type: 'none', signal_type: null, source_surface: 'risky_customer', execution_mode: null, entities: [], prefill: null };
    const response_text = await narrate({ atRiskCount: 0, goneSilentCount: 0, topName: null, topReason: null, currency: orgCurrency }, 'risky_customer', openai);
    return { response_text, chart_data, next_action, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
  }

  const chart_data = {
    type: 'ranked_list', title: 'Customers Needing Attention', currency: orgCurrency,
    series: top.map(s => ({
      label: s.entityName || s.entityId,
      value: s.totalRevenueL90d || 0,
      sublabel: `${s.relationshipStatus === 'gone_silent' ? 'Gone Silent' : 'At Risk'} — ${s.relationshipReason || (s.lastActivityDays + ' days inactive')}`,
    })),
    highlight: `${atRiskCount} at risk, ${goneSilentCount} gone silent`,
    level: 'warning',
  };

  const topEntity = top[0];
  const next_action = {
    text: goneSilentCount > 0
      ? `${goneSilentGroup[0].entityName}${goneSilentCount > 1 ? ' and ' + (goneSilentCount - 1) + ' others' : ''} need reactivation outreach before the relationship cools further.`
      : `${atRiskGroup[0].entityName}${atRiskCount > 1 ? ' and ' + (atRiskCount - 1) + ' others' : ''} are showing early risk signals — schedule a follow-up call.`,
    type: 'reactivate_customer', signal_type: 'risky_customer_reactivation', source_surface: 'risky_customer',
    execution_mode: top.length > 1 ? 'bulk' : 'single',
    entities: top.map(s => ({ customer_id: s.entityId, customer_name: s.entityName, customer_phone: s.phone || null, invoice_id: null, invoice_number: '', amount: s.totalRevenueL90d || 0, days_inactive: s.lastActivityDays, relationship_status: s.relationshipStatus })),
    prefill: top.length === 1 ? {
      message: topEntity.relationshipStatus === 'gone_silent'
        ? `${topEntity.entityName}, it has been a while since we last connected. We value your business and would love to reconnect — is there anything we can help you with?`
        : `${topEntity.entityName}, just checking in to see how things are going. Would love to discuss your next order when you are ready.`,
      language: 'en',
    } : null,
  };

  const response_text = await narrate({
    atRiskCount, goneSilentCount, topName: top[0]?.entityName, topReason: top[0]?.relationshipReason,
    topDaysInactive: top[0]?.lastActivityDays, currency: orgCurrency,
    atRiskList: atRiskGroup.map(s => ({ name: s.entityName, reason: s.relationshipReason, days: s.lastActivityDays })),
    goneSilentList: goneSilentGroup.map(s => ({ name: s.entityName, reason: s.relationshipReason, days: s.lastActivityDays })),
  }, 'risky_customer', openai);

  console.log('[queryRouter] risky_customer', { atRiskCount, goneSilentCount, total: top.length });
  return { response_text, chart_data, next_action, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
}

// ── Main export ───────────────────────────────────────────────────────────────
// Called by freeform.js at validPlan.length === 0 only.
// Returns response object if pattern matched, null if not.
// Never throws — always falls through on any error.

export async function tryQueryRouter({ message, orgId, orgContext, supabase, precomputedClassification, conversationHistory = [] }) {
  if (!message || !orgId) return null;

  console.log('[queryRouter entry]', message?.substring(0, 40), 'history:', conversationHistory?.length);
  const openai = orgContext?.openai;
  if (!openai) {
    console.warn('[queryRouter] no openai instance — skipping');
    return null;
  }

  try {
    const classification = precomputedClassification ?? await classifyQuery(message, openai, conversationHistory);

    console.log('[queryRouter classification]', JSON.stringify(classification));
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

    if (queryType === 'candidate_selection') {
      result = await handleCandidateSelection({ orgId, supabase, openai, orgContext, conversationHistory, classification });
    } else if (queryType === 'entity_profile') {
      result = await handleEntityQuestion({ message, orgId, supabase, openai, orgContext, entityMention, mode: 'entity_profile' });
    } else if (queryType === 'payment_pattern') {
      result = await handleEntityQuestion({ message, orgId, supabase, openai, orgContext, entityMention, mode: 'payment_pattern' });
    } else if (queryType === 'collections_date_range') {
      result = await handleCollectionsQuestion({ message, orgId, supabase, openai, orgContext });
    } else if (queryType === 'risky_customer') {
      result = await handleRiskyCustomers({ orgId, supabase, openai, orgContext });
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
