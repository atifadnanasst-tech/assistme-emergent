import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { AuthProvider, useAuth } from '../contexts/AuthContext';

// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

async function registerForPushNotifications() {
  try {
    if (Platform.OS === 'web') return;
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.log('[PUSH] Permission not granted');
      return;
    }
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const pushToken = tokenData.data;
    console.log('[PUSH] Token obtained:', pushToken);
    const { authService } = require('../lib/auth');
    const accessToken = await authService.getAccessToken();
    if (!accessToken) return;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    await fetch(`${backendUrl}/api/users/push-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ push_token: pushToken }),
    });
    console.log('[PUSH] Token saved to backend');
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
      });
    }
  } catch (err) {
    console.error('[PUSH] Registration failed (non-fatal):', err);
  }
}

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
    // Register for push notifications once authenticated
    if (!isCheckingAuth && isAuthenticated) {
      registerForPushNotifications();
    }
  }, [isCheckingAuth, isReady, isAuthenticated]);

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
      <Stack.Screen name="products" options={{ headerShown: false }} />
      <Stack.Screen name="ai" options={{ headerShown: false }} />
      <Stack.Screen name="activity" options={{ headerShown: false }} />
      <Stack.Screen name="lists" options={{ headerShown: false }} />
      <Stack.Screen name="customer/new" options={{ headerShown: false }} />
      <Stack.Screen name="group/new" options={{ headerShown: false }} />
      <Stack.Screen name="broadcast/new" options={{ headerShown: false }} />
      <Stack.Screen name="settings/devices" options={{ headerShown: false }} />
      <Stack.Screen name="settings/team" options={{ headerShown: false }} />
      <Stack.Screen name="settings/profile" options={{ headerShown: false }} />
      <Stack.Screen name="settings/staff" options={{ headerShown: false }} />
      <Stack.Screen name="settings/billing" options={{ headerShown: false }} />
      <Stack.Screen name="settings/catalogs" options={{ headerShown: false }} />
      <Stack.Screen name="settings/notifications" options={{ headerShown: false }} />
      <Stack.Screen name="settings/appearance" options={{ headerShown: false }} />
      <Stack.Screen name="settings/social" options={{ headerShown: false }} />
      <Stack.Screen name="settings/export" options={{ headerShown: false }} />
      <Stack.Screen name="settings/help" options={{ headerShown: false }} />
      <Stack.Screen name="settings/language" options={{ headerShown: false }} />
      <Stack.Screen name="settings/disclaimer" options={{ headerShown: false }} />
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
