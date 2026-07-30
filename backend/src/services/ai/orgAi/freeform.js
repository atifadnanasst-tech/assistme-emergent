import { recordAiUsage } from '../../billing/usageTracking.js';
/**
 * AssistMe — Freeform Orchestrator
 *
 * Location: /backend/src/services/ai/orgAi/freeform.js
 * Created: Session I-A, Jun 2026
 *
 * THE RULE: Mutations NEVER execute without owner confirmation.
 *   Mutation path → builds preview card → stores plan in ai_actions → returns pending_plan_id.
 *   Execution only happens when owner confirms via Session I-B endpoint.
 *
 * SECURITY: Client receives pending_plan_id (UUID) only.
 *           Executable params stay server-side in ai_actions.parameters.
 */

import { planExecution } from '../planner.js';
import { validatePlan, classifyPlan } from '../validator.js';
import { dispatch, dispatchPlan } from '../dispatcher.js';
import { buildExecutionPlanCard, buildClientPlanCard } from '../executionPlanBuilder.js';
import { tryQueryRouter, classifyQuery } from '../queryEngine/queryRouter.js';

export async function dispatchFreeform({
  message,
  orgId,
  orgContext,
  conversationId,
  supabase,
  scope = 'org',
  conversationHistory = [],
  conversationSummary = null, // Brain 2.5 (v1.3.269): plumbing only, not yet used in prompts
}) {
  const openai = orgContext.openai;

  // Step 1: Plan
  let planResult;
  try {
    planResult = await planExecution({ userMessage: message, scope, orgContext, conversationHistory, openai, orgId, supabase });
  } catch (err) {
    console.error('[freeform] planner error:', err.message);
    return _fallback('AI planning failed. Please try again.');
  }

  // Step 2: Clarification needed?
  if (planResult.clarification_needed) {
    // CSF owns entity ambiguity. Planner owns intent ambiguity.
    // Do not route all clarification_needed through queryRouter.
    // Only intercept when classifier confirms entity-specific question (entity_profile, payment_pattern).
    // Those get queryRouter's numbered candidate list instead of planner's open-ended question.
    // Intent clarifications ("which month?", "which customer for this payment?") fall through
    // to planner — Type B clarifications owned by planner, not CSF.
    const _clarifyClassification = await classifyQuery(message, orgContext.openai, conversationHistory, conversationSummary);
    // Type A: Entity-specific clarifications — require entityMention (CSF candidate list)
    const _isEntityClarification = _clarifyClassification &&
      new Set(['entity_profile', 'payment_pattern']).has(_clarifyClassification.queryType) &&
      !!_clarifyClassification.entityMention;
    // Type C: Org-level query types — no entityMention needed, queryRouter answers directly
    // NOTE: collections_date_range intentionally excluded — date clarifications belong to planner.
    const _isOrgQueryClarification = _clarifyClassification &&
      new Set(['risky_customer', 'financial_health']).has(_clarifyClassification.queryType);
    if (_isEntityClarification || _isOrgQueryClarification) {
      const _clarifyResult = await tryQueryRouter({ message, orgId, orgContext, supabase, conversationHistory, precomputedClassification: _clarifyClassification });
      if (_clarifyResult) return _clarifyResult;
    }
    // Brain 3: third dead-end. Planner's clarification_needed is a generic
    // "please specify what action" prompt — useless for greetings, world
    // knowledge, coaching, or advice questions (Type A/C didn't match above).
    // Only genuine Type B intent-ambiguity for an EXECUTABLE action should
    // echo planner's clarification; everything else goes to Brain 3.
    if (_clarifyClassification?.queryType === 'business_query_other' || _clarifyClassification?.queryType === 'unknown' || !_clarifyClassification) {
      return await handleWorldIntelligence({ message, orgId, supabase, orgContext, conversationHistory, conversationSummary, trigger: 'clarification_non_action' });
    }
    return { response_text: planResult.clarification_needed, chart_data: null, next_action: null, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
  }

  if (!planResult.plan || planResult.plan.length === 0) {
    // Brain 3: no dead-end — unified world intelligence fallback (greeting,
    // coaching, world knowledge, business advice, general conversation).
    return await handleWorldIntelligence({ message, orgId, supabase, orgContext, conversationHistory, conversationSummary, trigger: 'empty_plan' });
  }

  // Step 3: Validate
  const { validPlan, unknownCapabilities } = await validatePlan({ plan: planResult.plan, userPrompt: message, orgId, scope, supabase });

  if (validPlan.length === 0) {
    // BQE-4: Try queryRouter before giving up
    const queryResult = await tryQueryRouter({ message, orgId, orgContext, supabase, conversationHistory, conversationSummary });
    if (queryResult) return queryResult;

    // Brain 3: no dead-end — genuine unknown intent goes to unified world
    // intelligence fallback. unknownCapabilities available here for Phase 2
    // capability-gap logging (not used yet — see handleWorldIntelligence header).
    return await handleWorldIntelligence({ message, orgId, supabase, orgContext, conversationHistory, conversationSummary, trigger: 'queryrouter_null' });
  }
  // Step 4: Classify
  const planClass = classifyPlan(validPlan);

  // PATH A: Query-only → execute immediately
  if (planClass === 'execute_immediately') {
    console.log('[CSF]', 'history:', conversationHistory.length, 'pending:', conversationHistory.some(m => m.metadata?.pending_context));
    // CSF: pending_context precheck — owner may be selecting from a prior candidate list.
    // Must run before capability filtering — planner maps "1" to unpredictable capabilities.
    const _hasPendingContext = conversationHistory.slice(-4).some(
      m => m.role === 'assistant' && m.metadata?.pending_context?.type === 'candidate_selection'
    );
    if (_hasPendingContext) {
      const _pendingResult = await tryQueryRouter({ message, orgId, orgContext, supabase, conversationHistory });
      if (_pendingResult) return _pendingResult;
    }
    // BQE-4.1 CONFIDENCE GUARD
    // Tactical fix for planner misroutes on business intelligence questions.
    // All three conditions required:
    //   1. Single generic query capability (query_customers / query_invoices / query_suppliers)
    //   2. Planner confidence < 0.9
    //   3. Classifier confirms entity-specific question (named entity + entity/payment intent)
    // "Show overdue customers"       → condition 3 fails → executes normally (2 GPT calls)
    // "Ahmed ki payment kaisi hai?"  → all 3 true → queryRouter answers (3 GPT calls)
    // Classifier result passed into tryQueryRouter — no duplicate GPT call.
    //
    // ARCHITECTURAL NOTE (Jun 2026):
    // Long-term these should be four explicit layers before planner runs:
    //   A) Mutations        → Planner
    //   B) Menu Queries     → Menu functions
    //   C) Business Intel   → QueryRouter directly
    //   D) Open World       → LLM
    // Revisit after BQE-11 when all 8 primitives are complete.
    const _genericQueryCaps = new Set(['query_customers', 'query_invoices', 'query_suppliers']);
    if (planResult.confidence < 0.9 && validPlan.length === 1 && _genericQueryCaps.has(validPlan[0].capability)) {
      const _classification = await classifyQuery(message, orgContext.openai, conversationHistory, conversationSummary);
      console.log('[CSF DEBUG]', JSON.stringify(_classification));
      const _isEntityQuery = _classification &&
        new Set(['entity_profile', 'payment_pattern']).has(_classification.queryType) &&
        !!_classification.entityMention;
      if (_isEntityQuery) {
        const _queryResult = await tryQueryRouter({ message, orgId, orgContext, supabase, precomputedClassification: _classification });
        if (_queryResult) return _queryResult;
      }
    }

    const results = await dispatchPlan({ validPlan, orgId, supabase, orgContext });
    const merged = results.length === 1
      ? _attachSuggestedActions(results[0].result, results[0].suggested_next_actions)
      : _mergeQueryResults(results);
    return { ...merged, execution_plan: null, pending_plan_id: null };
  }

  // PATH B: Has mutations → build preview, store plan, return plan card
  if (planClass === 'requires_confirmation' || planClass === 'requires_preview') {

    // B1: Build read-only preview
    let planCard;
    try {
      planCard = await buildExecutionPlanCard({ validPlan, orgId, supabase, orgContext });
    } catch (err) {
      console.error('[freeform] plan builder error:', err.message);
      return _fallback('Could not build execution preview. Please try again.');
    }

    if (!planCard || planCard.empty || planCard.error) {
      return { response_text: planCard?.summary_text || 'No matching records found.', chart_data: null, next_action: null, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
    }

    // Entity ambiguity — return clarification card with tappable options
    // Owner selects the right entity via POST /api/home/select-entity
    // No plan stored yet — plan regenerated after selection
    if (planCard.clarification_needed) {
      return {
        response_text: planCard.clarification_text,
        chart_data: null,
        next_action: null,
        message_type: 'entity_clarification',
        clarification_type: planCard.clarification_type,
        clarification_options: planCard.options,
        original_params: planCard.original_params,
        original_capability: planCard.capability,
        original_label: planCard.label,
        execution_plan: null,
        pending_plan_id: null,
      };
    }

    // B2: Store plan server-side — client only gets UUID
    let pendingPlanId = null;
    try {
      const { data: savedPlan, error: saveErr } = await supabase
        .from('ai_actions')
        .insert({
          organisation_id: orgId,
          action_name: planCard.label || planCard.capability,
          action_type: 'freeform_plan',
          trigger_event: 'owner_freeform',
          trigger_entity: planCard.capability,
          prompt_template: message,
          model: 'gpt-4o-mini',
          parameters: {
            plan_steps: planCard._plan_steps,
            preview_count: planCard.affected_count,
            ai_conversation_id: conversationId,
            scope,
            org_context: { currency: orgContext.currency, language: orgContext.language },
          },
          status: 'pending',
          confidence_score: Math.min(1.0, Math.max(0.0, planResult.confidence || 0.9)),
        })
        .select('id')
        .single();

      if (saveErr) {
        console.error('[freeform] ai_actions save failed:', saveErr.message);
      } else {
        pendingPlanId = savedPlan?.id || null;
      }
    } catch (err) {
      console.error('[freeform] ai_actions error:', err.message);
    }

    // B3: Strip _plan_steps before sending to client
    const clientPlanCard = buildClientPlanCard(planCard);

    return {
      response_text: planCard.summary_text,
      chart_data: null,
      next_action: null,
      message_type: 'execution_plan',
      execution_plan: clientPlanCard,
      pending_plan_id: pendingPlanId,
    };
  }

  return _fallback('Could not process this request. Please try again.');
}

function _attachSuggestedActions(result, suggestedNextActions) {
  if (!result.next_action && suggestedNextActions?.length > 0) {
    result.next_action = {
      text: 'Next: ' + suggestedNextActions.slice(0, 2).map(c => c.replace(/_/g, ' ')).join(' · '),
      type: suggestedNextActions[0],
      entities: [],
      execution_mode: null,
      prefill: null,
    };
  }
  return result;
}

function _mergeQueryResults(results) {
  const texts = results.filter(r => r.status === 'success').map(r => r.result.response_text).filter(Boolean);
  const firstChart = results.find(r => r.result?.chart_data)?.result?.chart_data || null;
  const lastAction = [...results].reverse().find(r => r.result?.next_action)?.result?.next_action || null;
  return { response_text: texts.join('\n\n'), chart_data: firstChart, next_action: lastAction, message_type: 'ai_response' };
}

function _fallback(message) {
  return { response_text: message, chart_data: null, next_action: null, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
}

// ── Brain 3: World Intelligence (unified open-world fallback) ────────────────
// Jun 2026
//
// ONE unified engine for everything that isn't a structured business query
// (Layer 1: QueryRouter) or an executable action (Layer 2: Planner).
//
// Covers (via ONE prompt — no sub-classification):
//   - Greetings / social ("Hi", "Hello", "Thanks")
//   - AssistMe coaching ("How do I record a payment?")
//   - World knowledge ("What is GST?", "What is a proforma invoice?")
//   - Business advice ("Customer hasn't paid in 60 days, what should I do?")
//   - Genuinely unknown intents that don't map to any capability
//
// NEVER says "I can't help" / "I'm not sure how to help". If a capability is
// genuinely missing, explains honestly + offers alternatives + continues helping.
//
// POLYGLOT: responds in whatever language the owner's message uses — detected
// by the model itself, not hardcoded to org default language.
//
// MEMORY HIERARCHY (explicit precedence when information conflicts):
//   1. Current user message
//   2. Recent conversation messages (last 8, verbatim)
//   3. Conversation memory summary (Brain 2.5, older context)
//   4. Organization context (currency, business name)
//
// OUTPUT CONTRACT (Option C — server-side gating, not GPT-driven telemetry):
//   { response_text, message_type: 'world_intelligence', capability_gap, normalized_intent }
//   Phase 1 (this session): capability_gap always false, normalized_intent always null.
//   Phase 2 (future): server-side rules will set these based on structured signals.
//
// orgId + supabase accepted now (unused in Phase 1) to avoid a second plumbing
// patch when Phase 2 (capability-gap logging to missing_capabilities) lands.
//
// Modifies existing production surface: NO — new function, called from new
// fallback paths only (does not change any existing capability/queryRouter flow)

const BRAIN3_SYSTEM_PROMPT = `You are AssistMe's business operating partner — a knowledgeable COO/CFO-level assistant for a small business owner (Indian MSME trader).

You understand sales, collections, procurement, finance, operations, customer relationships, and small business growth. You also know how AssistMe works — a WhatsApp-style business assistant where owners manage customers, invoices, payments, deliveries, and reminders through natural conversation.

YOUR ROLE:
- If the owner asks how to use AssistMe → explain clearly and simply, as if teaching a friend.
- If the owner asks a business or world-knowledge question (GST, proforma invoice, payment terms, negotiation, etc.) → answer it well.
- If the owner asks for advice (e.g. "customer hasn't paid in 60 days, what should I do?") → give practical, actionable advice.
- If the owner is just greeting or making conversation → respond warmly and briefly, then offer to help.
- If AssistMe genuinely cannot do something the owner asked for → say so honestly, explain what AssistMe can do instead, and continue being helpful.

CRITICAL RULES:
- NEVER say "I can't help with that" or "I'm not sure how to help" or similar dead-end phrases.
- ALWAYS respond in the SAME LANGUAGE the owner used in their current message (Hindi, Urdu, Gujarati, Tamil, English, Hinglish, or any mix — match it naturally).
- Keep responses concise and conversational — this is a chat interface, not a report. 2-5 sentences for most answers.
- No markdown headers. Light formatting (bullets, bold) only when it genuinely aids clarity.

MEMORY HIERARCHY — when information conflicts, prioritize in this order:
1. The owner's CURRENT message (highest priority — always address this directly)
2. RECENT MESSAGES (last 8 turns, verbatim — immediate conversation context)
3. CONVERSATION MEMORY (older context, summarized — background only)
4. ORGANIZATION CONTEXT (business name, currency — for personalization only)

Do not over-index on conversation memory if it conflicts with what the owner is asking right now.`;

// ── In-app Help lookup (Org AI v1-Completion, Task C) ──────────────────────
// Feature Knowledge Registry retrieval. Calls the search_help_articles RPC
// (trigger-maintained tsvector, multilingual keywords: en + hi + roman-hi)
// and, on a match, narrates the article's steps/pitfalls through a strict
// app-usage-only guardrail. Returns a response object on hit, or null to
// let the caller fall through to general Brain 3 knowledge.
//
// GUARDRAIL: the model may ONLY use the provided article content. It must
// never surface backend/DB/infrastructure/security details, and must never
// invent steps that are not in the article. Content safety comes from the
// curated help_articles rows, not from trusting the model.
const HELP_GUARDRAIL_PROMPT = [
  'You are AssistMe\'s in-app help assistant, guiding an MSME business owner',
  'on how to USE the AssistMe app.',
  'Answer ONLY using the help article provided below. Walk the owner through',
  'the steps in order, mentioning the on-screen buttons and screens named in',
  'the article. If the article lists pitfalls, weave in the relevant one.',
  'NEVER discuss databases, code, servers, infrastructure, APIs, security, or',
  'anything not present in the article. NEVER invent steps, screens, or buttons',
  'that are not in the article. Keep it short, friendly, and action-first.',
  'If the owner asked in Hindi or a mix, reply in that same style.',
].join(' ');

async function tryHelpArticle({ message, supabase, orgContext, orgId }) {
  try {
    if (!message || !supabase) return null;
    // Uses the search_help_articles RPC (matches the codebase convention of
    // search_products_fuzzy / search_customers_fuzzy -- search logic lives in
    // a Postgres function, called via .rpc(), rather than the PostgREST
    // .textSearch() client method which isn't used elsewhere here).
    const { data, error } = await supabase
      .rpc('search_help_articles', { p_query: message });
    if (error) {
      console.warn('[Help] search error (non-blocking):', error.message);
      return null;
    }
    if (!data || data.length === 0) return null;

    const article = data[0];
    const openai = orgContext?.openai;

    // Build a plain-text rendering of the article for the model to narrate.
    const stepsText = (article.steps || [])
      .map((s, i) => `${i + 1}. [${s.screen || ''}] ${s.text || ''}`)
      .join('\n');
    const pitfallsText = (article.pitfalls || []).length
      ? '\nGood to know:\n' + (article.pitfalls || []).map(p => `- ${p}`).join('\n')
      : '';
    const articleBlock = `HELP ARTICLE: ${article.title}\nSteps:\n${stepsText}${pitfallsText}`;

    // If OpenAI is unavailable, return the raw article steps directly --
    // still accurate, just un-narrated. Never fabricates.
    if (!openai) {
      return {
        response_text: `${article.title}\n\n${stepsText}${pitfallsText}`,
        message_type: 'help_article',
        capability_gap: false,
        normalized_intent: null,
        chart_data: null,
        next_action: null,
        execution_plan: null,
        pending_plan_id: null,
      };
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: HELP_GUARDRAIL_PROMPT },
        { role: 'user', content: `${articleBlock}\n\nOwner's question: ${message}` },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget.
    if (orgId && supabase) {
      recordAiUsage({
        orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    }

    const response_text = completion.choices?.[0]?.message?.content?.trim();
    if (!response_text) {
      // Model returned nothing -- fall back to raw steps rather than failing.
      return {
        response_text: `${article.title}\n\n${stepsText}${pitfallsText}`,
        message_type: 'help_article',
        capability_gap: false,
        normalized_intent: null,
        chart_data: null,
        next_action: null,
        execution_plan: null,
        pending_plan_id: null,
      };
    }

    console.log('[Help]', { matchedSlug: article.slug });
    return {
      response_text,
      message_type: 'help_article',
      capability_gap: false,
      normalized_intent: null,
      chart_data: null,
      next_action: null,
      execution_plan: null,
      pending_plan_id: null,
    };
  } catch (err) {
    console.warn('[Help] lookup failed (non-blocking):', err.message);
    return null;
  }
}

export async function handleWorldIntelligence({ message, orgId, supabase, orgContext, conversationHistory = [], conversationSummary = null, trigger = 'unknown' }) {
  const openai = orgContext?.openai;
  console.log('[Brain3]', { trigger, messagePreview: message?.substring(0, 40) });

  // In-app help pre-check (Task C): if this looks like a how-to question the
  // help_articles registry can answer, return that instead of falling
  // through to general knowledge. Non-blocking -- any failure returns null
  // and the normal Brain 3 path continues.
  const helpResult = await tryHelpArticle({ message, supabase, orgContext, orgId });
  if (helpResult) return helpResult;

  if (!openai) {
    return { response_text: "Could you tell me a bit more about what you're trying to do? I can help with business questions, customers, payments, products, sales, or how to use AssistMe.", message_type: 'world_intelligence', capability_gap: false, normalized_intent: null, chart_data: null, next_action: null, execution_plan: null, pending_plan_id: null };
  }

  try {
    const orgContextLine = orgContext?.currency
      ? `\n\nORGANIZATION CONTEXT: Currency is ${orgContext.currency}.`
      : '';

    const messages = [
      { role: 'system', content: BRAIN3_SYSTEM_PROMPT + orgContextLine },
    ];

    if (conversationSummary) {
      messages.push({
        role: 'system',
        content: `CONVERSATION MEMORY (older context, background only — see memory hierarchy above):\n${conversationSummary}`,
      });
    }

    for (const m of (conversationHistory || []).slice(-8)) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: String(m.content || '').slice(0, 1000) });
      }
    }

    messages.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 500,
      temperature: 0.5,
    });

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget.
    if (orgId && supabase) {
      recordAiUsage({
        orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    }

    const response_text = completion.choices?.[0]?.message?.content?.trim()
      || "Could you tell me a bit more about what you're trying to do? I can help with business questions, customers, payments, products, sales, or how to use AssistMe.";

    console.log('[Brain3]', { trigger, responseLength: response_text.length, hasSummary: !!conversationSummary });

    return {
      response_text,
      message_type: 'world_intelligence',
      capability_gap: false,
      normalized_intent: null,
      chart_data: null,
      next_action: null,
      execution_plan: null,
      pending_plan_id: null,
    };
  } catch (err) {
    console.error('[Brain3] error:', { trigger, error: err.message });
    return {
      response_text: "Could you tell me a bit more about what you're trying to do? I can help with business questions, customers, payments, products, sales, or how to use AssistMe.",
      message_type: 'world_intelligence',
      capability_gap: false,
      normalized_intent: null,
      chart_data: null,
      next_action: null,
      execution_plan: null,
      pending_plan_id: null,
    };
  }
}
