/**
 * AssistMe — lib/upload.ts
 * Shared file upload utility.
 *
 * Source: Extracted verbatim from chat/[customer_id].tsx uploadAttachment.
 * AbortController + 45s timeout + refresh logic copied from production source.
 *
 * Auth boundary: getUploadToken() handles refresh/retry, returns null on failure.
 * Navigation on auth failure remains in the calling surface (React hooks not called here).
 *
 * Consumers (Phase 1): app/ai.tsx (Org AI only)
 * Future consumers: app/chat/[customer_id].tsx, products, profile (post-v1)
 * NOT consumed by customer chat in this phase — customer chat untouched.
 *
 * Modifies existing production surface: NO
 */
import { authService } from './auth';

export interface UploadResult {
  url: string;
  storage_path: string;
  mime_type?: string;
  name?: string;
  size?: number;
}

/**
 * Get a valid auth token, attempting refresh if expired.
 * Returns null if auth cannot be recovered — caller must handle logout/redirect.
 * Logic copied from customer chat getToken() (lines 576-592).
 */
export async function getUploadToken(): Promise<string | null> {
  let token = await authService.getAccessToken();
  if (!token) {
    const refreshed = await authService.refreshSession();
    if (!refreshed) {
      await authService.clearSession();
      return null;
    }
    token = await authService.getAccessToken();
    if (!token) {
      await authService.clearSession();
      return null;
    }
  }
  return token;
}

/**
 * Upload a local file URI to /api/upload.
 * Returns UploadResult on success, null on failure.
 * Copied verbatim from customer chat uploadAttachment — same timeout, abort, error handling.
 */
export async function uploadFile(
  localUri: string,
  name: string,
  mimeType: string,
): Promise<UploadResult | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);
  try {
    const token = await getUploadToken();
    if (!token) return null;

    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const formData = new FormData();
    formData.append('file', { uri: localUri, name, type: mimeType } as any);

    const res = await fetch(`${backendUrl}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    if (!data?.url) throw new Error('No URL in response');

    return {
      url: data.url,
      storage_path: data.storage_path || '',
      mime_type: data.mime_type,
      name: data.name,
      size: data.size,
    };
  } catch (e) {
    console.error('[uploadFile]', e);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
