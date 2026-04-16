import * as SecureStore from 'expo-secure-store';
import { supabase } from './supabase';

const TOKEN_KEY = 'supabase_access_token';
const REFRESH_TOKEN_KEY = 'supabase_refresh_token';
const ORG_ID_KEY = 'organisation_id';
const USER_ID_KEY = 'user_id';
const USER_ROLE_KEY = 'user_role';

export const authService = {
  // Store session securely - ALL operations awaited individually
  async storeSession(accessToken: string, refreshToken: string, orgId: string, userId: string, role: string) {
    console.log('🔐 [AUTH] Starting session storage...');
    await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
    console.log('🔐 [AUTH] ✅ Access token stored');
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
    console.log('🔐 [AUTH] ✅ Refresh token stored');
    await SecureStore.setItemAsync(ORG_ID_KEY, orgId);
    console.log('🔐 [AUTH] ✅ Organisation ID stored');
    await SecureStore.setItemAsync(USER_ID_KEY, userId);
    console.log('🔐 [AUTH] ✅ User ID stored');
    await SecureStore.setItemAsync(USER_ROLE_KEY, role);
    console.log('🔐 [AUTH] ✅ User role stored');
    console.log('🔐 [AUTH] All session data stored successfully');
  },

  // Get stored access token
  async getAccessToken(): Promise<string | null> {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  },

  // Get stored refresh token
  async getRefreshToken(): Promise<string | null> {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  },

  // Get organisation ID
  async getOrganisationId(): Promise<string | null> {
    return await SecureStore.getItemAsync(ORG_ID_KEY);
  },

  // Clear all stored data - sequential deletion with logging
  async clearSession() {
    console.log('🗑️ [AUTH] Starting session clearance...');
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    console.log('🗑️ [AUTH] ✅ Access token deleted');
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    console.log('🗑️ [AUTH] ✅ Refresh token deleted');
    await SecureStore.deleteItemAsync(ORG_ID_KEY);
    console.log('🗑️ [AUTH] ✅ Organisation ID deleted');
    await SecureStore.deleteItemAsync(USER_ID_KEY);
    console.log('🗑️ [AUTH] ✅ User ID deleted');
    await SecureStore.deleteItemAsync(USER_ROLE_KEY);
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
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session) {
        return false;
      }
      
      // Update stored tokens
      await SecureStore.setItemAsync(TOKEN_KEY, data.session.access_token);
      await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.session.refresh_token);
      return true;
    } catch {
      return false;
    }
  },
};
