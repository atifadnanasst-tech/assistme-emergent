import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider, useAuth } from '../contexts/AuthContext';

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const [isReady, setIsReady] = useState(false);
  const { isAuthenticated, isCheckingAuth } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    // Hide splash when auth check is complete
    if (!isCheckingAuth && !isReady) {
      setIsReady(true);
      SplashScreen.hideAsync();
    }
  }, [isCheckingAuth, isReady]);

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
      isCheckingAuth,
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

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootLayoutNav />
    </AuthProvider>
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
