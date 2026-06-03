/**
 * AssistMe — Plan Validator
 *
 * Location: /backend/src/services/ai/validator.js
 * Created: Session I-A, Jun 2026
 *
 * PURPOSE: Guards between planner output and dispatcher execution.
 *          Catches hallucinated capability names before anything is dispatched.
 *          Session I: unknown intents logged to console only.
 *          Session II: will upsert to missing_capabilities table.
 */

import { getCapability, requiresFullConfirmation } from './capabilityRegistry.js';

export function validatePlan({ plan, userPrompt, orgId, scope }) {
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
      console.warn('[MISSING_CAPABILITY]', JSON.stringify({
        detected_intent: capName,
        user_prompt: userPrompt?.substring(0, 200),
        organisation_id: orgId,
        scope,
        timestamp: new Date().toISOString(),
      }));
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
