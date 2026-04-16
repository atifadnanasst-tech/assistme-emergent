import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { authService } from '../lib/auth';
import { supabase } from '../lib/supabase';

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    // LOADING GATE: Do not run redirect logic while auth state is loading
    if (!isReady || isCheckingAuth) {
      console.log('🚦 [LAYOUT] Auth check in progress, skipping navigation logic');
      return;
    }

    const inAuthGroup = segments[0] === 'login' || segments[0] === 'otp';

    console.log('🚦 [LAYOUT] Navigation guard executing:', {
      isAuthenticated,
      currentSegment: segments[0],
      inAuthGroup,
    });

    if (isAuthenticated && inAuthGroup) {
      // Redirect to home if authenticated and on auth screens
      console.log('🚀 [LAYOUT] Authenticated user on auth screen → redirecting to /home');
      router.replace('/home');
    } else if (!isAuthenticated && !inAuthGroup && segments[0] !== undefined) {
      // Redirect to login if not authenticated and not on auth screens
      console.log('🚀 [LAYOUT] Unauthenticated user on protected screen → redirecting to /login');
      router.replace('/login');
    } else {
      console.log('✅ [LAYOUT] User on correct screen, no redirect needed');
    }
  }, [isReady, isAuthenticated, isCheckingAuth, segments]);

  const checkAuth = async () => {
    setIsCheckingAuth(true);
    console.log('🔍 [LAYOUT] Starting auth check...');
    
    try {
      // Check if we have a stored session
      const token = await authService.getAccessToken();
      console.log('🔍 [LAYOUT] Token check:', token ? 'Token found' : 'No token');
      
      if (token) {
        // Validate session with Supabase
        const isValid = await authService.isSessionValid();
        console.log('🔍 [LAYOUT] Session validity:', isValid);
        
        if (isValid) {
          setIsAuthenticated(true);
          console.log('✅ [LAYOUT] Session valid - user authenticated');
        } else {
          // Try to refresh
          console.log('🔄 [LAYOUT] Session invalid, attempting refresh...');
          const refreshed = await authService.refreshSession();
          if (refreshed) {
            setIsAuthenticated(true);
            console.log('✅ [LAYOUT] Session refreshed - user authenticated');
          } else {
            // Clear invalid session
            await authService.clearSession();
            setIsAuthenticated(false);
            console.log('❌ [LAYOUT] Refresh failed - clearing session');
          }
        }
      } else {
        setIsAuthenticated(false);
        console.log('❌ [LAYOUT] No token - user not authenticated');
      }
    } catch (error) {
      console.error('❌ [LAYOUT] Auth check error:', error);
      setIsAuthenticated(false);
    } finally {
      setIsCheckingAuth(false);
      setIsReady(true);
      await SplashScreen.hideAsync();
      console.log('✅ [LAYOUT] Auth check complete');
    }
  };

  // LOADING GATE: Show loading screen while checking auth
  if (!isReady || isCheckingAuth) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#075E54" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#FFFFFF' },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="otp" options={{ headerShown: false }} />
      <Stack.Screen name="home" options={{ headerShown: false }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
});
