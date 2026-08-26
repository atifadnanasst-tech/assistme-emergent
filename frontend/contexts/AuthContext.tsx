import React, { createContext, useContext, useState, useEffect } from 'react';
import { authService } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { registerDevice } from '../lib/deviceId';

interface AuthContextType {
  isAuthenticated: boolean;
  isCheckingAuth: boolean;
  setIsAuthenticated: (value: boolean) => void;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  const checkAuth = async () => {
    setIsCheckingAuth(true);
    console.log('🔍 [AUTH_CONTEXT] Starting auth check...');
    
    try {
      // Check if we have a stored session
      const token = await authService.getAccessToken();
      console.log('🔍 [AUTH_CONTEXT] Token check:', token ? 'Token found' : 'No token');
      
      if (token) {
        // Restore session into Supabase client from stored tokens
        try {
          const refreshToken = await authService.getRefreshToken();
          if (refreshToken) {
            await supabase.auth.setSession({ access_token: token, refresh_token: refreshToken });
          }
        } catch (e) {
          console.warn('🔄 [AUTH_CONTEXT] Session restore failed:', e);
        }
        // Validate session with Supabase
        const isValid = await authService.isSessionValid();
        console.log('🔍 [AUTH_CONTEXT] Session validity:', isValid);
        
        if (isValid) {
          setIsAuthenticated(true);
          console.log('✅ [AUTH_CONTEXT] Session valid - user authenticated');
          // Linked Devices Phase 2 (Aug 2026, Atif's explicit ask):
          // registerDevice() is now AWAITED (was fire-and-forget in
          // Phase 1) so its enforcement decision can act before the
          // user sees the app. It fails open on any ambiguous outcome
          // (network error, unexpected status, unrecognized error code)
          // -- shouldSignOut is only ever true on a confirmed, explicit
          // 403 with a recognized error code from the server.
          const deviceCheck = await registerDevice();
          if (deviceCheck.shouldSignOut) {
            await authService.clearSession();
            await supabase.auth.signOut();
            setIsAuthenticated(false);
            console.log(`❌ [AUTH_CONTEXT] Device rejected (${deviceCheck.reason}) - signed out`);
            return;
          }
        } else {
          // Try to refresh
          console.log('🔄 [AUTH_CONTEXT] Session invalid, attempting refresh...');
          const refreshed = await authService.refreshSession();
          if (refreshed) {
            setIsAuthenticated(true);
            console.log('✅ [AUTH_CONTEXT] Session refreshed - user authenticated');
            const deviceCheck = await registerDevice();
            if (deviceCheck.shouldSignOut) {
              await authService.clearSession();
              await supabase.auth.signOut();
              setIsAuthenticated(false);
              console.log(`❌ [AUTH_CONTEXT] Device rejected (${deviceCheck.reason}) - signed out`);
              return;
            }
          } else {
            // Clear invalid session
            await authService.clearSession();
            setIsAuthenticated(false);
            console.log('❌ [AUTH_CONTEXT] Refresh failed - clearing session');
          }
        }
      } else {
        setIsAuthenticated(false);
        console.log('❌ [AUTH_CONTEXT] No token - user not authenticated');
      }
    } catch (error) {
      console.error('❌ [AUTH_CONTEXT] Auth check error:', error);
      setIsAuthenticated(false);
    } finally {
      setIsCheckingAuth(false);
      console.log('✅ [AUTH_CONTEXT] Auth check complete');
    }
  };

  useEffect(() => {
    checkAuth();

    // TOKEN_REFRESHED listener — syncs SecureStore after Supabase auto-refresh
    // Root cause: Supabase refreshes its session internally but authService reads
    // a separate SecureStore key. This keeps them in sync.
    // Uses updateTokens() — does NOT overwrite org/user metadata.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'TOKEN_REFRESHED' && session) {
          try {
            await authService.updateTokens(
              session.access_token,
              session.refresh_token,
            );
            console.log('[AUTH_CONTEXT] TOKEN_REFRESHED — SecureStore synced');
          } catch (err) {
            console.warn('[AUTH_CONTEXT] Failed to sync refreshed tokens', err);
          }
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isCheckingAuth, setIsAuthenticated, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
