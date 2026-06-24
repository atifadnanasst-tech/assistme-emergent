/**
 * AssistMe — Memory Engine Primitive 1
 * parseConversationText(input, source, options)
 *
 * Location: /backend/src/services/ai/memory/parseConversationText.js
 * Created: 24 Jun 2026
 * Audit: v1.1 — incorporates dual-audit findings (24 Jun 2026)
 *
 * Purpose:
 *   Convert any raw conversation text into structured turns.
 *   Pure transformation — no DB reads, no DB writes, no GPT calls.
 *   Output feeds directly into extractMemoryCandidates().
 *
 * Supported sources:
 *   'whatsapp_export'  — WhatsApp .txt export file (string)
 *   'inapp_messages'   — array of DB message rows (already structured)
 *
 * WhatsApp .txt format (verified from real export, 24 Jun 2026):
 *   DD/MM/YY, HH:MM am/pm - Speaker Name: message text
 *   Multi-line messages: continuation lines have NO timestamp prefix
 *   System messages: DD/MM/YY, HH:MM am/pm - message text  (no "Speaker:" segment)
 *   Media: text is "<Media omitted>"
 *   Deleted: text is "This message was deleted" / "<This message was deleted>"
 *
 * Output contract (every turn):
 *   {
 *     timestamp: string | null,     // ISO 8601. See TIMESTAMP NOTE below.
 *     speaker: string | null,       // raw name from export, null for system messages
 *     role: 'owner' | 'customer' | 'system' | 'unknown',
 *     text: string,                 // cleaned message text (empty for media/deleted)
 *     mediaFlag: boolean,           // true if <Media omitted>
 *     deleted: boolean,             // true if message was deleted
 *     continuationOf: number | null // reserved for future use
 *   }
 *
 * TIMESTAMP NOTE (audit fix v1.1):
 *   WhatsApp exports use the device's LOCAL time, not UTC.
 *   Date.UTC() is used here for construction convenience, but the resulting
 *   ISO string is NOT true UTC — it is local time with a Z suffix.
 *   For Indian devices (IST = UTC+5:30), all timestamps are ~5.5 hours behind
 *   actual UTC. This is accepted for v1 because memory facts are qualitative
 *   (relationship signals, preferences, opportunities) and not time-critical.
 *   TODO P2: pass organisations.timezone to correct to true UTC.
 *
 * ROLE ASSIGNMENT (audit fix v1.1):
 *   Role is determined by matching speaker name against ownerDisplayNames[].
 *   The caller should provide ALL known variants of the owner's WhatsApp name:
 *     e.g. ["Atif Adnan", "Atif", "Atif A."]
 *   This avoids fragile prefix-matching that risks false positives with names
 *   like "Mohd Azim" vs "Mohd Arif".
 *   At import time, the caller (import adapter) knows organisation_id and can
 *   supply these names. For v1, a single ownerName string is also accepted as
 *   a convenience shorthand — it is treated as ownerDisplayNames: [ownerName].
 */

// ── WhatsApp timestamp pattern ────────────────────────────────────────────────
// Matches: "17/03/26, 10:29 am" or "17/03/26, 10:29 pm"
// Also handles: single-digit day/month and 24h format (no am/pm)
const WA_LINE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?:\s?[ap]m)?)\s+-\s+(.*)/i;

// Speaker extraction: first colon separates speaker from message text
const SPEAKER_RE = /^([^:]+):\s+([\s\S]*)$/;

const MEDIA_TEXTS = ['<media omitted>', 'media omitted'];
const DELETED_TEXTS = [
  'this message was deleted',
  '<this message was deleted>',
  'you deleted this message',
];

/**
 * Parse a WhatsApp DD/MM/YY HH:MM am/pm timestamp.
 *
 * IMPORTANT: Returns an ISO string constructed via Date.UTC() for convenience.
 * The result is NOT true UTC — see TIMESTAMP NOTE in file header.
 * Returns null if unparseable.
 */
function parseWATimestamp(datePart, timePart) {
  try {
    const [day, month, year] = datePart.split('/').map(Number);
    const fullYear = year < 100 ? 2000 + year : year;

    const timeLower = timePart.toLowerCase().trim();
    const isAm = timeLower.endsWith('am');
    const isPm = timeLower.endsWith('pm');
    const timeDigits = timeLower.replace(/\s?[ap]m/, '').trim();
    let [hours, minutes] = timeDigits.split(':').map(Number);

    if (isPm && hours !== 12) hours += 12;
    if (isAm && hours === 12) hours = 0;

    const d = new Date(Date.UTC(fullYear, month - 1, day, hours, minutes, 0));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Resolve speaker role using explicit display name list.
 *
 * @param {string|null} speaker         — raw speaker name from WhatsApp export
 * @param {string[]} ownerDisplayNames  — all known variants of owner's WA name
 * @returns {'owner'|'customer'|'system'|'unknown'}
 */
function resolveRole(speaker, ownerDisplayNames) {
  if (!speaker) return 'system';
  if (!ownerDisplayNames || ownerDisplayNames.length === 0) return 'unknown';
  const sp = speaker.trim().toLowerCase();
  for (const name of ownerDisplayNames) {
    if (sp === name.trim().toLowerCase()) return 'owner';
  }
  return 'customer';
}

/**
 * Finalize a raw turn: join multi-line text, detect media and deleted flags.
 */
function finalizeTurn(raw) {
  const text = raw.textParts.join('\n').trim();
  const textLower = text.toLowerCase();
  const mediaFlag = MEDIA_TEXTS.some(m => textLower === m);
  const deleted = DELETED_TEXTS.some(d => textLower === d || textLower === d.replace(/[<>]/g, ''));
  return {
    timestamp: raw.timestamp,
    speaker: raw.speaker,
    role: raw.role,
    text: (mediaFlag || deleted) ? '' : text,
    mediaFlag,
    deleted,
    continuationOf: raw.continuationOf,
  };
}

/**
 * Parse WhatsApp .txt export into structured turns.
 *
 * @param {string} rawText
 * @param {string[]} ownerDisplayNames
 * @returns {Turn[]}
 */
function parseWhatsAppExport(rawText, ownerDisplayNames) {
  const lines = rawText.split('\n');
  const turns = [];
  let currentTurn = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineMatch = trimmed.match(WA_LINE_RE);

    if (lineMatch) {
      if (currentTurn) turns.push(finalizeTurn(currentTurn));

      const [, datePart, timePart, rest] = lineMatch;
      const timestamp = parseWATimestamp(datePart, timePart);
      const speakerMatch = rest.match(SPEAKER_RE);

      if (speakerMatch) {
        const [, speaker, text] = speakerMatch;
        currentTurn = {
          timestamp,
          speaker: speaker.trim(),
          role: resolveRole(speaker.trim(), ownerDisplayNames),
          textParts: [text],
          mediaFlag: false,
          deleted: false,
          continuationOf: null,
        };
      } else {
        currentTurn = {
          timestamp,
          speaker: null,
          role: 'system',
          textParts: [rest],
          mediaFlag: false,
          deleted: false,
          continuationOf: null,
        };
      }
    } else {
      if (currentTurn) currentTurn.textParts.push(trimmed);
    }
  }

  if (currentTurn) turns.push(finalizeTurn(currentTurn));
  return turns;
}

/**
 * Parse in-app DB message rows into the same Turn shape.
 *
 * DB message shape (from existing index.js queries):
 *   { id, role, content, canonical_text, input_modality, metadata, created_at }
 *
 * Role mapping:
 *   DB 'user'      → 'owner'   (owner typed or spoke)
 *   DB 'assistant' → excluded  (AI responses are not distillation input)
 *   DB 'system'    → excluded  (system messages are not distillation input)
 *
 * inputModality is preserved so extractMemoryCandidates() can apply
 * the +0.1 confidence boost for audio turns (voice notes = richer signal).
 */
function parseInAppMessages(messages, ownerDisplayNames) {
  const ownerName = ownerDisplayNames?.[0] || 'Owner';
  return messages
    .filter(m => m.role === 'user')
    .map(m => {
      const text = m.canonical_text || m.content || '';
      const textLower = text.toLowerCase();
      const mediaFlag = MEDIA_TEXTS.some(mt => textLower === mt);
      return {
        timestamp: m.created_at ? new Date(m.created_at).toISOString() : null,
        speaker: ownerName,
        role: 'owner',
        text: mediaFlag ? '' : text,
        mediaFlag,
        deleted: false,
        continuationOf: null,
        inputModality: m.input_modality || 'text',
      };
    });
}

/**
 * Compute stats for generateIntelligenceReport.
 */
function computeStats(turns) {
  const nonSystem = turns.filter(t => t.role !== 'system' && !t.deleted);
  const withTimestamp = turns
    .filter(t => t.timestamp)
    .map(t => t.timestamp)
    .sort();
  return {
    totalTurns: nonSystem.length,
    ownerTurns: nonSystem.filter(t => t.role === 'owner').length,
    customerTurns: nonSystem.filter(t => t.role === 'customer').length,
    mediaCount: turns.filter(t => t.mediaFlag).length,
    deletedCount: turns.filter(t => t.deleted).length,
    dateRange: {
      from: withTimestamp[0] || null,
      to: withTimestamp[withTimestamp.length - 1] || null,
    },
  };
}

/**
 * Main export — parseConversationText
 *
 * @param {string|object[]} input
 *   'whatsapp_export': raw .txt string
 *   'inapp_messages':  array of DB message rows
 *
 * @param {'whatsapp_export'|'inapp_messages'} source
 *
 * @param {object|string} options
 *   ownerName: string           — convenience: single owner name
 *   ownerDisplayNames: string[] — preferred: all known WA name variants for owner
 *   (legacy: third arg as plain string is also accepted)
 *
 * @returns {{ turns: Turn[], stats: object }}
 */
export function parseConversationText(input, source, options = {}) {
  // Normalize ownerDisplayNames — accept single string or array
  let ownerDisplayNames = [];
  if (Array.isArray(options.ownerDisplayNames) && options.ownerDisplayNames.length > 0) {
    ownerDisplayNames = options.ownerDisplayNames;
  } else if (typeof options.ownerDisplayNames === 'string' && options.ownerDisplayNames) {
    ownerDisplayNames = [options.ownerDisplayNames];
  } else if (typeof options === 'string') {
    // Legacy: parseConversationText(input, source, "Atif Adnan")
    ownerDisplayNames = [options];
  } else if (typeof options.ownerName === 'string' && options.ownerName) {
    ownerDisplayNames = [options.ownerName];
  }

  let turns = [];

  if (source === 'whatsapp_export') {
    if (typeof input !== 'string') {
      throw new Error('parseConversationText: whatsapp_export source requires string input');
    }
    turns = parseWhatsAppExport(input, ownerDisplayNames);
  } else if (source === 'inapp_messages') {
    if (!Array.isArray(input)) {
      throw new Error('parseConversationText: inapp_messages source requires array input');
    }
    turns = parseInAppMessages(input, ownerDisplayNames);
  } else {
    throw new Error(`parseConversationText: unknown source '${source}'`);
  }

  return { turns, stats: computeStats(turns) };
}

// Named exports for testing
export { parseWhatsAppExport, parseInAppMessages, parseWATimestamp, resolveRole };
