/**
 * AssistMe — Plan Validator
 *
 * Location: /backend/src/services/ai/validator.js
 * Created: Session I-A, Jun 2026
 * Updated: Session II, Jun 2026
 *
 * PURPOSE: Guards between planner output and dispatcher execution.
 *          Catches hallucinated capability names before anything is dispatched.
 *          Unknown intents upserted to missing_capabilities table for roadmap intelligence.
 */

import { getCapability, requiresFullConfirmation } from './capabilityRegistry.js';

// Upsert unknown intent to missing_capabilities table.
// scope reserved for future roadmap analytics (not yet stored).
async function logMissingCapability({ supabase, orgId, userPrompt, detectedIntent }) {
  if (!supabase || !orgId) return;
  try {
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
        user_prompt: userPrompt?.substring(0, 500) || '',
        detected_intent: detectedIntent,
      });
    }
  } catch (err) {
    console.warn('[validator] missing_capabilities log failed:', err.message);
  }
}

export async function validatePlan({ plan, userPrompt, orgId, scope, supabase }) {
  const validPlan = [];
  const unknownCapabilities = [];
  const warnings = [];

  if (!Array.isArray(plan) || plan.length === 0) {
    return { validPlan: [], unknownCapabilities: [], warnings: [] };
  }

  for (const step of plan) {
    const capName = step.capability;

    const cap = getCapability(capName);
    if (!cap) {
      unknownCapabilities.push(capName);
      console.warn('[MISSING_CAPABILITY]', capName, '| org:', orgId);
      await logMissingCapability({ supabase, orgId, userPrompt, detectedIntent: capName });
      continue;
    }

    // Defense-in-depth: mvp_muted capabilities are already filtered out of
    // what the planner is told it can use (capabilityRegistry.js), so this
    // should never trigger in normal operation. Guards against a muted
    // capability name leaking through via conversation history or a stale
    // client -- treated the same as an unknown capability, never silently
    // included in a valid plan.
    if (cap.mvp_muted) {
      unknownCapabilities.push(capName);
      console.warn('[MUTED_CAPABILITY]', capName, '| org:', orgId);
      await logMissingCapability({ supabase, orgId, userPrompt, detectedIntent: capName });
      continue;
    }

    if (step.params !== null && typeof step.params !== 'object') {
      warnings.push(`${capName}: params coerced to {}`);
      step.params = {};
    }
    if (!step.params) step.params = {};

    if (!step.label || typeof step.label !== 'string') {
      step.label = capName.replace(/_/g, ' ');
    }

    step._requires_full_confirmation = cap.is_financial ? true : requiresFullConfirmation(capName);
    step._confirmation = cap.confirmation;
    step._is_financial = cap.is_financial;
    step._middleware_fn = cap.middleware_fn;

    validPlan.push(step);
  }

  if (warnings.length > 0) console.warn('[validator] warnings:', warnings);

  console.log('[validator]', {
    total: plan.length,
    valid: validPlan.length,
    unknown: unknownCapabilities.length,
    hasMutations: validPlan.some(s => s._requires_full_confirmation),
  });

  return { validPlan, unknownCapabilities, warnings };
}

export function classifyPlan(validPlan) {
  if (validPlan.length === 0) return 'empty';

  const hasConfirmationRequired = validPlan.some(s => s._requires_full_confirmation);
  const hasPreview = validPlan.some(s => s._confirmation === 'preview');

  if (hasConfirmationRequired) return 'requires_confirmation';
  if (hasPreview) return 'requires_preview';
  return 'execute_immediately';
}
