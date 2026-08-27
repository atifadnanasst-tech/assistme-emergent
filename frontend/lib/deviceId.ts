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
import { Platform, Alert } from 'react-native';
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
 * Registers this device with the backend. Called (and now AWAITED,
 * unlike Phase 1) from AuthContext right after a successful auth check.
 *
 * PHASE 2 ENFORCEMENT (Aug 2026, Atif's explicit ask -- "allowing is
 * one thing, recognizing is another; if it is not recognizing, then
 * how will it bar the login"): returns {shouldSignOut: true} ONLY on a
 * confirmed, explicit 403 with error code exactly 'seat_limit_reached'
 * or 'device_removed'. Every other outcome -- network failure, timeout,
 * unexpected status, malformed response, any other error code --
 * returns {shouldSignOut: false} and fails open. This is the one
 * deliberate exception to "never affect the user's session": a
 * confirmed rejection from the server is trusted, but ambiguity never
 * is. The actual sign-out itself is performed by AuthContext (which
 * already owns that logic), not duplicated here -- this function only
 * signals the decision.
 */
let seatLimitAlertShownThisSession = false;

export async function registerDevice(isFreshLogin: boolean = false): Promise<{ shouldSignOut: boolean; reason?: string }> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const token = await authService.getAccessToken();
    if (!token) return { shouldSignOut: false };
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const res = await fetch(`${backendUrl}/api/devices/register`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      // is_fresh_login (Aug 2026, consolidation after Atif's design
      // review): the backend now needs this to distinguish a silent,
      // automatic check (must NEVER grant access on its own) from a
      // genuinely fresh login (a deliberate human action -- typing a
      // phone number and a brand new OTP -- which SHOULD freely claim
      // an open seat with no extra confirmation needed). Callers at app
      // launch/resume pass isFreshLogin=false (the default); otp.tsx
      // passes true right after OTP verification succeeds.
      body: JSON.stringify({ device_id: deviceId, device_name: getDefaultDeviceName(), is_fresh_login: isFreshLogin }),
    });

    if (res.status !== 403) return { shouldSignOut: false };

    const data = await res.json().catch(() => null);
    if (!data || !data.error) return { shouldSignOut: false };

    // 'device_not_active' replaces the old 'device_removed'/'blocked'
    // distinction (Aug 2026 consolidation, Atif's own design review) --
    // both behaved identically (neither should ever silently reactivate
    // on its own), so they're now a single is_active flag on the
    // backend with one corresponding error code here.
    if (data.error === 'device_not_active') {
      Alert.alert('Device Not Active', 'This device is not currently active on your account. Please contact the account owner if this is unexpected.');
      return { shouldSignOut: true, reason: 'device_not_active' };
    }

    if (data.error === 'seat_limit_reached') {
      if (!seatLimitAlertShownThisSession) {
        seatLimitAlertShownThisSession = true;
        Alert.alert(
          'Device Limit Reached',
          `Your plan includes ${data.seats_purchased} device seat${data.seats_purchased !== 1 ? 's' : ''}, already in use. Remove a device or add a seat from Linked Devices to use this one too.`
        );
      }
      return { shouldSignOut: true, reason: 'seat_limit_reached' };
    }

    // Unrecognized error code -- fail open rather than guess.
    return { shouldSignOut: false };
  } catch (e) {
    // Fails open -- a network hiccup or unexpected error must never be
    // treated as a confirmed rejection. Only an explicit, well-formed
    // 403 with a recognized error code above triggers sign-out.
    console.warn('[deviceId] Registration failed (non-fatal):', e);
    return { shouldSignOut: false };
  }
}

/**
 * DEVICE TAKEOVER (Aug 2026, Atif's design). Separate from
 * registerDevice() above on purpose: that function handles a silent
 * app relaunch on an ALREADY-known device and must never prompt the
 * user. This function is for the one moment that's fundamentally
 * different -- a genuinely fresh login (phone number + a brand new
 * OTP just verified), called from the OTP screen right after
 * verification succeeds. A fresh OTP is real proof of phone-number
 * ownership, matching WhatsApp's own model: if a device is already
 * using this org's one seat, the person who just proved ownership can
 * explicitly choose to take over -- never silent, never automatic.
 *
 * Call with forceTakeover=false first; if the result says confirmation
 * is needed, show the prompt yourself and call again with
 * forceTakeover=true only if the person confirms.
 */
type DeviceLoginResult =
  | { success: true }
  | { success: false; needsTakeoverConfirmation: true; existingDeviceName: string | null }
  | { success: false; needsTakeoverConfirmation: false };

export async function registerDeviceAtLogin(forceTakeover: boolean): Promise<DeviceLoginResult> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const token = await authService.getAccessToken();
    if (!token) return { success: false, needsTakeoverConfirmation: false };
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const res = await fetch(`${backendUrl}/api/devices/register`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, device_name: getDefaultDeviceName(), force_takeover: forceTakeover }),
    });

    if (res.ok) return { success: true };

    if (res.status === 403) {
      const data = await res.json().catch(() => null);
      // Real gap fixed (Aug 2026, found via Atif's live testing):
      // device_removed now offers the same takeover prompt as
      // seat_limit_reached -- a fresh OTP login is exactly as strong
      // proof of ownership for a device that was explicitly removed as
      // for one that was merely blocked. Previously only
      // seat_limit_reached triggered this, meaning the real owner
      // logging in fresh on a device they'd once removed was
      // permanently locked out of ever using that install again.
      if (data?.error === 'seat_limit_reached' || data?.error === 'device_removed') {
        return { success: false, needsTakeoverConfirmation: true, existingDeviceName: data.existing_device_name || null };
      }
    }

    // Any other outcome -- fail open, treat as a soft success rather
    // than blocking a fresh, just-verified login over a device-tracking
    // hiccup. This mirrors registerDevice()'s own fail-open discipline.
    return { success: true };
  } catch (e) {
    console.warn('[deviceId] Login-time registration failed (non-fatal):', e);
    return { success: true };
  }
}
