/**
 * AssistMe — Distillation Gate
 * Location: /backend/src/services/ai/memory/distillationGate.js
 * Session 6B — GPT cost gate for the live distillation pipeline
 * Gate Version: 1
 *
 * PURPOSE:
 *   Decides whether a canonical_text message is worth sending to GPT (P2).
 *   This is NOT a memory extractor. P2 (extractMemoryCandidates) is the
 *   authoritative extractor. This gate only answers one question:
 *   "Is there any chance this message contains business memory?"
 *
 * THREE OUTCOMES:
 *   'ignore'     — Whole message is a greeting/pleasantry. Skip GPT entirely.
 *                  Only used when ENTIRE message is trivial — never a prefix check.
 *   'maybe'      — Uncertain. Has substance but no clear signal.
 *                  Conservative choice: run GPT anyway.
 *                  False negatives (lost knowledge) cost more than GPT tokens.
 *   'definitely' — Clear linguistic signal present. Run GPT.
 *
 * HINTS:
 *   Describe what was OBSERVED linguistically — not what was inferred.
 *   P2 receives hints as context and decides business meaning.
 *   Gate never classifies memory class.
 *
 * OBSERVABILITY:
 *   Every result includes reason (why) and gateVersion (which logic ran).
 *
 * API CONTRACT (stable):
 *   evaluateMessage(text) → { decision, confidence, hints, reason, gateVersion }
 *   evaluateBatch(messages) → { shouldDistill, allHints, evaluated }
 */

const GATE_VERSION = 1;

const WHOLE_MESSAGE_IGNORE = [
  { pattern: /^(ok|okay|k|hm|hmm)\.?!?$/i,                                          reason: 'whole_message_acknowledgement' },
  { pattern: /^(yes|no|nahi|nhi|na|haan|ha|ji)\.?!?$/i,                             reason: 'whole_message_acknowledgement' },
  { pattern: /^(thanks|thank\s+you|shukriya|dhanyawad|shukran|ty)\.?!?$/i,           reason: 'whole_message_pleasantry' },
  { pattern: /^(hi|hello|hey|salaam|salam|assalaam(\s+alaikum)?|namaskar|namaste)[\s,!.]*$/i, reason: 'whole_message_greeting' },
  { pattern: /^(received|dekh\s+liya|mil\s+gaya|aa\s+gaya|pahunch\s+gaya)\.?$/i,    reason: 'whole_message_acknowledgement' },
  { pattern: /^(good|accha|acha|badhiya|thik\s+hai|theek\s+hai|bilkul)[\s!.]*$/i,   reason: 'whole_message_pleasantry' },
  { pattern: /^[\u{1F300}-\u{1FFFF}\s]+$/u,                                          reason: 'whole_message_emoji' },
  { pattern: /^(inshallah|insha'?allah|mashallah|alhamdulillah)[\s!.]*$/i,           reason: 'whole_message_pleasantry' },
];

const SIGNALS = [
  { hint: 'contains_contact_pattern', pattern: /\b(gst|gstin|pan|tan|ifsc|cin)\b/i,                 confidence: 0.9 },
  { hint: 'contains_contact_pattern', pattern: /\b\d{15}\b/,                                         confidence: 0.9 },
  { hint: 'contains_contact_pattern', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/,                             confidence: 0.9 },
  { hint: 'contains_contact_pattern', pattern: /\b(account\s*(no|number)|ifsc|bank\s*detail)\b/i,    confidence: 0.8 },
  { hint: 'contains_contact_pattern', pattern: /\b(email|gmail|yahoo|mail\s*id)\b/i,                  confidence: 0.7 },
  { hint: 'contains_contact_pattern', pattern: /\b(address|pata)\b/i,                                confidence: 0.6 },
  { hint: 'contains_quantity',        pattern: /\b\d+\s*(kg|kgs|gram|gm|litre|liter|ml|piece|pcs|pc|box|carton|dozen|unit|bottle|bag|pack)\b/i, confidence: 0.8 },
  { hint: 'contains_quantity',        pattern: /\b\d+\s*(lakh|thousand|hajar)\b/i,                   confidence: 0.7 },
  { hint: 'contains_quantity',        pattern: /\b₹\s*\d+|\d+\s*rs\b/i,                             confidence: 0.6 },
  { hint: 'contains_number',          pattern: /\b\d{4,}\b/,                                         confidence: 0.3 },
  { hint: 'contains_date',            pattern: /\b\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i, confidence: 0.7 },
  { hint: 'contains_date',            pattern: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,   confidence: 0.4 },
  { hint: 'contains_future_reference',pattern: /\b(next|agle|agli)\s+(week|month|hafte|mahine)\b/i,  confidence: 0.7 },
  { hint: 'contains_future_reference',pattern: /\b(coming|aaunga|visit|aaonga|aata\s+hun)\b/i,      confidence: 0.6 },
  { hint: 'contains_future_reference',pattern: /\b(meeting|milenge|milte\s+hain)\b/i,               confidence: 0.6 },
  { hint: 'contains_person_reference',pattern: /\b(brother|bhai|bhaiya|sister|behen|didi)\b/i,      confidence: 0.6 },
  { hint: 'contains_person_reference',pattern: /\b(father|papa|abba|son|beta|partner)\b/i,          confidence: 0.5 },
  { hint: 'contains_person_reference',pattern: /\b(owner|malik|manager|incharge|handles|dekhta)\b/i,confidence: 0.6 },
  { hint: 'contains_preference_phrase',pattern: /\b(prefer|pasand|chahiye|want\s+only|only\s+want)\b/i, confidence: 0.6 },
  { hint: 'contains_preference_phrase',pattern: /\b(always|never|usually|normally|hamesha|kabhi\s+nahi)\s+\w/i,    confidence: 0.6 },
  { hint: 'contains_location',        pattern: /\b(kolkata|mumbai|delhi|hyderabad|chennai|bangalore|ahmedabad|pune|lucknow|jaipur|surat)\b/i, confidence: 0.5 },
  { hint: 'contains_location',        pattern: /\b(pin\s*code|pincode)\b/i,                          confidence: 0.7 },
  { hint: 'contains_business_noun',   pattern: /\b(quotation|quote|rate|price|stock|supply|order)\b/i,confidence: 0.6 },
  { hint: 'contains_business_noun',   pattern: /\b(sample|namuna|trial|interested)\b/i,              confidence: 0.6 },
  { hint: 'contains_business_noun',   pattern: /\b(invoice|bill|receipt|payment)\b/i,                confidence: 0.5 },
  { hint: 'contains_urgency_marker',  pattern: /\b(urgent|jaldi|abhi|immediately|asap|turant)\b/i,   confidence: 0.6 },
  { hint: 'contains_urgency_marker',  pattern: /\b(waiting|intezaar|kitna\s+time|complaint)\b/i,     confidence: 0.5 },
  { hint: 'contains_seasonal_reference',pattern: /\b(ramadan|ramzan|eid|diwali|holi|navratri|puja|christmas)\b/i, confidence: 0.6 },
  { hint: 'contains_seasonal_reference',pattern: /\b(before\s+(eid|ramadan|diwali|festival))\b/i,   confidence: 0.7 },
  { hint: 'contains_seasonal_reference',pattern: /\b(season|monsoon|garmi|sardi)\b/i,               confidence: 0.4 },
];

export function evaluateMessage(text) {
  if (!text || typeof text !== 'string') {
    return { decision: 'ignore', confidence: 1.0, hints: [], reason: 'empty_or_invalid_text', gateVersion: GATE_VERSION };
  }
  const normalized = text.trim();
  if (normalized.length < 4) {
    return { decision: 'ignore', confidence: 1.0, hints: [], reason: 'too_short', gateVersion: GATE_VERSION };
  }
  for (const { pattern, reason } of WHOLE_MESSAGE_IGNORE) {
    if (pattern.test(normalized)) {
      return { decision: 'ignore', confidence: 1.0, hints: [], reason, gateVersion: GATE_VERSION };
    }
  }
  const hitsMap = new Map();
  for (const { hint, pattern, confidence } of SIGNALS) {
    if (pattern.test(normalized)) {
      const existing = hitsMap.get(hint) || 0;
      hitsMap.set(hint, Math.max(existing, confidence));
    }
  }
  const hints = [...hitsMap.keys()];
  const sortedConfs = [...hitsMap.values()].sort((a, b) => b - a);
  const rawConf = sortedConfs.reduce((sum, c, i) => sum + c * Math.pow(0.5, i), 0);
  const confidence = Math.min(rawConf, 1.0);
  if (hints.length > 0) {
    const reason = `signal_detected:${hints.slice(0, 2).join('+')}`;
    return { decision: 'definitely', confidence: Math.max(confidence, 0.6), hints, reason, gateVersion: GATE_VERSION };
  }
  if (normalized.length > 15) {
    return { decision: 'maybe', confidence: 0.3, hints: [], reason: 'long_message_no_signal', gateVersion: GATE_VERSION };
  }
  return { decision: 'ignore', confidence: 0.9, hints: [], reason: 'short_message_no_signal', gateVersion: GATE_VERSION };
}

export function evaluateBatch(messages) {
  if (!messages || messages.length === 0) {
    return { shouldDistill: false, allHints: [], evaluated: [] };
  }
  const evaluated = messages.map(msg => ({
    id: msg.id,
    ...evaluateMessage(msg.canonical_text),
  }));
  const shouldDistill = evaluated.some(e => e.decision !== 'ignore');
  const allHints = [...new Set(evaluated.flatMap(e => e.hints))];
  return { shouldDistill, allHints, evaluated };
}
