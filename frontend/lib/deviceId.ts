/**
 * AssistMe - deviceId utility
 * Location: /frontend/lib/deviceId.ts
 * Created: Aug 2026 (Linked Devices feature, Phase 1)
 *
 * Generates and persists a stable, client-side device identifier, and
 * registers it with the backend at app launch. Deliberately does NOT
 * use the phone's own SIM number (confirmed unreliable/unavailable
 * cross-platform) or any native device-info library (expo-device would
 * require a new native build, not just an OTA update -- deferred, using
 * a simpler "Android Device"/"iOS Device" default the owner can rename
 * immediately instead).
 *
 * Uses Math.random() + Date.now() rather than a crypto/uuid library --
 * deliberately avoiding a new native dependency for the same reason.
 * Device identity here doesn't need to be cryptographically secure,
 * only stable and practically unique.
 *
 * Phase 1 (this file): pure tracking, registration only, NO enforcement.
 * The backend's /register endpoint already checks the seat limit, but
 * nothing yet rejects requests from a removed device -- that's Phase 2,
 * added separately once registration is confirmed reliable in real use.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { authService } from './auth';

const DEVICE_ID_KEY = 'assistme_device_id';

function generateDeviceId(): string {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export async function getOrCreateDeviceId(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) return existing;
    const fresh = generateDeviceId();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch (e) {
    // Fails open -- a SecureStore hiccup should never crash app launch.
    // Falls back to a per-session ID (won't persist across restarts,
    // but keeps the app functional).
    console.warn('[deviceId] SecureStore access failed, using ephemeral ID:', e);
    return generateDeviceId();
  }
}

function getDefaultDeviceName(): string {
  return Platform.OS === 'ios' ? 'iOS Device' : 'Android Device';
}

/**
 * Registers this device with the backend. Fire-and-forget by design --
 * called from AuthContext right after a successful auth check, wrapped
 * in try/catch there too. Never throws, never blocks app launch.
 */
export async function registerDevice(): Promise<void> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const token = await authService.getAccessToken();
    if (!token) return;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    await fetch(`${backendUrl}/api/devices/register`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, device_name: getDefaultDeviceName() }),
    });
  } catch (e) {
    // Fails open -- Phase 1 is pure tracking, a registration failure
    // must never affect the user's session in any way.
    console.warn('[deviceId] Registration failed (non-fatal):', e);
  }
}
