/**
 * AssistMe — Memory Key Registry
 * Location: /backend/src/services/ai/memory/memoryKeyRegistry.js
 * Session 6C — canonical memory key definitions
 * Registry Version: 1
 *
 * PURPOSE:
 *   Single source of truth for all valid entity_memory keys.
 *   Registry owns: memory_class, merge strategy, TTL, retrieval group, priority.
 *   Registry does NOT own: gate hint → retrieval group mapping (lives in adapter).
 *   GPT output validated against this. Unknown keys rejected.
 *
 * GPT OUTPUT CONTRACT (frozen):
 *   GPT returns ONLY: { memory_key, value, confidence, reason, derived_from }
 *   GPT does NOT return: memory_class, operation, merge strategy
 *   memory_class and merge strategy are derived from this registry.
 *   operation (create/update) is derived by adapter from DB state.
 *   GPT may signal: no_change, expire, replace_summary — these require reasoning.
 *
 * STRUCTURE:
 *   ENTITY_KEYS[entity_type][memory_key] = { class, merge, ttlDays, retrievalGroup, priority, description }
 *   entity_type: 'customer' | 'owner' (future: 'product' | 'supplier' | 'organisation')
 *
 * MERGE STRATEGIES (string metadata — switch implementation lives in adapter only):
 *   immutable       — never overwrite (identity facts: GST, PAN, email)
 *   synthesize      — GPT merges old + new into narrative (preferences, relationships)
 *   evolve          — one living summary updated over time (behavioural patterns)
 *   replace         — latest value wins (temporary signals, opportunities)
 *
 * RETRIEVAL GROUPS (domain labels — adapter owns hint→group mapping):
 *   always           — always included in GPT context
 *   products         — product/buying related memories
 *   payments         — payment related memories
 *   relationships    — relationship/contact memories
 *   events           — future events and visits
 *   communication    — communication style memories
 *
 * PRIORITY (0–100):
 *   Used for future compaction — higher priority memories retrieved first
 *   when context window is constrained. Not used in v1 retrieval.
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
    gst_number:            { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 100, description: 'Customer GST number' },
    pan_number:            { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 100, description: 'Customer PAN number' },
    business_address:      { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 90,  description: 'Customer business address' },
    email:                 { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 90,  description: 'Customer email address' },
    alternate_phone:       { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 90,  description: 'Customer alternate phone' },
    bank_account:          { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 85,  description: 'Customer bank account details' },
    business_name:         { class: 'historical_fact',    merge: 'immutable',  ttlDays: null, retrievalGroup: 'always',        priority: 95,  description: 'Formal business name' },

    // Relationship — permanent signals
    decision_maker:        { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', priority: 95,  description: 'Who makes purchase decisions' },
    procurement_contact:   { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', priority: 90,  description: 'Who handles procurement' },
    family_relationship:   { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', priority: 80,  description: 'Family member involved in business' },
    business_relationship: { class: 'relationship_fact',  merge: 'synthesize', ttlDays: null, retrievalGroup: 'relationships', priority: 85,  description: 'Nature of business relationship' },

    // Preference — evolves, synthesized when conflicting
    preferred_product:     { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'products',      priority: 90,  description: 'Customer preferred products' },
    preferred_brand:       { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'products',      priority: 85,  description: 'Customer preferred brands' },
    preferred_channel:     { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'communication', priority: 75,  description: 'Preferred communication channel' },
    preferred_language:    { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'always',        priority: 95,  description: 'Customer preferred language' },
    product_category:      { class: 'preference',         merge: 'synthesize', ttlDays: null, retrievalGroup: 'products',      priority: 80,  description: 'Preferred product category' },

    // Behavioural patterns — one living summary
    payment_pattern:       { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'payments',      priority: 90,  description: 'Payment timing and behaviour' },
    buying_pattern:        { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      priority: 85,  description: 'Buying frequency and volume' },
    order_frequency:       { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      priority: 80,  description: 'How often customer orders' },
    order_size:            { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      priority: 80,  description: 'Typical order size' },
    seasonal_pattern:      { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'products',      priority: 75,  description: 'Seasonal buying behaviour' },
    delivery_preference:   { class: 'behavioral_pattern', merge: 'evolve',     ttlDays: null, retrievalGroup: 'always',        priority: 70,  description: 'Delivery expectations' },

    // Opportunity — expires if not reinforced
    current_interest:      { class: 'opportunity',        merge: 'replace',    ttlDays: 90,   retrievalGroup: 'products',      priority: 85,  description: 'Current product interest or enquiry' },
    pending_quotation:     { class: 'opportunity',        merge: 'replace',    ttlDays: 30,   retrievalGroup: 'products',      priority: 80,  description: 'Quotation requested but not sent' },
    new_requirement:       { class: 'opportunity',        merge: 'replace',    ttlDays: 60,   retrievalGroup: 'products',      priority: 80,  description: 'New business requirement expressed' },

    // Temporary signals — auto-expire
    payment_delay:         { class: 'temporary_signal',   merge: 'replace',    ttlDays: 30,   retrievalGroup: 'payments',      priority: 75,  description: 'Current payment delay situation' },
    upcoming_visit:        { class: 'temporary_signal',   merge: 'replace',    ttlDays: 14,   retrievalGroup: 'events',        priority: 70,  description: 'Planned visit or meeting' },
    current_complaint:     { class: 'temporary_signal',   merge: 'replace',    ttlDays: 14,   retrievalGroup: 'always',        priority: 80,  description: 'Active complaint or issue' },
    urgent_request:        { class: 'temporary_signal',   merge: 'replace',    ttlDays: 7,    retrievalGroup: 'always',        priority: 85,  description: 'Time-sensitive request' },

    // Summary — future compaction use
    customer_summary:      { class: 'summary',            merge: 'replace',    ttlDays: null, retrievalGroup: 'always',        priority: 95,  description: 'GPT-synthesized customer overview' },
  },

  // ── Owner persona signals ───────────────────────────────────────────────────
  owner: {
    greeting_style:           { class: 'preference',         merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 90,  description: 'Owner greeting pattern' },
    language_mix:             { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 95,  description: 'Language mixing pattern' },
    message_length_style:     { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 75,  description: 'Typical message length' },
    followup_style:           { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 70,  description: 'How owner follows up' },
    voice_note_preference:    { class: 'preference',         merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 65,  description: 'Voice note usage pattern' },
    owner_tone_with_customer: { class: 'preference',         merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 85,  description: 'Tone used with this customer' },
    emoji_usage:              { class: 'behavioral_pattern', merge: 'evolve', ttlDays: null, retrievalGroup: 'always',        priority: 50,  description: 'Emoji usage pattern' },
  },

  // Future entity types — reserved for expansion
  // product: {},
  // supplier: {},
  // organisation: {},
};

// ── Valid GPT-decidable operations ───────────────────────────────────────────
// create/update derived by adapter from DB state — not GPT's responsibility.
export const GPT_OPERATIONS = new Set([
  'no_change',       // GPT saw this key but decided nothing changed
  'expire',          // GPT believes this fact is no longer valid
  'replace_summary', // GPT synthesizes old + new into a new narrative value
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get registry metadata for a key within an entity type.
 * @param {string} entityType — 'customer' | 'owner'
 * @param {string} key
 * @returns {object|null}
 */
export function getKeyMeta(entityType, key) {
  return ENTITY_KEYS[entityType]?.[key] || null;
}

/**
 * Check if a key is valid for an entity type and not deprecated.
 * @param {string} entityType
 * @param {string} key
 * @returns {boolean}
 */
export function isValidKey(entityType, key) {
  const meta = getKeyMeta(entityType, key);
  return !!meta && meta.deprecated !== true;
}

/**
 * Get all keys for an entity type that belong to given retrieval groups.
 * Called by distillationAdapter with groups derived from gate hints.
 * Note: hint→group mapping lives in distillationAdapter, not here.
 * @param {string} entityType
 * @param {string[]} groups
 * @returns {string[]} — memory keys to fetch from entity_memory
 */
export function getKeysForRetrieval(entityType, groups) {
  const keyMap = ENTITY_KEYS[entityType] || {};
  const groupSet = new Set(groups);
  return Object.entries(keyMap)
    .filter(([, meta]) => groupSet.has(meta.retrievalGroup) && meta.deprecated !== true)
    .map(([key]) => key);
}
