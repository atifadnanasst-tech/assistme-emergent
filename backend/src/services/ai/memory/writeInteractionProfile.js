/**
 * AssistMe — Memory Engine Primitive 3B
 * writeInteractionProfile(orgId, customerId, interactionProfile, supabase)
 *
 * Location: /backend/src/services/ai/memory/writeInteractionProfile.js
 * Created: 24 Jun 2026
 * Audit: v1.1 — auditor conditional approval, documentation note added
 *
 * DB TOUCHPOINTS (this file only):
 *   READS:  customers.custom_fields
 *   WRITES: customers.custom_fields.interaction_profile (merge only)
 *   NEVER:  entity_memory, action_log, or any other table
 *
 * WHAT THIS IS NOT:
 *   interaction_profile is behavioral metadata about how the owner communicates
 *   with a specific customer. It is NOT source-of-truth memory.
 *   Source-of-truth memory lives in entity_memory (writeEntityMemory.js).
 *   These are different concepts with different lifecycles:
 *     entity_memory     — facts about the customer (governed, source-ranked, audited)
 *     interaction_profile — owner communication style per customer (behavioral, lightweight)
 *
 * WHY SEPARATE FROM writeEntityMemory (Primitive 3A):
 *   Not every ingestion channel that writes entity_memory should update
 *   interaction_profile. WhatsApp import updates both. Live distillation may
 *   update entity_memory without touching interaction_profile. Keeping them
 *   separate lets each ingestion channel choose independently.
 *
 * SCHEMA TOUCHPOINTS (verified 24 Jun 2026 against schema_sql_v3.txt)
 *   customers.custom_fields — JSONB, NOT NULL DEFAULT '{}'
 *   Existing keys in production (verified 24 Jun 2026):
 *     avatar_color, health_score, cross_org, payment_terms,
 *     delivery_preference, default_invoice_type, language
 *   Key added by this primitive:
 *     interaction_profile — new namespace, no collision confirmed
 *   Merge pattern matches existing backend usage (index.js ~line 5170):
 *     { ...currentFields, interaction_profile: { ...existing, ...incoming } }
 *
 * INTERACTION PROFILE SCHEMA (v1 fields — expand never remove)
 *   greeting_used:            string | null
 *   typical_close:            string | null
 *   language_mix:             string | null
 *   owner_tone_with_customer: string | null
 *   message_length_style:     string | null
 *   emoji_usage:              string | null
 *   voice_note_preference:    string | null
 *   followup_style:           string | null
 *   last_distilled_at:        ISO string
 *   source:                   string
 *   importJobId:              string | null
 *
 * V2 NOTE:
 *   When AI begins sending messages on owner's behalf, interaction_profile
 *   is the primary input for matching owner's voice per customer.
 *   This field is write-only in v1 — nothing reads it yet.
 *   Post-v1: AI drafting layer reads this to impersonate owner tone per customer.
 */

/**
 * writeInteractionProfile — main export
 *
 * Safe merge write to customers.custom_fields.interaction_profile.
 * Null incoming values do NOT overwrite existing non-null values.
 * Partial updates are always safe.
 *
 * @param {string} orgId
 * @param {string} customerId
 * @param {object} interactionProfile  — from extractMemoryCandidates().interactionProfile
 * @param {object} supabase            — Supabase client
 *
 * @returns {{ success: boolean, skipped?: boolean, reason?: string, error?: string }}
 */
export async function writeInteractionProfile(orgId, customerId, interactionProfile, supabase) {
  if (!orgId || !customerId) {
    return { success: false, error: 'orgId and customerId are required' };
  }

  if (!interactionProfile || Object.keys(interactionProfile).length === 0) {
    return { success: true, skipped: true, reason: 'empty_profile' };
  }

  const { data: customer, error: readErr } = await supabase
    .from('customers')
    .select('custom_fields')
    .eq('id', customerId)
    .eq('organisation_id', orgId)
    .maybeSingle();

  if (readErr) {
    console.error('[writeInteractionProfile] read failed:', readErr.message);
    return { success: false, error: readErr.message };
  }

  const currentFields = customer?.custom_fields || {};
  const existingProfile = currentFields.interaction_profile || {};

  // Merge: null incoming values do not overwrite existing non-null values
  const mergedProfile = { ...existingProfile };
  for (const [k, v] of Object.entries(interactionProfile)) {
    if (v !== null && v !== undefined) {
      mergedProfile[k] = v;
    }
  }

  const updatedFields = {
    ...currentFields,
    interaction_profile: mergedProfile,
  };

  const { error: writeErr } = await supabase
    .from('customers')
    .update({ custom_fields: updatedFields, updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .eq('organisation_id', orgId);

  if (writeErr) {
    console.error('[writeInteractionProfile] write failed:', writeErr.message);
    return { success: false, error: writeErr.message };
  }

  return { success: true };
}
