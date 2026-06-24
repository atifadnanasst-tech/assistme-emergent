/**
 * AssistMe — Memory Engine Primitive 2
 * extractMemoryCandidates(turns, context, openai)
 *
 * Location: /backend/src/services/ai/memory/extractMemoryCandidates.js
 * Created: 24 Jun 2026
 * Audit: v1.2 — three deployment blockers fixed (24 Jun 2026)
 *
 * Purpose:
 *   Read conversation turns (output of parseConversationText) and extract
 *   structured memory candidates via GPT-4o-mini.
 *
 * FINANCIAL FIREWALL:
 *   BLOCKED: balances, receivables, payables, invoice amounts, payment promises.
 *   ALLOWED: commercial demand signals — quantities, volumes, product interest.
 *   Example ALLOWED: "Customer requested 3060kg Cedarwood" → opportunity signal
 *   Example BLOCKED: "Customer owes ₹45,000" → financial truth, never extracted
 *
 * CHUNKING CONTRACT (audit fix v1.2):
 *   Hard limit of 100 turns. Throws if exceeded — no silent truncation.
 *   Import adapter is responsible for chunking large imports.
 *
 * AUDIO CONFIDENCE BOOST (audit fix v1.2):
 *   Removed entirely for v1. Global boost was incorrect — applied to all facts
 *   whenever any audio existed, regardless of per-fact evidence source.
 *
 * EXISTING MEMORY CONTRACT (audit fix v1.2):
 *   Context accepts existingMemoryFacts: [{key, value}] so GPT can reason
 *   about contradictions, not just avoid duplicate keys.
 *
 * Memory classes and expiry:
 *   historical_fact    → permanent
 *   relationship_fact  → permanent
 *   preference         → permanent
 *   behavioral_pattern → 90 days
 *   opportunity        → 90 days
 *   temporary_signal   → 30 days
 */

import { getOpenAI } from '../../ai-routes.js';

export const CLASS_EXPIRY_DAYS = {
  historical_fact:    null,
  relationship_fact:  null,
  preference:         null,
  behavioral_pattern: 90,
  opportunity:        90,
  temporary_signal:   30,
};

const VALID_CLASSES = new Set(Object.keys(CLASS_EXPIRY_DAYS));
const REVIEW_THRESHOLD = 0.70;
const MAX_CONFIDENCE = 1.0;
export const MAX_TURNS = 100;

function compressTurns(turns) {
  const eligible = turns.filter(t => t.role !== 'system' && !t.deleted);
  if (eligible.length > MAX_TURNS) {
    throw new Error(
      `extractMemoryCandidates: received ${eligible.length} turns, maximum is ${MAX_TURNS}. ` +
      `The import adapter must chunk large inputs before calling this function.`
    );
  }
  return eligible.map(t => {
    const dateStr = t.timestamp ? t.timestamp.substring(0, 16).replace('T', ' ') : 'unknown';
    const roleLabel = t.role === 'owner' ? 'OWNER' : 'CUSTOMER';
    if (t.mediaFlag) return `[${dateStr}] ${roleLabel}: [shared media/document]`;
    if (!t.text || !t.text.trim()) return null;
    const text = t.text.length > 300 ? t.text.substring(0, 300) + '…' : t.text;
    return `[${dateStr}] ${roleLabel}: ${text}`;
  }).filter(Boolean).join('\n');
}

function buildExtractionPrompt(compressedTurns, context) {
  const { customerName, ownerName, existingMemoryFacts = [] } = context;
  let existingNote = '';
  if (existingMemoryFacts.length > 0) {
    const factLines = existingMemoryFacts.map(f => `  ${f.key}: "${f.value}"`).join('\n');
    existingNote = `\nAlready stored memory facts (update if stronger evidence found, flag if contradicted):\n${factLines}`;
  }
  return `You are a business intelligence extraction engine for an Indian MSME trade app.
Analyze this conversation between a business owner (${ownerName || 'OWNER'}) and their customer/prospect (${customerName || 'CUSTOMER'}).
Extract structured memory facts. Return ONLY valid JSON. No markdown. No explanation.

CONVERSATION:
${compressedTurns}
${existingNote}

EXTRACT — Customer facts:
- Relationship history, communication preferences, product interest, buying patterns
- Commercial demand signals (quantities, volumes, order sizes, seasonal patterns)
- Decision-making style, open opportunities, behavioral patterns, temporary signals

EXTRACT — Owner persona signals:
- Greeting and closing phrases, tone, language mix, sales approach patterns

DO NOT EXTRACT — Financial truth:
- Outstanding balances, amounts owed, receivables, payables, invoice amounts
- Payment promises, any currency figure as a financial record

ALLOWED commercial signals (not financial truth):
- "Customer requested 3060kg Cedarwood" → opportunity (EXTRACT)
- "Typical order 5 tons per 2 months" → behavioral_pattern (EXTRACT)
- "Customer owes 45000" → DO NOT EXTRACT

DO NOT EXTRACT: personal conversation, festival greetings, Hi/Hello, promo links

CONFIDENCE: appears once ≤0.55 | 2-3 times 0.60-0.75 | 4+ times 0.80-0.95

CLASSES: historical_fact | relationship_fact | preference | behavioral_pattern | opportunity | temporary_signal

OUTPUT FORMAT (JSON only):
{
  "customerFacts": [
    { "key": "snake_case", "value": "string", "class": "one_of_6", "confidence": 0.00, "evidenceCount": 0, "evidenceSummary": "one sentence" }
  ],
  "ownerPersonaSignals": [
    { "key": "snake_case", "value": "string", "class": "preference_or_behavioral_pattern", "confidence": 0.00, "evidenceCount": 0, "evidenceSummary": "one sentence" }
  ],
  "interactionProfile": {
    "greeting_used": "phrase or null",
    "typical_close": "phrase or null",
    "language_mix": "english|hindi|urdu|english_hindi|english_urdu|mixed|null",
    "owner_tone_with_customer": "formal|consultative|warm|casual|null",
    "message_length_style": "brief|moderate|detailed|null",
    "emoji_usage": "none|rare|moderate|frequent|null",
    "voice_note_preference": "none|occasional|frequent|null",
    "followup_style": "proactive|responsive|null"
  },
  "ignored": [ { "reason": "brief reason" } ]
}`;
}

function validateAndGroup(raw, source, importJobId) {
  const sanitizeFact = (fact) => {
    if (!fact || !fact.key || !fact.value || !fact.class) return null;
    if (!VALID_CLASSES.has(fact.class)) return null;
    const confidence = Math.round(
      Math.max(0, Math.min(MAX_CONFIDENCE, Number(fact.confidence) || 0.5)) * 100
    ) / 100;
    return {
      key: String(fact.key).trim().toLowerCase().replace(/\s+/g, '_'),
      value: String(fact.value).trim(),
      class: fact.class,
      confidence,
      evidenceCount: Math.max(1, parseInt(fact.evidenceCount) || 1),
      evidenceSummary: String(fact.evidenceSummary || '').trim(),
      source,
      importJobId: importJobId || null,
    };
  };
  const allCF = (raw.customerFacts || []).map(sanitizeFact).filter(Boolean);
  const allOP = (raw.ownerPersonaSignals || []).map(sanitizeFact).filter(Boolean);
  const ip = raw.interactionProfile || {};
  const interactionProfile = {
    greeting_used:            ip.greeting_used            || null,
    typical_close:            ip.typical_close            || null,
    language_mix:             ip.language_mix             || null,
    owner_tone_with_customer: ip.owner_tone_with_customer || null,
    message_length_style:     ip.message_length_style     || null,
    emoji_usage:              ip.emoji_usage              || null,
    voice_note_preference:    ip.voice_note_preference    || null,
    followup_style:           ip.followup_style           || null,
    last_distilled_at:        new Date().toISOString(),
    source,
    importJobId:              importJobId || null,
  };
  const ignored = (raw.ignored || []).map(i => ({ reason: String(i.reason || '') }));
  return {
    customerFacts: {
      toStore:     allCF.filter(f => f.confidence >= REVIEW_THRESHOLD),
      needsReview: allCF.filter(f => f.confidence <  REVIEW_THRESHOLD),
    },
    ownerPersonaSignals: {
      toStore:     allOP.filter(f => f.confidence >= REVIEW_THRESHOLD),
      needsReview: allOP.filter(f => f.confidence <  REVIEW_THRESHOLD),
    },
    interactionProfile,
    ignored,
    counts: {
      customerToStore:     allCF.filter(f => f.confidence >= REVIEW_THRESHOLD).length,
      customerNeedsReview: allCF.filter(f => f.confidence <  REVIEW_THRESHOLD).length,
      ownerToStore:        allOP.filter(f => f.confidence >= REVIEW_THRESHOLD).length,
      ownerNeedsReview:    allOP.filter(f => f.confidence <  REVIEW_THRESHOLD).length,
      ignored:             ignored.length,
      total:               allCF.length + allOP.length,
    },
  };
}

export async function extractMemoryCandidates(turns, context, openai) {
  const {
    customerName        = '',
    ownerName           = '',
    existingMemoryFacts = [],
    source              = 'conversation_distillation',
    importJobId         = null,
  } = context || {};

  const empty = {
    customerFacts:       { toStore: [], needsReview: [] },
    ownerPersonaSignals: { toStore: [], needsReview: [] },
    interactionProfile:  {},
    counts: { customerToStore:0, customerNeedsReview:0, ownerToStore:0, ownerNeedsReview:0, ignored:1, total:0 },
  };

  if (!turns || turns.length === 0) {
    return { ...empty, ignored: [{ reason: 'no turns provided' }] };
  }

  let compressed;
  try {
    compressed = compressTurns(turns);
  } catch (err) {
    throw err;
  }

  if (!compressed.trim()) {
    return { ...empty, ignored: [{ reason: 'all turns were system/deleted/empty' }] };
  }

  const prompt = buildExtractionPrompt(compressed, { customerName, ownerName, existingMemoryFacts });
  const client = openai || getOpenAI();

  let rawText;
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1200,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a precise business intelligence extractor for Indian MSME trade relationships. Return only valid JSON matching the exact schema provided. Never add explanation or markdown.' },
        { role: 'user', content: prompt },
      ],
    });
    rawText = response.choices[0]?.message?.content || '{}';
  } catch (err) {
    console.error('[extractMemoryCandidates] GPT call failed:', err.message);
    return { ...empty, ignored: [{ reason: `GPT call failed: ${err.message}` }] };
  }

  let parsed;
  try {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[extractMemoryCandidates] JSON parse failed:', err.message);
    console.error('[extractMemoryCandidates] Raw output (first 500):', rawText.substring(0, 500));
    return { ...empty, ignored: [{ reason: 'GPT output JSON parse failed' }] };
  }

  return validateAndGroup(parsed, source, importJobId);
}

export { compressTurns, buildExtractionPrompt, validateAndGroup, REVIEW_THRESHOLD };
