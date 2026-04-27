import { Platform } from 'react-native';
import { supabase } from './supabase';

const TOKEN_KEY = 'supabase_access_token';
const REFRESH_TOKEN_KEY = 'supabase_refresh_token';
const ORG_ID_KEY = 'organisation_id';
const USER_ID_KEY = 'user_id';
const USER_ROLE_KEY = 'user_role';

// Lazy-load SecureStore only on native
let _secureStore: typeof import('expo-secure-store') | null = null;
function getSecureStore() {
  if (_secureStore) return _secureStore;
  if (typeof window !== 'undefined' && Platform.OS !== 'web') {
    _secureStore = require('expo-secure-store');
  }
  return _secureStore;
}

// Safe wrappers — no-op on SSR/web, real on native
async function secureGet(key: string): Promise<string | null> {
  const store = getSecureStore();
  if (!store) return null;
  return await store.getItemAsync(key);
}
async function secureSet(key: string, value: string): Promise<void> {
  const store = getSecureStore();
  if (!store) return;
  await store.setItemAsync(key, value);
}
async function secureDelete(key: string): Promise<void> {
  const store = getSecureStore();
  if (!store) return;
  await store.deleteItemAsync(key);
}

export const authService = {
  // Store session securely - ALL operations awaited individually
  async storeSession(accessToken: string, refreshToken: string, orgId: string, userId: string, role: string) {
    console.log('🔐 [AUTH] Starting session storage...');
    await secureSet(TOKEN_KEY, accessToken);
    console.log('🔐 [AUTH] ✅ Access token stored');
    await secureSet(REFRESH_TOKEN_KEY, refreshToken);
    console.log('🔐 [AUTH] ✅ Refresh token stored');
    await secureSet(ORG_ID_KEY, orgId);
    console.log('🔐 [AUTH] ✅ Organisation ID stored');
    await secureSet(USER_ID_KEY, userId);
    console.log('🔐 [AUTH] ✅ User ID stored');
    await secureSet(USER_ROLE_KEY, role);
    console.log('🔐 [AUTH] ✅ User role stored');
    console.log('🔐 [AUTH] All session data stored successfully');
  },

  // Get stored access token
  async getAccessToken(): Promise<string | null> {
    return await secureGet(TOKEN_KEY);
  },

  // Get stored refresh token
  async getRefreshToken(): Promise<string | null> {
    return await secureGet(REFRESH_TOKEN_KEY);
  },

  // Get organisation ID
  async getOrganisationId(): Promise<string | null> {
    return await secureGet(ORG_ID_KEY);
  },

  // Clear all stored data - sequential deletion with logging
  async clearSession() {
    console.log('🗑️ [AUTH] Starting session clearance...');
    await secureDelete(TOKEN_KEY);
    console.log('🗑️ [AUTH] ✅ Access token deleted');
    await secureDelete(REFRESH_TOKEN_KEY);
    console.log('🗑️ [AUTH] ✅ Refresh token deleted');
    await secureDelete(ORG_ID_KEY);
    console.log('🗑️ [AUTH] ✅ Organisation ID deleted');
    await secureDelete(USER_ID_KEY);
    console.log('🗑️ [AUTH] ✅ User ID deleted');
    await secureDelete(USER_ROLE_KEY);
    console.log('🗑️ [AUTH] ✅ User role deleted');
    console.log('✅ [AUTH] All session data cleared');
  },

  // Check if session is valid
  async isSessionValid(): Promise<boolean> {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },

  // Refresh session
  async refreshSession(): Promise<boolean> {
    try {
      const storedAccess = await secureGet(TOKEN_KEY);
      const storedRefresh = await secureGet(REFRESH_TOKEN_KEY);
      if (!storedAccess || !storedRefresh) return false;
      await supabase.auth.setSession({
        access_token: storedAccess,
        refresh_token: storedRefresh,
      });
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session) {
        return false;
      }
      await secureSet(TOKEN_KEY, data.session.access_token);
      await secureSet(REFRESH_TOKEN_KEY, data.session.refresh_token);
      return true;
    } catch {
      return false;
    }
  },
};
