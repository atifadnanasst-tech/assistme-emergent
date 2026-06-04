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
import { buildExecutionPlanCard } from '../executionPlanBuilder.js';

export async function dispatchFreeform({
  message,
  orgId,
  orgContext,
  conversationId,
  supabase,
  scope = 'org',
  conversationHistory = [],
}) {
  const openai = orgContext.openai;

  // Step 1: Plan
  let planResult;
  try {
    planResult = await planExecution({ userMessage: message, scope, orgContext, conversationHistory, openai });
  } catch (err) {
    console.error('[freeform] planner error:', err.message);
    return _fallback('AI planning failed. Please try again.');
  }

  // Step 2: Clarification needed?
  if (planResult.clarification_needed) {
    return { response_text: planResult.clarification_needed, chart_data: null, next_action: null, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
  }

  if (!planResult.plan || planResult.plan.length === 0) {
    return { response_text: "I'm not sure how to help with that. Try asking about your sales, customers, products, or payments — or use the menu categories above.", chart_data: null, next_action: null, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
  }

  // Step 3: Validate
  const { validPlan, unknownCapabilities } = await validatePlan({ plan: planResult.plan, userPrompt: message, orgId, scope, supabase });

  if (validPlan.length === 0) {
    const intentDesc = unknownCapabilities.length > 0
      ? unknownCapabilities.slice(0, 2).map(c => `"${c.replace(/_/g, ' ')}"`).join(' or ')
      : 'that';
    return { response_text: `I understand what you're trying to do, but AssistMe can't perform ${intentDesc} yet. I've recorded this as a capability request so the AssistMe team can prioritise it in a future update. In the meantime, I can help you analyse your business data — try asking about sales, customers, products, invoices, or payments.`, chart_data: null, next_action: null, message_type: 'ai_response', execution_plan: null, pending_plan_id: null };
  }

  // Step 4: Classify
  const planClass = classifyPlan(validPlan);

  // PATH A: Query-only → execute immediately
  if (planClass === 'execute_immediately') {
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
    const clientPlanCard = {
      capability: planCard.capability,
      label: planCard.label,
      operation: planCard.operation,
      operation_description: planCard.operation_description,
      affected_count: planCard.affected_count,
      preview_rows: planCard.preview_rows,
      more_count: planCard.more_count,
      currency: planCard.currency,
    };

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
