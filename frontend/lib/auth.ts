import * as SecureStore from 'expo-secure-store';
import { supabase } from './supabase';

const TOKEN_KEY = 'supabase_access_token';
const REFRESH_TOKEN_KEY = 'supabase_refresh_token';
const ORG_ID_KEY = 'organisation_id';
const USER_ID_KEY = 'user_id';
const USER_ROLE_KEY = 'user_role';

export const authService = {
  // Store session securely
  async storeSession(accessToken: string, refreshToken: string, orgId: string, userId: string, role: string) {
    await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
    await SecureStore.setItemAsync(ORG_ID_KEY, orgId);
    await SecureStore.setItemAsync(USER_ID_KEY, userId);
    await SecureStore.setItemAsync(USER_ROLE_KEY, role);
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

  // Clear all stored data
  async clearSession() {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(ORG_ID_KEY);
    await SecureStore.deleteItemAsync(USER_ID_KEY);
    await SecureStore.deleteItemAsync(USER_ROLE_KEY);
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
