/**
 * AssistMe — Memory Engine Primitive 4
 * generateIntelligenceReport(candidates, stats, customerName)
 *
 * Location: /backend/src/services/ai/memory/generateIntelligenceReport.js
 * Created: 24 Jun 2026
 * Audit: v1.0 — pure transformer, no DB, no GPT, auditor pre-approved
 *
 * DB TOUCHPOINTS: NONE
 *   Pure transformation function.
 *   No DB reads. No DB writes. No GPT calls. No side effects.
 *   Safe to call anywhere, safe to retry infinitely.
 *
 * PURPOSE:
 *   Produce the owner-facing Intelligence Report after WhatsApp import
 *   or on-demand from the Customer Intelligence screen.
 *   Output is consumed by the Intelligence Report UI — not stored directly.
 *   After owner approves the report, the import adapter calls writeEntityMemory()
 *   and writeInteractionProfile() to persist the approved facts.
 *
 * OWNER REVIEW FLOW:
 *   extractMemoryCandidates()         — P2
 *     ↓
 *   generateIntelligenceReport()      — P4 (this file)
 *     ↓
 *   Show report to owner (Intelligence Report screen)
 *     ↓
 *   Owner taps [Looks Good]
 *     ↓
 *   writeEntityMemory()               — P3A (with reviewStatus='owner_approved')
 *   writeInteractionProfile()         — P3B
 *
 * CATEGORY MAPPING (which facts go in which report section):
 *   relationship  — historical_fact, relationship_fact, preference class facts
 *   products      — any fact whose key or value contains product-related keywords
 *   commercial    — behavioral_pattern facts not product-related
 *   opportunities — opportunity class facts
 *   ownerStyle    — all ownerPersonaSignals
 *   temporary     — temporary_signal class facts
 *
 * INPUTS:
 *   candidates   — output from extractMemoryCandidates() (P2)
 *   stats        — output from parseConversationText() stats field (P1)
 *   customerName — display name for the report header
 *
 * OUTPUT SHAPE:
 *   {
 *     summary: {
 *       customerName, messagesAnalyzed, ownerMessages, customerMessages,
 *       mediaShared, dateFrom, dateTo, relationshipAge
 *     },
 *     byCategory: {
 *       relationship, products, commercial, opportunities, ownerStyle, temporary
 *     },
 *     needsReview: Fact[],    — confidence < 0.70, shown with caution flag
 *     ignored: object[],
 *     counts: { toStore, needsReview, ignored, total },
 *     interactionProfile: object
 *   }
 */

const RELATIONSHIP_CLASSES = new Set(['historical_fact', 'relationship_fact', 'preference']);
const PRODUCT_KEY_HINTS    = ['product', 'interest', 'order', 'volume', 'requirement',
                               'sku', 'buy', 'purchase', 'cedarwood', 'sandalwood',
                               'oud', 'attar', 'oil', 'kg', 'ton'];

/**
 * Categorize a customer fact into a report section.
 */
function categorize(fact) {
  if (fact.class === 'opportunity')       return 'opportunities';
  if (fact.class === 'temporary_signal')  return 'temporary';
  if (RELATIONSHIP_CLASSES.has(fact.class)) return 'relationship';
  // behavioral_pattern — check if product-related by key or value
  const keyLower = fact.key.toLowerCase();
  const valLower = fact.value.toLowerCase();
  if (PRODUCT_KEY_HINTS.some(h => keyLower.includes(h) || valLower.includes(h))) return 'products';
  return 'commercial';
}

/**
 * Format a date range into human-readable relationship age.
 * e.g. "3 months" or "1.2 years"
 */
function formatRelationshipAge(from, to) {
  if (!from) return null;
  const start = new Date(from);
  const end   = to ? new Date(to) : new Date();
  const days  = Math.round((end - start) / (1000 * 60 * 60 * 24));
  if (days < 1)   return 'today';
  if (days < 30)  return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 365) return `${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'}`;
  return `${(days / 365).toFixed(1)} years`;
}

/**
 * Format ISO date to readable string: "17 Mar 2026"
 */
function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  } catch {
    return null;
  }
}

/**
 * generateIntelligenceReport — main export
 *
 * @param {object} candidates   — output from extractMemoryCandidates()
 * @param {object} stats        — output from parseConversationText() stats field
 * @param {string} customerName — display name for report header
 *
 * @returns {object} report
 */
export function generateIntelligenceReport(candidates, stats, customerName) {
  const byCategory = {
    relationship:  [],
    products:      [],
    commercial:    [],
    opportunities: [],
    ownerStyle:    [],
    temporary:     [],
  };

  // Categorize customer toStore facts
  for (const fact of (candidates.customerFacts?.toStore || [])) {
    const cat = categorize(fact);
    byCategory[cat].push(fact);
  }

  // All owner persona toStore facts go to ownerStyle
  for (const fact of (candidates.ownerPersonaSignals?.toStore || [])) {
    byCategory.ownerStyle.push(fact);
  }

  // Collect all needsReview facts (customer + owner) for caution section
  const needsReview = [
    ...(candidates.customerFacts?.needsReview      || []),
    ...(candidates.ownerPersonaSignals?.needsReview || []),
  ];

  const allToStore = [
    ...(candidates.customerFacts?.toStore          || []),
    ...(candidates.ownerPersonaSignals?.toStore     || []),
  ];

  const dateRange = stats?.dateRange || {};
  const summary = {
    customerName:     customerName || 'Customer',
    messagesAnalyzed: stats?.totalTurns      || 0,
    ownerMessages:    stats?.ownerTurns      || 0,
    customerMessages: stats?.customerTurns   || 0,
    mediaShared:      stats?.mediaCount      || 0,
    dateFrom:         formatDate(dateRange.from),
    dateTo:           formatDate(dateRange.to),
    relationshipAge:  formatRelationshipAge(dateRange.from, dateRange.to),
  };

  const counts = {
    toStore:     allToStore.length,
    needsReview: needsReview.length,
    ignored:     (candidates.ignored || []).length,
    total:       allToStore.length + needsReview.length,
  };

  return {
    summary,
    byCategory,
    needsReview,
    ignored:            candidates.ignored || [],
    counts,
    interactionProfile: candidates.interactionProfile || {},
  };
}
