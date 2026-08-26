import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
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
  // App-resume device check (Aug 2026, Atif's design): app launch alone
  // only re-verifies a device on a genuine force-kill-and-relaunch, which
  // real people rarely do -- most just switch apps and back, which does
  // NOT re-run launch logic in React Native. AppState's foreground
  // transition is the natural, much more frequent signal that actually
  // matches real usage, without going anywhere near per-request checks
  // on the busiest code path in the backend. isAuthenticatedRef mirrors
  // isAuthenticated so the AppState listener (subscribed once) always
  // sees the current value without needing to re-subscribe.
  const isAuthenticatedRef = useRef(isAuthenticated);
  const lastResumeCheckAt = useRef(0);
  useEffect(() => { isAuthenticatedRef.current = isAuthenticated; }, [isAuthenticated]);

  const runDeviceCheck = async () => {
    const deviceCheck = await registerDevice();
    if (deviceCheck.shouldSignOut) {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      console.log(`❌ [AUTH_CONTEXT] Device rejected (${deviceCheck.reason}) - signed out`);
    }
  };

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
          await runDeviceCheck();
        } else {
          // Try to refresh
          console.log('🔄 [AUTH_CONTEXT] Session invalid, attempting refresh...');
          const refreshed = await authService.refreshSession();
          if (refreshed) {
            setIsAuthenticated(true);
            console.log('✅ [AUTH_CONTEXT] Session refreshed - user authenticated');
            await runDeviceCheck();
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

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') return;
      if (!isAuthenticatedRef.current) return;
      const now = Date.now();
      // Throttle (Aug 2026): rapid background/foreground cycling (e.g.
      // pulling down a notification shade) shouldn't fire repeated
      // checks. 30s is generous enough to skip noise while still being
      // far more frequent than "only on a true force-kill relaunch."
      if (now - lastResumeCheckAt.current < 30000) return;
      lastResumeCheckAt.current = now;
      console.log('🔄 [AUTH_CONTEXT] App resumed to foreground - re-checking device');
      runDeviceCheck();
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
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
