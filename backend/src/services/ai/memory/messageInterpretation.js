/**
 * AssistMe — Message Interpretation
 * Location: /backend/src/services/ai/memory/messageInterpretation.js
 * Session 6C — shared message interpretation doctrine
 *
 * PURPOSE:
 *   Single source of truth for interpreting what a message means and who said it.
 *   Not merely a "text extraction" utility — this file owns interpretation
 *   rules that will grow over time: effective text, speaker role, and
 *   (future) distillability, message direction, and similar concerns.
 *
 *   Used by: distillationGate, distillationAdapter, and future consumers
 *   (Memory Import, Search, Embeddings, Summarization, Voice transcription
 *   with speaker diarization).
 *
 * EFFECTIVE TEXT DOCTRINE:
 *   getEffectiveText() returns the authoritative semantic representation
 *   of a message's text content — not merely "extracted text."
 *
 *   canonical_text exists to solve cases where displayed content and
 *   meaningful text differ — audio (icon vs transcript), images (filename
 *   vs OCR), documents (filename vs extracted text).
 *
 *   Currently, for plain text messages, content is used directly as the
 *   effective text. This is not a permanent prohibition on canonical_text
 *   for text messages — future normalization (language cleanup, profanity
 *   filtering, Unicode normalization) may introduce a distinct canonical_text
 *   for text messages too. The doctrine today: text messages normally use
 *   content directly; non-text modalities use canonical_text.
 *
 *   Switches explicitly on input_modality rather than `canonical_text || content`,
 *   which would implicitly assume "if canonical_text exists, always prefer it" —
 *   not always true once normalization is introduced.
 *
 * BUG THIS FIXES (Session 6C manual testing, 30 Jun 2026):
 *   DM message insert route (POST /api/chat/:customer_id/message) never
 *   set canonical_text. Every text DM had canonical_text = null, making
 *   distillationGate and distillationAdapter see zero usable messages.
 *   Fix: read content for text messages instead of writing duplicate data.
 *
 * SPEAKER ROLE DOCTRINE:
 *   getSpeakerRole() maps DB role values (OpenAI chat-completion roles:
 *   assistant/user/system/tool) to business semantic roles (owner/customer/system).
 *   Returns lowercase semantic values — NOT presentation-formatted labels.
 *   Formatting (capitalization, localization) happens at the call site.
 *   This separates business identity from display formatting.
 *
 *   Raw role values are not self-evident to GPT — "assistant" doesn't
 *   obviously mean "the owner speaking" — causing GPT to misattribute
 *   statements during distillation without this translation layer.
 *
 *   IMPORTANT: This relabeling exists ONLY inside this utility file.
 *   The messages.role DB column is never renamed, migrated, or altered.
 *   Every other code path in the codebase continues to read/write
 *   role as 'assistant'/'user'/'system'/'tool' exactly as before.
 *
 * FUTURE GROWTH (not built yet, documented for awareness):
 *   isOwnerMessage(message), isCustomerMessage(message),
 *   isDistillable(message), getConversationDirection(message)
 *   These belong here when they're needed — don't pre-build speculatively.
 *
 * DOCTRINE REF: ASSISTME_DISTILLATION_ENGINE_MEMORY_DOCTRINE.md
 */

/**
 * Get the effective (authoritative semantic) text content of a message.
 *
 * @param {object} message
 * @param {string} message.input_modality — 'text' | 'audio' | 'image' | 'document'
 * @param {string} message.content — displayed/raw content
 * @param {string|null} message.canonical_text — transcript/OCR for non-text modalities
 * @returns {string|null} — the effective text, or null if none available
 */
export function getEffectiveText(message) {
  if (!message) return null;

  switch (message.input_modality) {
    case 'audio':
    case 'image':
    case 'document':
      return message.canonical_text || null;

    case 'text':
    default:
      return message.content || null;
  }
}

/**
 * Get the semantic business role of who sent a message.
 * Returns lowercase semantic value — formatting happens at call site.
 *
 * @param {object} message
 * @param {string} message.role — 'assistant' | 'user' | 'system' | 'tool'
 * @returns {string} — 'owner' | 'customer' | 'system'
 */
export function getSpeakerRole(message) {
  if (!message) return 'system';
  if (message.role === 'assistant') return 'owner';
  if (message.role === 'user')      return 'customer';
  // Preserve unknown roles (e.g. future 'planner', 'mentor', 'integration')
  // rather than silently collapsing them — avoids losing information
  // if new role values are introduced later.
  return message.role || 'system';
}

/**
 * Filter and enrich a batch of messages with effective text.
 * Excludes messages with no usable text after enrichment.
 *
 * NOTE: Returns a DERIVED representation (raw message row + computed
 * .effectiveText field), not the raw message row itself. Callers should
 * treat the returned objects as enriched-for-this-purpose, not as a
 * general-purpose message type other code should depend on.
 *
 * @param {Array<object>} messages — raw message rows
 * @returns {Array<object>} — messages with .effectiveText added, empty ones excluded
 */
export function enrichWithEffectiveText(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(m => ({ ...m, effectiveText: getEffectiveText(m) }))
    .filter(m => m.effectiveText && m.effectiveText.trim().length > 0);
}
