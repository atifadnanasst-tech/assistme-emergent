/**
 * AssistMe — Capability Dispatcher
 *
 * Location: /backend/src/services/ai/dispatcher.js
 * Created: Session I-A, Jun 2026
 *
 * PURPOSE: Routes validated capability name → middleware function.
 *          Pure routing. No business logic. No AI calls.
 *          After execution, attaches deterministic suggested_next_actions.
 *
 * SESSION I: query capabilities bridge to existing orgAi functions.
 *            mutate_product is the only mutation wired.
 *            All others return not_implemented gracefully.
 */

import { getSuggestedNextActions } from './capabilityRegistry.js';
import { dispatchMenuQuery } from '../ai/orgAi/index.js';
import { mutateProductCapability } from '../capabilities/mutationCapabilities.js';
import { mutatePaymentCapability } from '../capabilities/paymentCapabilities.js';
import { recordOpeningPositionCapability } from '../capabilities/openingPositionCapability.js';

const DISPATCH_MAP = {

  query_daily_summary: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('collections_today', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_overdue_payments: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('total_outstanding', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_customers: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('top_customers', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_collection_insights: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('total_outstanding', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_inventory: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('low_stock', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_top_products: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('top_sellers', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_invoices: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('invoices_due_this_week', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_tasks: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('todays_tasks', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_suppliers: async (params, orgId, supabase, orgContext) =>
    dispatchMenuQuery('top_supplier', supabase, orgId, orgContext.currency, orgContext.openai, orgContext.language),

  query_bank_summary: async (params, orgId, supabase, orgContext) => {
    const { data: accounts } = await supabase
      .from('bank_accounts')
      .select('id, name, current_balance, bank_name')
      .eq('organisation_id', orgId);
    const total = (accounts || []).reduce((s, a) => s + (a.current_balance || 0), 0);
    return {
      response_text: `Total cash: ₹${total.toLocaleString('en-IN')} across ${(accounts || []).length} account(s).`,
      chart_data: {
        type: 'ranked_list',
        title: 'Bank Balances',
        currency: orgContext.currency || 'INR',
        series: (accounts || []).map(a => ({ label: a.name || a.bank_name, value: a.current_balance || 0 })),
      },
      next_action: null,
      message_type: 'ai_response',
    };
  },

  mutate_product: async (params, orgId, supabase, orgContext) =>
    mutateProductCapability(params, orgId, supabase, orgContext),

  mutate_payment: async (params, orgId, supabase, orgContext) =>
    mutatePaymentCapability(params, orgId, supabase, orgContext),

  record_opening_position: async (params, orgId, supabase, orgContext) =>
    recordOpeningPositionCapability(params, orgId, supabase, orgContext),
};

export async function dispatch({ capability, params, orgId, supabase, orgContext }) {
  const fn = DISPATCH_MAP[capability];

  if (!fn) {
    console.warn('[dispatcher] not implemented:', capability);
    return {
      status: 'not_implemented',
      capability,
      result: {
        response_text: `"${capability.replace(/_/g, ' ')}" is coming soon.`,
        chart_data: null,
        next_action: null,
      },
      suggested_next_actions: getSuggestedNextActions(capability),
    };
  }

  try {
    const result = await fn(params, orgId, supabase, orgContext);
    const suggested = getSuggestedNextActions(capability);
    console.log('[dispatcher] executed:', capability);
    return { status: 'success', capability, result, suggested_next_actions: suggested };
  } catch (err) {
    console.error('[dispatcher] error:', capability, err.message);
    return {
      status: 'failed',
      capability,
      result: { response_text: 'Something went wrong. Please try again.', chart_data: null, next_action: null },
      suggested_next_actions: [],
      error: err.message,
    };
  }
}

export async function dispatchPlan({ validPlan, orgId, supabase, orgContext }) {
  const results = [];
  for (const step of validPlan) {
    const result = await dispatch({ capability: step.capability, params: step.params, orgId, supabase, orgContext });
    results.push({ step, ...result });
  }
  return results;
}
