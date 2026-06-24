/**
 * AssistMe — Memory Engine Primitive 3A
 * writeEntityMemory(orgId, customerId, candidates, supabase, options)
 *
 * Location: /backend/src/services/ai/memory/writeEntityMemory.js
 * Created: 24 Jun 2026
 * Audit: v1.5 — owner_removed fictitious source removed (24 Jun 2026)
 *
 * DB TOUCHPOINTS (this file only):
 *   READS:   entity_memory (pre-write governance check)
 *   WRITES:  entity_memory (upsert + soft-restore)
 *   WRITES:  action_log (every write attempt, including skips)
 *   NEVER:   customers, custom_fields, interaction_profile
 *            (see writeInteractionProfile.js — Primitive 3B)
 *
 * SCHEMA TOUCHPOINTS (verified 24 Jun 2026 against schema_sql_v3.txt)
 *   entity_memory UNIQUE (organisation_id, entity_type, entity_id, memory_key) — line 974
 *   action_log.source_surface (text, nullable) — line 2299
 *
 * SOURCE HIERARCHY DOCTRINE (locked — dual-audit signed off 24 Jun 2026)
 *
 *   SUPPRESSION MODEL (v1):
 *     Suppressed rows detected exclusively via deleted_at IS NOT NULL.
 *     There is NO owner_removed source value in v1.
 *     Post-v1: introduce suppressed_until + suppression_reason columns.
 *
 *   TIER 1 — ABSOLUTE:
 *     owner_declared → never overwritten automatically
 *
 *   TIER 2 — AUTHORITATIVE:
 *     document_import → only owner_declared may overwrite
 *     V1 SIMPLIFICATION: all document facts treated as authoritative regardless
 *     of memory class. Post-v1: authority varies by class.
 *
 *   TIER 3 — INFERENTIAL:
 *     whatsapp_import, conversation_distillation, system_inferred
 *     Updatable if incoming confidence > existing confidence.
 *
 *   WRITE DECISION MATRIX:
 *     suppressed row (deleted_at != null) + any source      → BLOCK (tombstone)
 *     existing=owner_declared + any incoming                → BLOCK
 *     existing=document_import + owner_declared             → ALLOW
 *     existing=document_import + anything else              → BLOCK
 *     existing=whatsapp_import + owner_declared             → ALLOW
 *     existing=whatsapp_import + document_import            → ALLOW
 *     existing=whatsapp_import + whatsapp/distill/inferred  → ALLOW if new conf > existing
 *     existing=distillation + owner/doc/whatsapp            → ALLOW
 *     existing=distillation + distill/inferred              → ALLOW if new conf > existing
 *     existing=system_inferred + anything                   → ALLOW
 *     no existing row + anything                            → ALLOW (insert)
 *
 * TOMBSTONE DOCTRINE (locked — dual-audit signed off 24 Jun 2026)
 *
 *   NO AUTOMATIC RESURRECTION RULE:
 *     Suppressed key (deleted_at IS NOT NULL) blocks ALL writes including
 *     normal owner_declared writes. Restoration requires:
 *       options.explicitRestore = true AND source = 'owner_declared'
 *     This distinguishes "owner declares new fact" from "owner restores suppressed fact".
 *
 * V1 KNOWN LIMITATION — RACE CONDITION:
 *   Governance checks (read -> decide -> upsert) are not transactionally enforced.
 *   Concurrent imports of the same customer may race. Acceptable for v1 — concurrent
 *   same-customer imports are rare and UNIQUE constraint prevents duplicate rows.
 *   Post-v1: wrap in Postgres RPC/transaction for atomic governance enforcement.
 *
 * AUDIT TRAIL METADATA CONTRACT:
 *   action_type, source, memory_class, entity_type, memory_key, new_value,
 *   confidence, evidence_count, evidence_summary, import_job_id,
 *   review_status, write_action, skip_reason
 */

const TIER1_ABSOLUTE      = new Set(['owner_declared']);
const TIER2_AUTHORITATIVE = new Set(['document_import']);
const TIER3_INFERENTIAL   = new Set(['whatsapp_import', 'conversation_distillation', 'system_inferred']);

export const CLASS_EXPIRY_DAYS = {
  historical_fact:    null,
  relationship_fact:  null,
  preference:         null,
  behavioral_pattern: 90,
  opportunity:        90,
  temporary_signal:   30,
};

function getExpiresAt(memoryClass, isOwnerDeclared) {
  if (isOwnerDeclared) return null;
  const days = CLASS_EXPIRY_DAYS[memoryClass];
  if (days === null || days === undefined) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function shouldWrite(incomingFact, existingRow) {
  if (!existingRow) return { allow: true, reason: 'no_existing_row' };
  const inSrc  = incomingFact.source;
  const exSrc  = existingRow.source;
  const inConf = incomingFact.confidence ?? 0;
  const exConf = existingRow.confidence  ?? 0;
  if (TIER1_ABSOLUTE.has(exSrc))      return { allow: false, reason: `existing_${exSrc}_is_absolute` };
  if (TIER2_AUTHORITATIVE.has(exSrc)) {
    if (inSrc === 'owner_declared')   return { allow: true,  reason: 'owner_declared_overrides_document' };
    return { allow: false, reason: 'document_import_blocks_inferential_overwrite' };
  }
  if (inSrc === 'owner_declared')     return { allow: true,  reason: 'owner_declared_always_wins' };
  if (inSrc === 'document_import')    return { allow: true,  reason: 'document_import_upgrades_inferential' };
  if (TIER3_INFERENTIAL.has(exSrc) && TIER3_INFERENTIAL.has(inSrc)) {
    if (inConf > exConf)              return { allow: true,  reason: 'higher_confidence_update' };
    return { allow: false, reason: `confidence_${inConf}_does_not_beat_existing_${exConf}` };
  }
  return { allow: true, reason: 'fallback_allow' };
}

async function writeSingleFact(supabase, orgId, entityType, entityId, fact, importJobId, explicitRestore) {
  const { key, value, class: memClass, confidence, source } = fact;

  const { data: existing } = await supabase
    .from('entity_memory')
    .select('id, source, confidence, deleted_at')
    .eq('organisation_id', orgId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('memory_key', key)
    .maybeSingle();

  if (existing && existing.deleted_at !== null) {
    if (explicitRestore && source === 'owner_declared') {
      const { error } = await supabase
        .from('entity_memory')
        .update({
          memory_value: value,
          confidence,
          source,
          expires_at:  null,
          deleted_at:  null,
          updated_at:  new Date().toISOString(),
        })
        .eq('id', existing.id);
      if (error) return { key, action: 'error', reason: error.message };
      return { key, value, action: 'restored' };
    }
    return { key, action: 'tombstoned', reason: 'suppressed_key_requires_explicitRestore_with_owner_declared' };
  }

  const decision = shouldWrite(fact, existing);
  if (!decision.allow) return { key, action: 'skipped', reason: decision.reason };

  const { error } = await supabase
    .from('entity_memory')
    .upsert({
      organisation_id: orgId,
      entity_type:     entityType,
      entity_id:       entityId,
      memory_key:      key,
      memory_value:    value,
      confidence,
      source,
      expires_at:      getExpiresAt(memClass, source === 'owner_declared'),
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

  if (error) {
    console.error('[writeEntityMemory] upsert failed:', key, error.message);
    return { key, action: 'error', reason: error.message };
  }
  return { key, value, action: existing ? 'updated' : 'inserted' };
}

async function logMemoryWrite(supabase, orgId, entityType, entityId, fact, result, importJobId, reviewStatus) {
  try {
    await supabase.from('action_log').insert({
      organisation_id: orgId,
      entity_type:     entityType,
      entity_id:       entityId,
      action_type:     'memory_write',
      source_surface:  'memory_engine',
      metadata: {
        action_type:      'memory_write',
        source:           fact.source,
        memory_class:     fact.class,
        entity_type:      entityType,
        memory_key:       fact.key,
        new_value:        fact.value,
        confidence:       fact.confidence,
        evidence_count:   fact.evidenceCount   || null,
        evidence_summary: fact.evidenceSummary || null,
        import_job_id:    importJobId          || null,
        review_status:    reviewStatus         || 'auto',
        write_action:     result.action,
        skip_reason:      result.reason        || null,
      },
    });
  } catch (logErr) {
    console.warn('[writeEntityMemory] audit log failed (non-blocking):', logErr.message);
  }
}

export async function writeEntityMemory(orgId, customerId, candidates, supabase, options = {}) {
  const {
    importJobId        = null,
    reviewStatus       = 'auto',
    includeNeedsReview = false,
    explicitRestore    = false,
  } = options;

  let written = 0, skipped = 0, tombstoned = 0, restored = 0, errors = 0;
  const results = [];

  const customerFacts = [
    ...(candidates.customerFacts?.toStore || []),
    ...(includeNeedsReview ? (candidates.customerFacts?.needsReview || []) : []),
  ];
  const ownerFacts = [
    ...(candidates.ownerPersonaSignals?.toStore || []),
    ...(includeNeedsReview ? (candidates.ownerPersonaSignals?.needsReview || []) : []),
  ];

  for (const fact of customerFacts) {
    const result = await writeSingleFact(supabase, orgId, 'customer', customerId, fact, importJobId, explicitRestore);
    results.push(result);
    if      (result.action === 'inserted' || result.action === 'updated') written++;
    else if (result.action === 'restored')   { written++; restored++; }
    else if (result.action === 'tombstoned') tombstoned++;
    else if (result.action === 'error')      errors++;
    else skipped++;
    await logMemoryWrite(supabase, orgId, 'customer', customerId, fact, result, importJobId, reviewStatus);
  }

  for (const fact of ownerFacts) {
    const result = await writeSingleFact(supabase, orgId, 'owner', orgId, fact, importJobId, explicitRestore);
    results.push(result);
    if      (result.action === 'inserted' || result.action === 'updated') written++;
    else if (result.action === 'restored')   { written++; restored++; }
    else if (result.action === 'tombstoned') tombstoned++;
    else if (result.action === 'error')      errors++;
    else skipped++;
    await logMemoryWrite(supabase, orgId, 'owner', orgId, fact, result, importJobId, reviewStatus);
  }

  return { written, skipped, tombstoned, restored, errors, results };
}
