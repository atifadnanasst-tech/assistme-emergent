/**
 * AssistMe — Org AI Routes
 *
 * Location: /services/ai/orgAi/routes.js
 * Created: 2026-05-21
 * Purpose: 4 routes for Home AI tab.
 *
 * Auth: uses authenticateChat(c) — same pattern as all existing routes.
 *       No JWT middleware assumed. Token validated per-request via Supabase.
 *
 * Routes:
 *   GET  /api/home/ai-conversations     — list org AI conversations
 *   POST /api/home/ai-conversations     — create new org AI conversation
 *   GET  /api/home/ai-messages          — messages for a conversation (ascending)
 *   POST /api/home/ai-query             — menu item dispatch OR freeform stub
 *
 * Permissions note (future):
 *   Owner + Manager roles both permitted for now.
 *   Tier-based restrictions (Dukaan/Saathi/Tajir) to be added when subscription
 *   schema columns are active. No gate added here yet.
 */

import { dispatchMenuQuery } from './index.js';
import { dispatchFreeform } from './freeform.js';
import { randomUUID } from 'crypto';

// ── Server-owned menu labels ──────────────────────────────────
// Backend owns these — never trust frontend-supplied labels.
// Used for: input validation + chat history user bubble content + AI context continuity.
// Any menu_id not in this map is rejected with 400.
// TODO: future refactor — centralize into shared menu registry { id, icon, label }
// Emoji-prefixed to ensure hydration parity with optimistic UI bubbles
const MENU_LABELS = {
  collections_today:      '📥 Collections Today',
  total_outstanding:      '🔴 Total Outstanding',
  top_customers:          '🏆 Top Customers',
  revenue_this_month:     '📊 Revenue This Month',
  invoices_due_this_week: '📋 Invoices Due This Week',
  weekly_trend:           '📈 Weekly Trend',
  follow_up_today:        '📞 Follow Up Today',
  risk_alerts:            '⚠️ Risk Alerts',
  gone_silent:            '🔇 Gone Silent',
  top_sellers:            '⭐ Top Sellers',
  low_stock:              '🔴 Low Stock',
  slow_moving:            '🐌 Slow Moving',
  deliveries_today:       '🚚 Deliveries Today',
  expiring_quotes:        '📄 Expiring Quotes',
  todays_tasks:           "✅ Today's Tasks",
  what_i_owe:             '💸 What I Owe Suppliers',
  overdue_payables:       '⏰ Overdue Payables',
  top_supplier:           '🥇 Top Supplier',
};

export function registerOrgAiRoutes(app, supabase, authenticateChat, getOpenAI) {

  // ── GET /api/home/ai-conversations ───────────────────────────
  app.get('/api/home/ai-conversations', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const { data, error } = await supabase
        .from('ai_conversations')
        .select('id, title, last_message_at, message_count, created_at')
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .is('deleted_at', null)
        .order('last_message_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return c.json({ conversations: data || [] });
    } catch (error) {
      console.error('GET /api/home/ai-conversations error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/ai-conversations ──────────────────────────
  app.post('/api/home/ai-conversations', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const { data, error } = await supabase
        .from('ai_conversations')
        .insert({
          organisation_id: organisationId,
          customer_id: null,
          scope: 'org',
          initiated_by: 'owner',
          title: 'Business Assistant',
        })
        .select('id, title, created_at')
        .single();

      if (error) throw error;
      return c.json({ conversation: data });
    } catch (error) {
      console.error('POST /api/home/ai-conversations error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── GET /api/home/ai-messages ─────────────────────────────────
  // Returns ascending (oldest first) — consistent with customer AI tab.
  app.get('/api/home/ai-messages', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const aiConversationId = c.req.query('ai_conversation_id');
      if (!aiConversationId) return c.json({ error: 'missing_ai_conversation_id' }, 400);

      const { data: convCheck } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', aiConversationId)
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .maybeSingle();

      if (!convCheck) return c.json({ error: 'conversation_not_found' }, 403);

      // Cursor-based pagination — same pattern as customer chat
      const before = c.req.query('before');
      const LIMIT = 30;

      let query = supabase
        .from('messages')
        .select('id, role, content, canonical_text, input_modality, metadata, created_at, ai_conversation_id')
        .eq('organisation_id', organisationId)
        .eq('ai_conversation_id', aiConversationId)
        .order('created_at', { ascending: false })
        .limit(LIMIT + 1);

      if (before) query = query.lt('created_at', before);

      const { data: msgs, error } = await query;

      if (error) throw error;
      const all = msgs || [];
      const has_more = all.length > LIMIT;
      const messages = has_more ? all.slice(0, LIMIT) : all;

      // Enrich execution_plan messages with current ai_actions.status
      // Prevents stale Confirm buttons on reload after execution/cancellation
      const planMessages = messages.filter(m => m.metadata?.message_type === 'execution_plan' && m.metadata?.pending_plan_id);
      if (planMessages.length > 0) {
        const planIds = [...new Set(planMessages.map(m => m.metadata?.pending_plan_id).filter(Boolean))];
        const { data: planStatuses } = await supabase
          .from('ai_actions')
          .select('id, status')
          .in('id', planIds);

        const statusMap = {};
        for (const p of (planStatuses || [])) statusMap[p.id] = p.status;

        for (const m of messages) {
          if (m.metadata?.message_type === 'execution_plan' && m.metadata?.pending_plan_id) {
            m.metadata.plan_status = statusMap[m.metadata.pending_plan_id] || 'pending';
          }
        }
      }

      return c.json({ messages, has_more });
    } catch (error) {
      console.error('GET /api/home/ai-messages error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/ai-query ───────────────────────────────────
  app.post('/api/home/ai-query', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json();
      const { menu_id, message, ai_conversation_id } = body;

      if (!ai_conversation_id) return c.json({ error: 'missing_ai_conversation_id' }, 400);
      if (!menu_id && !message) return c.json({ error: 'missing_menu_id_or_message' }, 400);

      // Validate menu_id against server-owned enum — reject unknown IDs
      if (menu_id && !MENU_LABELS[menu_id]) {
        return c.json({ error: 'invalid_menu_id', valid_ids: Object.keys(MENU_LABELS) }, 400);
      }

      // Verify conversation belongs to this org and is org-scoped
      const { data: convCheck } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', ai_conversation_id)
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .maybeSingle();

      if (!convCheck) return c.json({ error: 'invalid_ai_conversation_id' }, 403);

      // Fetch org currency
      const { data: org } = await supabase
        .from('organisations')
        .select('currency')
        .eq('id', organisationId)
        .maybeSingle();

      const orgCurrency = org?.currency || 'INR';
      const orgLanguage = auth.primaryLanguage || 'en';

      // User bubble content — backend owns menu labels, never frontend
      const userContent = menu_id
        ? MENU_LABELS[menu_id]
        : (message || '');

      // Save user message
      const { error: userMsgError } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          ai_conversation_id,
          role: 'user',
          content: userContent,
          input_modality: 'text',
          metadata: {
            sender_type: 'owner',
            visibility: 'owner_only',
            message_type: 'ai_query',
            preview_text: userContent.substring(0, 50),
            read_by_owner: true,
            menu_id: menu_id || null,
          },
        });
      if (userMsgError) console.error('[orgAi] user message insert failed:', userMsgError.message);

      // Dispatch
      let result;
      if (menu_id) {
        const openai = getOpenAI();
        result = await dispatchMenuQuery(menu_id, supabase, organisationId, orgCurrency, openai, orgLanguage);
      } else {
        const { data: recentMsgs } = await supabase
          .from('messages')
          .select('role, content')
          .eq('ai_conversation_id', ai_conversation_id)
          .order('created_at', { ascending: false })
          .limit(8);
        const conversationHistory = (recentMsgs || []).reverse();

        const openai = getOpenAI();
        result = await dispatchFreeform({
          message,
          orgId: organisationId,
          orgContext: {
            currency: orgCurrency,
            language: orgLanguage,
            openai,
          },
          conversationId: ai_conversation_id,
          supabase,
          scope: 'org',
          conversationHistory,
        });
      }

      // Save AI response message
      const { data: savedMsg, error: aiMsgError } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          ai_conversation_id,
          role: 'assistant',
          content: result.response_text,
          canonical_text: result.response_text,
          input_modality: 'text',
          metadata: {
            sender_type: 'ai',
            visibility: 'owner_only',
            message_type: result.message_type || 'ai_response',
            chart_data: result.chart_data || null,
            next_action: result.next_action || null,
            execution_plan: result.execution_plan || null,
            pending_plan_id: result.pending_plan_id || null,
            clarification_type: result.clarification_type || null,
            clarification_options: result.clarification_options || null,
            clarification_context: result.original_capability ? {
              capability: result.original_capability,
              params: result.original_params,
              label: result.original_label,
            } : null,
            preview_text: result.response_text.substring(0, 50),
            read_by_owner: true,
            menu_id: menu_id || null,
          },
        })
        .select('id')
        .single();
      if (aiMsgError) console.error('[orgAi] AI response insert failed:', aiMsgError.message);

      // Update conversation last_message_at only — message_count recalculated later
      const { error: convUpdateError } = await supabase
        .from('ai_conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', ai_conversation_id);
      if (convUpdateError) console.error('[orgAi] conversation update failed:', convUpdateError.message);

      return c.json({
        message_id: savedMsg?.id,
        response: result.response_text,
        chart_data: result.chart_data || null,
        next_action: result.next_action || null,
        message_type: result.message_type || 'ai_response',
        execution_plan: result.execution_plan || null,
        pending_plan_id: result.pending_plan_id || null,
        clarification_type: result.clarification_type || null,
        clarification_options: result.clarification_options || null,
        clarification_context: result.original_capability ? {
          capability: result.original_capability,
          params: result.original_params,
          label: result.original_label,
        } : null,
      });

    } catch (error) {
      console.error('POST /api/home/ai-query error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/execute-action ─────────────────────────────
  // Centralized action execution endpoint — business intent layer
  // Writes to action_log. Future: WhatsApp send, email, workflows, retries.
  // org context derived from JWT — never trusted from frontend.
  app.post('/api/home/execute-action', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId, userId } = auth;

      const body = await c.req.json();
      const {
        action_type,
        signal_type = null,
        source_surface = null,
        channel = 'whatsapp',
        execution_mode = null,
        entities = [],
        message = null,
      } = body;

      if (!action_type) return c.json({ error: 'action_type required' }, 400);

      const execution_id = randomUUID();

      if (entities.length > 0) {
        const rows = entities
          .map(entity => ({
            organisation_id: organisationId,
            entity_type: 'customer',
            entity_id: entity.customer_id,
            action_type,
            signal_type,
            source_surface,
            execution_id,
            channel,
            status: 'simulated', // Future: sent → delivered → responded → failed lifecycle
            actor_user_id: userId || null,
            metadata: {
              origin: 'org_ai',
              customer_name: entity.customer_name,
              amount: entity.amount,
              invoice_number: entity.invoice_number || null,
              message: message || null,
              execution_mode,
              action_type,
              signal_type,
              source_surface,
            },
            actioned_at: new Date().toISOString(),
          }))
          .filter(r => r.entity_id); // Guard: skip null entity_id rows

        if (rows.length > 0) {
          const { error: insertError } = await supabase
            .from('action_log')
            .insert(rows);

          if (insertError) {
            console.error('[execute-action] action_log insert error:', insertError.message);
            return c.json({ error: 'log_failed' }, 500);
          }
        }
      }

      console.log('[execute-action]', { action_type, signal_type, source_surface, entities: entities.length, execution_id });
      return c.json({ success: true, execution_id, logged: entities.length });

    } catch (error) {
      console.error('POST /api/home/execute-action error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/execute-plan ───────────────────────────────
  // Session I-B: Confirms and executes a pending freeform plan.
  //
  // SECURITY MODEL:
  //   - org ownership verified from JWT — never from body
  //   - plan params loaded server-side from ai_actions (client sent UUID only)
  //   - atomic claim via UPDATE WHERE status='pending' prevents double-execution
  //   - 5-minute expiry enforced before execution
  //   - drift detection re-runs selector and rejects if product count changed
  //
  // STATUS FLOW (ai_actions):
  //   pending → approved (atomic claim) → executed (after successful run)
  //   pending → rejected (expired or drifted)
  //   approved → failed (unexpected execution error)
  app.post('/api/home/execute-plan', async (c) => {
    let claimedPlanId = null;

    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json();
      const { pending_plan_id } = body;

      if (!pending_plan_id) return c.json({ error: 'pending_plan_id required' }, 400);

      const { data: planRow, error: fetchErr } = await supabase
        .from('ai_actions')
        .select('id, organisation_id, action_type, status, parameters, created_at')
        .eq('id', pending_plan_id)
        .eq('organisation_id', organisationId)
        .eq('action_type', 'freeform_plan')
        .maybeSingle();

      if (fetchErr || !planRow) {
        return c.json({ error: 'plan_not_found' }, 404);
      }

      const ageMs = Date.now() - new Date(planRow.created_at).getTime();
      if (ageMs > 5 * 60 * 1000) {
        await supabase.from('ai_actions').update({ status: 'rejected' })
          .eq('id', pending_plan_id).eq('status', 'pending');
        return c.json({ error: 'plan_expired', message: 'This plan has expired. Please make your request again.' }, 410);
      }

      const { data: claimed, error: claimErr } = await supabase
        .from('ai_actions')
        .update({ status: 'approved' })
        .eq('id', pending_plan_id)
        .eq('organisation_id', organisationId)
        .eq('status', 'pending')
        .select('id')
        .single();

      if (claimErr || !claimed) {
        return c.json({ error: 'plan_already_executed', message: 'This plan was already confirmed or is being processed.' }, 409);
      }

      claimedPlanId = pending_plan_id;

      const { plan_steps, preview_count, ai_conversation_id, org_context } = planRow.parameters || {};

      if (!plan_steps || plan_steps.length === 0) {
        await supabase.from('ai_actions').update({ status: 'failed' }).eq('id', claimedPlanId);
        return c.json({ error: 'invalid_plan' }, 400);
      }

      const { data: org } = await supabase.from('organisations').select('currency')
        .eq('id', organisationId).maybeSingle();
      const orgCurrency = org?.currency || org_context?.currency || 'INR';

      const isMultiStep = plan_steps.length > 1;
      const stepResults = [];
      let stoppedAtStep = null;
      const execution_id = randomUUID();

      // Sequential execution — stop on first failure
      // Failure = _mutation_result.operation === 'failed' OR is_success === false
      for (let stepIdx = 0; stepIdx < plan_steps.length; stepIdx++) {
        const step = plan_steps[stepIdx];
        const { capability: stepCap, params: stepParams } = step;

        // Drift detection — single-step mutate_product only
        // Multi-step drift deferred: preview_count is aggregate, not per-step
        // TODO: per-step drift detection in future session
        if (!isMultiStep && stepCap === 'mutate_product' && preview_count !== null && preview_count !== undefined) {
          const { resolveProductSelectorCount } = await import('../../capabilities/productSelector.js');
          const { count: currentCount, error: countErr } = await resolveProductSelectorCount({
            selector: stepParams?.selector || {},
            orgId: organisationId,
            supabase,
          });
          if (!countErr && currentCount !== preview_count) {
            await supabase.from('ai_actions').update({ status: 'rejected' }).eq('id', claimedPlanId);
            claimedPlanId = null;
            return c.json({
              error: 'plan_drifted',
              message: 'Product list changed since preview. Previously ' + preview_count + ' products, now ' + currentCount + '. Please make your request again.',
              preview_count, current_count: currentCount,
            }, 409);
          }
        }

        let stepResult;
        if (stepCap === 'mutate_product') {
          const { mutateProductCapability } = await import('../../capabilities/mutationCapabilities.js');
          stepResult = await mutateProductCapability(stepParams, organisationId, supabase, { currency: orgCurrency });
        } else if (stepCap === 'mutate_payment') {
          const { mutatePaymentCapability } = await import('../../capabilities/paymentCapabilities.js');
          stepResult = await mutatePaymentCapability(stepParams, organisationId, supabase, { currency: orgCurrency });
        } else {
          await supabase.from('ai_actions').update({ status: 'failed' }).eq('id', claimedPlanId);
          claimedPlanId = null;
          return c.json({ error: 'capability_not_implemented', message: 'Execution of "' + stepCap + '" is coming soon.' }, 501);
        }

        // Canonical failure detection using _mutation_result contract
        const stepFailed = stepResult?._mutation_result?.operation === 'failed'
          || stepResult?._mutation_result?.is_success === false;

        stepResults.push({
          stepIdx,
          capability: stepCap,
          response_text: stepResult?.response_text,
          affected_count: stepResult?._mutation_result?.affected_count || 0,
          operation: stepResult?._mutation_result?.operation,
          is_success: !stepFailed,
          failed: stepFailed,
          raw_result: stepResult,
        });

        if (stepFailed) {
          stoppedAtStep = stepIdx;
          console.warn('[execute-plan] step', stepIdx + 1, 'failed — stopping. operation:', stepResult?._mutation_result?.operation);
          break;
        }

        console.log('[execute-plan] step', stepIdx + 1, '/', plan_steps.length, stepCap, 'affected:', stepResult?._mutation_result?.affected_count);
      }

      // Overall status
      const executedSteps = stepResults.filter(s => !s.failed).length;
      const overallDetail = executedSteps === plan_steps.length ? 'completed'
        : executedSteps > 0 ? 'partial' : 'failed';
      const dbStatus = overallDetail === 'completed' ? 'executed' : 'failed';
      // Note: partial stored as 'failed' in DB (schema constraint) — detail in execution_result JSONB
      // TODO: future migration — add 'partially_executed' to ai_actions status CHECK constraint

      // Persist status + step results
      await supabase.from('ai_actions')
        .update({
          status: dbStatus,
          last_run_at: new Date().toISOString(),
          run_count: executedSteps,
          parameters: {
            ...planRow.parameters,
            execution_result: {
              overall_status: overallDetail,
              executed_steps: executedSteps,
              total_steps: plan_steps.length,
              stopped_at_step: stoppedAtStep,
              step_results: stepResults,
            },
          },
        })
        .eq('id', claimedPlanId);
      claimedPlanId = null;

      // Build COO response
      // Single-step: preserve raw capability result unchanged
      // Multi-step: synthesize combined response from step results
      const primaryCapability = plan_steps[0]?.capability;
      let executionResult;

      if (!isMultiStep) {
        executionResult = stepResults[0]?.raw_result || {
          response_text: 'Done.',
          chart_data: null,
          next_action: null,
          message_type: 'ai_response',
          _mutation_result: { affected_count: 0, operation: 'unknown' },
        };
      } else {
        const summaryLine = overallDetail === 'completed'
          ? 'Done. ' + executedSteps + ' of ' + plan_steps.length + ' steps completed.'
          : executedSteps + ' of ' + plan_steps.length + ' steps completed. ' + (plan_steps.length - executedSteps) + ' failed.';
        executionResult = {
          response_text: summaryLine,
          chart_data: null,
          next_action: null,
          message_type: 'multi_step_result',
          step_results: stepResults.map((s, i) => ({
            step_index: i,
            capability: s.capability,
            response_text: s.response_text,
            failed: s.failed,
            affected_count: s.affected_count,
          })),
          _mutation_result: { affected_count: null, operation: overallDetail },
        };
      }

      // Write action_log
      await supabase.from('action_log').insert({
        organisation_id: organisationId,
        entity_type: 'organisation',
        entity_id: organisationId,
        action_type: isMultiStep ? 'multi_step' : primaryCapability,
        signal_type: 'freeform_execution',
        source_surface: 'org_ai_freeform',
        execution_id,
        channel: 'in_app',
        status: 'sent',
        metadata: {
          pending_plan_id,
          step_count: plan_steps.length,
          executed_steps: executedSteps,
          overall_status: overallDetail,
          capabilities: plan_steps.map(s => s.capability),
        },
        actioned_at: new Date().toISOString(),
      });

      // No suggested actions for multi-step
      const { getSuggestedNextActions } = await import('../../ai/capabilityRegistry.js');
      const suggested = isMultiStep ? [] : getSuggestedNextActions(primaryCapability);

      console.log('[execute-plan]', { pending_plan_id, steps: plan_steps.length, executed: executedSteps, overall: overallDetail, execution_id });

      // Complete failure — return error so frontend shows Alert not a message bubble
      if (overallDetail === 'failed' && executedSteps === 0) {
        const failedStep = stepResults[0];
        return c.json({
          error: 'execution_failed',
          message: failedStep?.response_text || 'This plan could not be executed. The data may have changed — please make a fresh request.',
        }, 400);
      }

      // Save result message to DB so it survives reload
      if (ai_conversation_id) {
        await supabase.from('messages').insert({
          organisation_id: organisationId,
          ai_conversation_id,
          role: 'assistant',
          content: executionResult.response_text,
          canonical_text: executionResult.response_text,
          input_modality: 'text',
          metadata: {
            sender_type: 'ai',
            visibility: 'owner_only',
            message_type: executionResult.message_type || 'ai_response',
            chart_data: executionResult.chart_data || null,
            next_action: executionResult.next_action || null,
            step_results: executionResult.step_results || null,
            execution_plan: null,
            pending_plan_id: null,
            preview_text: (executionResult.response_text || '').substring(0, 50),
            read_by_owner: true,
          },
        });
      }

      return c.json({
        success: true,
        execution_id,
        response_text: executionResult.response_text,
        chart_data: executionResult.chart_data || null,
        next_action: executionResult.next_action || null,
        message_type: executionResult.message_type || 'ai_response',
        step_results: executionResult.step_results || null,
        suggested_next_actions: suggested,
      });

    } catch (error) {
      if (claimedPlanId) {
        await supabase.from('ai_actions').update({ status: 'failed' })
          .eq('id', claimedPlanId).eq('status', 'approved');
      }
      console.error('POST /api/home/execute-plan error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/cancel-plan ────────────────────────────────
  // Cancels a pending freeform plan. Only works if status = 'pending'.
  // Sets status = 'rejected' (schema allows: pending/approved/rejected/executed/failed).
  app.post('/api/home/cancel-plan', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json();
      const { pending_plan_id } = body;
      if (!pending_plan_id) return c.json({ error: 'pending_plan_id required' }, 400);

      // Atomic cancel — only if still pending and owned by this org
      const { data: cancelled, error: cancelErr } = await supabase
        .from('ai_actions')
        .update({ status: 'rejected' })
        .eq('id', pending_plan_id)
        .eq('organisation_id', organisationId)
        .eq('status', 'pending')
        .select('id')
        .single();

      if (cancelErr || !cancelled) {
        return c.json({ error: 'plan_not_cancellable', message: 'This plan has already been executed, cancelled, or does not exist.' }, 409);
      }

      console.log('[cancel-plan]', { pending_plan_id, org: organisationId });
      return c.json({ success: true });

    } catch (error) {
      console.error('POST /api/home/cancel-plan error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/select-entity ─────────────────────────────
  // Owner selects the correct entity from a clarification card.
  // Stores alias in entity_aliases, regenerates execution plan.
  app.post('/api/home/select-entity', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json();
      const { entity_id, entity_type, alias, clarification_context, ai_conversation_id } = body;

      if (!entity_id || !entity_type || !alias || !clarification_context) {
        return c.json({ error: 'missing required fields' }, 400);
      }

      // Store alias — owner's confirmed mapping
      const normalised = alias.toLowerCase().trim();
      const { error: aliasErr } = await supabase
        .from('entity_aliases')
        .upsert({
          organisation_id: organisationId,
          entity_type,
          entity_id,
          alias,
          normalised,
          source_type: 'owner_selection',
          usage_count: 1,
          confirmed_count: 1,
          last_confirmed_at: new Date().toISOString(),
        }, {
          onConflict: 'organisation_id,entity_type,normalised',
          ignoreDuplicates: false,
        });

      if (aliasErr) console.error('[select-entity] alias upsert failed:', aliasErr.message);
      else console.log('[select-entity] alias stored:', normalised, '→', entity_id);

      // Regenerate execution plan with confirmed entity injected into params
      const { capability, params, label } = clarification_context;
      const updatedParams = { ...params };

      if (entity_type === 'customer') {
        updatedParams.customer = { customer_id: entity_id };
      } else if (entity_type === 'product') {
        updatedParams.selector = { product_id: entity_id };
      }

      const { buildExecutionPlanCard, buildClientPlanCard } = await import('../executionPlanBuilder.js');
      const { data: org } = await supabase.from('organisations').select('currency').eq('id', organisationId).maybeSingle();
      const orgCurrency = org?.currency || 'INR';

      const planCard = await buildExecutionPlanCard({
        validPlan: [{ capability, params: updatedParams, label, _confirmation: 'always', _is_financial: true, _middleware_fn: null }],
        orgId: organisationId,
        supabase,
        orgContext: { currency: orgCurrency },
      });

      if (!planCard || planCard.clarification_needed || planCard.empty || planCard.error) {
        return c.json({ error: 'plan_generation_failed', message: planCard?.summary_text || 'Could not generate plan.' }, 422);
      }

      // Store plan in ai_actions
      let pendingPlanId = null;
      const { data: savedPlan, error: saveErr } = await supabase
        .from('ai_actions')
        .insert({
          organisation_id: organisationId,
          action_name: planCard.label || capability,
          action_type: 'freeform_plan',
          trigger_event: 'entity_selection',
          trigger_entity: capability,
          prompt_template: alias,
          model: 'gpt-4o-mini',
          parameters: {
            plan_steps: planCard._plan_steps,
            preview_count: planCard.affected_count,
            ai_conversation_id,
            org_context: { currency: orgCurrency },
          },
          status: 'pending',
          confidence_score: 1.0,
        })
        .select('id')
        .single();

      if (saveErr) console.error('[select-entity] ai_actions save failed:', saveErr.message);
      else pendingPlanId = savedPlan?.id || null;

      const clientPlanCard = buildClientPlanCard(planCard);

      return c.json({
        success: true,
        alias_stored: !aliasErr,
        message_type: 'execution_plan',
        response: planCard.summary_text,
        execution_plan: clientPlanCard,
        pending_plan_id: pendingPlanId,
      });

    } catch (error) {
      console.error('POST /api/home/select-entity error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });
}
