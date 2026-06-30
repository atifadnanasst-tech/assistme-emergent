/**
 * AssistMe — Distillation Adapter
 * Location: /backend/src/services/ai/memory/distillationAdapter.js
 * Session 6C — live conversation distillation domain service
 * Adapter Version: 1 | Prompt Version: 1
 *
 * PURPOSE:
 *   Orchestrates the full live distillation pipeline for one conversation.
 *   Pure domain service — no HTTP awareness.
 *   Called by: manual test route, WatchEngine cron, future ingestion channels.
 *
 * PIPELINE:
 *   1. Fetch new messages (canonical_text, since last_distilled_at)
 *   2. Distillation Gate — evaluate batch (ephemeral, no GPT)
 *   3. If shouldDistill=false → advance last_distilled_at, return skipped
 *   4. Retrieve relevant entity_memory rows (context only — always + hint-based)
 *   5. One GPT call — system prompt (doctrine) + user prompt (runtime context)
 *   6. Validate + deduplicate GPT output (key registry, derived_from)
 *   7. Memory Adapter — translate to writeEntityMemory candidates
 *   8. writeEntityMemory() + writeInteractionProfile()
 *   9. Advance conversations.last_distilled_at = MAX(messages.created_at)
 *
 * V1 CONTRACT:
 *   - No operation field. Every change in changes[] means "update this memory."
 *   - Empty changes[] means nothing to write.
 *   - memory_class derived from registry — never from GPT.
 *   - create/update derived from DB state — never from GPT.
 *   - Owner persona via writeInteractionProfile only (interaction_profile key).
 *   - Duplicate keys: last entry wins (deterministic).
 *   - Immutable key conflicts: logged as warning, blocked.
 *   - derived_from IDs: validated against actual message batch.
 *
 * MERGE EXECUTION (v1):
 *   Only 'immutable' has execution semantics — adapter enforces it explicitly.
 *   'synthesize', 'evolve', 'replace' are registry metadata reserved for v2.
 *   All non-immutable keys are upserted with latest validated value.
 *
 * DEFERRED:
 *   - expire / replace_summary operations
 *   - synthesize / evolve merge execution
 *   - embedding-based retrieval
 *   - priority-based context ranking
 *   - move prompts to memoryPrompt.js
 *
 * DOCTRINE REF: ASSISTME_DISTILLATION_ENGINE_MEMORY_DOCTRINE.md
 */

import { evaluateBatch }                              from './distillationGate.js';
import { getKeyMeta, isValidKey, getKeysForRetrieval,
         REGISTRY_VERSION, ENTITY_KEYS }              from './memoryKeyRegistry.js';
import { writeEntityMemory }                          from './writeEntityMemory.js';
import { writeInteractionProfile }                    from './writeInteractionProfile.js';
import { getOpenAI }                                  from '../../../ai-routes.js';

export const ADAPTER_VERSION = 1;
export const PROMPT_VERSION  = 1;

const HINT_TO_RETRIEVAL_GROUPS = {
  contains_business_noun:     ['products', 'payments', 'always'],
  contains_quantity:          ['products', 'always'],
  contains_person_reference:  ['relationships', 'always'],
  contains_future_reference:  ['events', 'always'],
  contains_preference_phrase: ['communication', 'products', 'always'],
  contains_contact_pattern:   ['always'],
  contains_seasonal_reference:['products', 'always'],
  contains_urgency_marker:    ['always'],
  contains_date:              ['events', 'always'],
  contains_number:            ['payments', 'products', 'always'],
  contains_location:          ['events', 'always'],
};

function getRetrievalGroups(hints) {
  const groups = new Set(['always']);
  for (const hint of hints) {
    (HINT_TO_RETRIEVAL_GROUPS[hint] || []).forEach(g => groups.add(g));
  }
  return [...groups];
}

function getAllCustomerKeys() {
  return Object.entries(ENTITY_KEYS.customer || {})
    .filter(([, meta]) => meta.deprecated !== true)
    .map(([key]) => key);
}

function buildSystemPrompt(allCanonicalKeys) {
  return `You are AssistMe's Memory Engine. Your job is to update what AssistMe knows about a business customer based on new conversation messages.

RULES:
- Return ONLY memories that should change based on the new messages.
- If nothing materially changed, return an empty changes array.
- Do not rewrite memories simply because wording differs. Prefer stability.
- For preferences that conflict with existing memory, synthesize a narrative (e.g. "Historically preferred Rose Attar, recently shifting toward Musk").
- confidence: 0.0-1.0. Use 0.85+ for explicit statements, lower for inferences.
- derived_from: list only message IDs from the provided list. Do not invent IDs.
- Use ONLY these exact canonical key names. Unknown keys are rejected:
${allCanonicalKeys.map(k => `  ${k}`).join('\n')}

Respond with valid JSON only. No text outside the JSON object.`;
}

function buildUserPrompt(existingMemories, newMessages, messageIds) {
  const existingBlock = existingMemories.length > 0
    ? existingMemories.map(m => `${m.memory_key}: ${m.memory_value}`).join('\n')
    : '(no existing memory retrieved for context)';

  const messagesBlock = newMessages
    .filter(m => m.canonical_text)
    .map(m => `[id:${m.id}] [${m.role}]: ${m.canonical_text}`)
    .join('\n');

  return `EXISTING MEMORY (for context — update only if new messages change understanding):
${existingBlock}

NEW CONVERSATION MESSAGES:
${messagesBlock}

Valid message IDs for derived_from: ${messageIds.join(', ')}

Respond with this JSON structure:
{
  "changes": [
    {
      "memory_key": "preferred_product",
      "value": "Updated value string",
      "confidence": 0.85,
      "reason": "Brief explanation",
      "derived_from": ["message_id_here"]
    }
  ],
  "interaction_profile": {
    "greeting_used": "string or null",
    "language_mix": "string or null",
    "owner_tone_with_customer": "string or null",
    "message_length_style": "string or null",
    "voice_note_preference": "string or null",
    "emoji_usage": "string or null",
    "followup_style": "string or null"
  }
}`;
}

function validateChanges(changes, entityType, validMessageIds) {
  if (!Array.isArray(changes)) return [];
  const messageIdSet = new Set(validMessageIds);
  const deduped = new Map();

  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    if (!change.memory_key || typeof change.memory_key !== 'string') continue;

    if (!isValidKey(entityType, change.memory_key)) {
      console.warn(`[distillationAdapter] Rejected unknown key: "${change.memory_key}"`);
      continue;
    }

    change.confidence = typeof change.confidence === 'number'
      ? Math.max(0, Math.min(1, change.confidence))
      : 0.75;

    if (Array.isArray(change.derived_from)) {
      const invalid = change.derived_from.filter(id => !messageIdSet.has(id));
      if (invalid.length > 0) {
        console.warn(`[distillationAdapter] Filtered hallucinated IDs: ${invalid.join(', ')}`);
        change.derived_from = change.derived_from.filter(id => messageIdSet.has(id));
      }
    } else {
      change.derived_from = [];
    }

    deduped.set(change.memory_key, change);
  }

  return [...deduped.values()];
}

function buildCandidates(validChanges, existingMemoryMap) {
  const toStore = [];

  for (const change of validChanges) {
    const meta = getKeyMeta('customer', change.memory_key);
    if (!meta) continue;

    if (meta.merge === 'immutable') {
      const existing = existingMemoryMap.get(change.memory_key);
      if (existing) {
        if (existing.memory_value !== String(change.value)) {
          console.warn(`[distillationAdapter] Immutable conflict: key="${change.memory_key}" existing="${existing.memory_value}" proposed="${change.value}" — blocked`);
        }
        continue;
      }
    }

    toStore.push({
      key:             change.memory_key,
      value:           String(change.value || ''),
      class:           meta.class,
      confidence:      change.confidence,
      evidenceSummary: change.reason || '',
      source:          'conversation_distillation',
      metadata: {
        derived_from:     change.derived_from,
        registry_version: REGISTRY_VERSION,
        adapter_version:  ADAPTER_VERSION,
        prompt_version:   PROMPT_VERSION,
      },
    });
  }

  return { customerFacts: { toStore, needsReview: [] } };
}

export async function distillConversation({ organisationId, customerId, conversationId, supabase, trigger = 'unknown' }) {
  try {
    console.log(`[distillationAdapter] START conv=${conversationId} trigger=${trigger}`);

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, last_distilled_at')
      .eq('id', conversationId)
      .eq('organisation_id', organisationId)
      .maybeSingle();

    if (!conv) return { skipped: true, reason: 'conversation_not_found' };

    let q = supabase
      .from('messages')
      .select('id, content, canonical_text, role, created_at, input_modality')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (conv.last_distilled_at) q = q.gt('created_at', conv.last_distilled_at);

    const { data: rawMessages } = await q;
    const newMessages = enrichWithEffectiveText(rawMessages || []);
    if (!newMessages || newMessages.length === 0) return { skipped: true, reason: 'no_new_messages' };

    const maxCreatedAt = newMessages[newMessages.length - 1].created_at;
    const messageIds   = newMessages.map(m => m.id);

    const gateResult = evaluateBatch(newMessages);
    if (!gateResult.shouldDistill) {
      await supabase.from('conversations').update({ last_distilled_at: maxCreatedAt }).eq('id', conversationId);
      console.log(`[distillationAdapter] Gate: no signal. conv=${conversationId}`);
      return { skipped: true, reason: 'gate_no_signal' };
    }
    console.log(`[distillationAdapter] Gate signals: ${gateResult.allHints.join(', ')}`);

    const groups    = getRetrievalGroups(gateResult.allHints);
    const keysToGet = getKeysForRetrieval('customer', groups);

    const { data: existingRows } = await supabase
      .from('entity_memory')
      .select('memory_key, memory_value, source, confidence')
      .eq('organisation_id', organisationId)
      .eq('entity_type', 'customer')
      .eq('entity_id', customerId)
      .in('memory_key', keysToGet)
      .is('deleted_at', null);

    const existingMemoryMap = new Map((existingRows || []).map(r => [r.memory_key, r]));

    const systemPrompt = buildSystemPrompt(getAllCustomerKeys());
    const userPrompt   = buildUserPrompt(existingRows || [], newMessages, messageIds);

    const openai = getOpenAI();
    let gptResponse;
    try {
      const completion = await openai.chat.completions.create({
        model:           'gpt-4o-mini',
        temperature:     0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      });
      gptResponse = JSON.parse(completion.choices[0].message.content);
    } catch (gptErr) {
      console.error(`[distillationAdapter] GPT error conv=${conversationId}:`, gptErr.message);
      return { error: 'gpt_failed', reason: gptErr.message };
    }

    const validChanges = validateChanges(gptResponse.changes || [], 'customer', messageIds);
    console.log(`[distillationAdapter] ${(gptResponse.changes||[]).length} raw → ${validChanges.length} valid`);

    const candidates   = buildCandidates(validChanges, existingMemoryMap);
    const memoryResult = await writeEntityMemory(
      organisationId, customerId, candidates, supabase,
      { importJobId: conversationId, reviewStatus: 'auto', includeNeedsReview: false, explicitRestore: false }
    );

    let profileWritten = 0;
    const ip = gptResponse.interaction_profile || {};
    if (Object.values(ip).some(v => v && v !== 'null' && v !== null)) {
      try {
        const pr = await writeInteractionProfile(organisationId, customerId, ip, supabase);
        profileWritten = pr.written || 0;
      } catch (e) {
        console.error(`[distillationAdapter] Profile write failed (non-fatal):`, e.message);
      }
    }

    await supabase.from('conversations').update({ last_distilled_at: maxCreatedAt }).eq('id', conversationId);
    console.log(`[distillationAdapter] DONE conv=${conversationId} written=${memoryResult.written} profile=${profileWritten}`);

    return { written: memoryResult.written, skippedFacts: memoryResult.skipped, profileWritten };

  } catch (err) {
    console.error(`[distillationAdapter] Unexpected error conv=${conversationId}:`, err);
    return { error: 'unexpected_error', reason: err.message };
  }
}
