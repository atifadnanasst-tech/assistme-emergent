/**
 * AssistMe — types/chat.ts
 * Shared types for chat composer surfaces.
 * Consumers: app/ai.tsx, components/chat/ChatComposerInput.tsx
 * Future: app/chat/[customer_id].tsx (post-v1, COMPOSER-EXTRACT-01)
 */

// Attachment shape — matches backend /api/home/ai-query contract (PATCH-6)
// and /api/upload response shape { url, mime_type, name }
export type AiAttachment = {
  type: 'image';
  url: string;
  mime_type: string;
  name: string;
};
