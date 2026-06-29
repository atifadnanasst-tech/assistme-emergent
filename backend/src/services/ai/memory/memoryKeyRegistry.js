/**
 * AssistMe — Memory Key Registry
 * Location: /backend/src/services/ai/memory/memoryKeyRegistry.js
 * Session 6C — canonical memory key definitions
 * Registry Version: 1
 *
 * PURPOSE:
 *   Single source of truth for all valid entity_memory keys.
 *   Registry owns: memory_class, merge metadata, TTL, retrieval group.
 *   Registry does NOT own: gate hint → retrieval group mapping (lives in adapter).
 *   GPT output validated against this. Unknown keys rejected.
 *
 * V1 GPT OUTPUT CONTRACT (frozen):
 *   GPT returns ONLY: { memory_key, value, confidence, reason, derived_from }
 *   GPT does NOT return: memory_class, operation, merge strategy — all derived here.
 *   Empty changes[] = nothing to write. Non-empty = update these memories.
 *   No operation field in v1. Operations (expire, replace_summary, append)
 *   introduced in v2 when merge semantics are implemented end-to-end.
 *
 * STRUCTURE:
 *   ENTITY_KEYS[entity_type][memory_key] = { class, merge, ttlDays, retrievalGroup, description }
 *   entity_type: 'customer' | 'owner' (future: 'product' | 'supplier' | 'organisation')
 *
 * MERGE METADATA (descriptive in v1 — execution logic introduced by adapter in later versions):
 *   immutable  — never overwrite (identity facts: GST, PAN, email)
 *   synthesize — GPT merges old + new into narrative (preferences, relationships)
 *   evolve     — one living summary updated over time (behavioural patterns)
 *   replace    — latest value wins (temporary signals, opportunities)
 *   Note: In v1, only 'immutable' has execution semantics in the adapter.
 *         All other merge values are metadata reserved for future adapter behavior.
 *
 * RETRIEVAL GROUPS (domain labels — adapter owns hint→group mapping):
 *   always        — always included in GPT context
 *   products      — product/buying related memories
 *   payments      — payment related memories
 *   relationships — relationship/contact memories
 *   events        — future events and visits
 *   communication — communication style memories
 *
 * TTL:
 *   ttlDays: null = permanent. Number = expires N days after last write.
 *   Enforcement deferred to v2 — stored now as registry doctrine.
 *
 * DEFERRED (not in v1):
 *   priority  — retrieval ranking for context compaction (no engine yet)
 *   expire    — soft-delete operation (no implementation yet)
 *   replace_summary — merge operation (no implementation yet)
 *
 * ADDING KEYS:
 *   Add entry, bump REGISTRY_VERSION. Never remove — set deprecated: true.
 *   Schema is expand-never-contract.
 *
 * DOCTRINE REF: ASSISTME_DISTILLATION_ENGINE_MEMORY_DOCTRINE.md
 */

export const REGISTRY_VERSION = 1;

export const ENTITY_KEYS = {

  // ── Customer facts ──────────────────────────────────────────────────────────
  customer: {

    // Identity — immutable, store exactly, never summarize
    gst_number:            { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Customer GST number' },
    pan_number:            { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Customer PAN number' },
    business_address:      { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Customer business address' },
    email:                 { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Customer email address' },
    alternate_phone:       { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Customer alternate phone' },
    bank_account:          { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Customer bank account details' },
    business_name:         { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        description: 'Formal business name' },

    // Relationship — permanent signals
    decision_maker:        { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', description: 'Who makes purchase decisions' },
    procurement_contact:   { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', description: 'Who handles procurement' },
    family_relationship:   { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', description: 'Family member involved in business' },
    business_relationship: { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', description: 'Nature of business relationship' },

    // Preference — evolves, synthesized when conflicting
    preferred_product:     { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'products',      description: 'Customer preferred products' },
    preferred_brand:       { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'products',      description: 'Customer preferred brands' },
    preferred_channel:     { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'communication', description: 'Preferred communication channel' },
    preferred_language:    { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'always',        description: 'Customer preferred language' },
    product_category:      { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'products',      description: 'Preferred product category' },

    // Behavioural patterns — one living summary
    payment_pattern:       { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'payments',      description: 'Payment timing and behaviour' },
    buying_pattern:        { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      description: 'Buying frequency and volume' },
    order_frequency:       { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      description: 'How often customer orders' },
    order_size:            { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      description: 'Typical order size' },
    seasonal_pattern:      { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      description: 'Seasonal buying behaviour' },
    delivery_preference:   { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'always',        description: 'Delivery expectations' },

    // Opportunity — expires if not reinforced
    current_interest:      { class: 'opportunity',        merge: 'replace',    ttlDays: 90,   retrievalGroup: 'products',      description: 'Current product interest or enquiry' },
    pending_quotation:     { class: 'opportunity',        merge: 'replace',    ttlDays: 30,   retrievalGroup: 'products',      description: 'Quotation requested but not sent' },
    new_requirement:       { class: 'opportunity',        merge: 'replace',    ttlDays: 60,   retrievalGroup: 'products',      description: 'New business requirement expressed' },

    // Temporary signals — auto-expire
    payment_delay:         { class: 'temporary_signal',   merge: 'replace',    ttlDays: 30,   retrievalGroup: 'payments',      description: 'Current payment delay situation' },
    upcoming_visit:        { class: 'temporary_signal',   merge: 'replace',    ttlDays: 14,   retrievalGroup: 'events',        description: 'Planned visit or meeting' },
    current_complaint:     { class: 'temporary_signal',   merge: 'replace',    ttlDays: 14,   retrievalGroup: 'always',        description: 'Active complaint or issue' },
    urgent_request:        { class: 'temporary_signal',   merge: 'replace',    ttlDays: 7,    retrievalGroup: 'always',        description: 'Time-sensitive request' },

    // Summary — future compaction use
    customer_summary:      { class: 'summary',            merge: 'replace',    ttlDays: null, retrievalGroup: 'always',        description: 'GPT-synthesized customer overview' },
  },

  // ── Owner persona signals ───────────────────────────────────────────────────
  // Written via writeInteractionProfile — not extracted by distillationAdapter in v1.
  owner: {
    greeting_style:           { class: 'preference',         merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'Owner greeting pattern' },
    language_mix:             { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'Language mixing pattern' },
    message_length_style:     { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'Typical message length' },
    followup_style:           { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'How owner follows up' },
    voice_note_preference:    { class: 'preference',         merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'Voice note usage pattern' },
    owner_tone_with_customer: { class: 'preference',         merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'Tone used with this customer' },
    emoji_usage:              { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always', description: 'Emoji usage pattern' },
  },

  // Future entity types — reserved for expansion
  // product: {},
  // supplier: {},
  // organisation: {},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getKeyMeta(entityType, key) {
  return ENTITY_KEYS[entityType]?.[key] || null;
}

export function isValidKey(entityType, key) {
  const meta = getKeyMeta(entityType, key);
  return !!meta && meta.deprecated !== true;
}

export function getKeysForRetrieval(entityType, groups) {
  const keyMap = ENTITY_KEYS[entityType] || {};
  const groupSet = new Set(groups);
  return Object.entries(keyMap)
    .filter(([, meta]) => groupSet.has(meta.retrievalGroup) && meta.deprecated !== true)
    .map(([key]) => key);
}
