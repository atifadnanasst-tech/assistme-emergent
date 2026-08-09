import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId: '06cec730-38f8-462b-96e3-a7f29fb9b804' });
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
      await Notifications.setNotificationChannelAsync('messages_v2', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
      });
    }
  } catch (err) {
    console.error('[PUSH] Registration failed (non-fatal):', err);
    try {
      const { authService } = require('../lib/auth');
      const accessToken = await authService.getAccessToken();
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      if (accessToken && backendUrl) {
        await fetch(`${backendUrl}/api/debug/push-error`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
          body: JSON.stringify({ error: err?.message || String(err), stack: err?.stack }),
        });
      }
    } catch (_) {}
  }
}

// Module-level dedup: getLastNotificationResponseAsync returns the stale last
// response on every mount. We track its identifier so we only process each
// unique notification once, regardless of how many times the layout remounts.
let _lastHandledNotificationId: string | null = null;

// TanStack Query + AsyncStorage persistence (offline-cache sprint, per
// AssistMe_Offline_Cache_Handover.md -- fully resolved architectural
// decision, TanStack + AsyncStorage over Zustand/SQLite).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst',
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 60 * 24,
      retry: 2,
    },
    mutations: {
      networkMode: 'offlineFirst',
    },
  },
});

const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'ASSISTME_QUERY_CACHE',
  throttleTime: 1000,
});

function RootLayoutNav() {
  const [isReady, setIsReady] = useState(false);
  const { isAuthenticated, isCheckingAuth } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const pendingNotificationRouteRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isCheckingAuth && !isReady) {
      setIsReady(true);
      SplashScreen.hideAsync();
    }
    if (!isCheckingAuth && isAuthenticated) {
      registerForPushNotifications();
    }
  }, [isCheckingAuth, isReady, isAuthenticated]);

  useEffect(() => {
    const navigateToNotificationRoute = (tab: string) => {
      console.log('[PUSH] Navigating to activity tab:', tab);
      router.push({ pathname: '/activity', params: { tab } });
    };

    const resolveTab = (data: any): string =>
      data?.route_hint === 'mytasks' ? 'mytasks' : 'watchlist';

    const handleResponse = (
      response: Notifications.NotificationResponse | null,
      immediate: boolean
    ) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (_lastHandledNotificationId === id) {
        console.log('[PUSH] Duplicate notification ignored, id:', id);
        return;
      }
      _lastHandledNotificationId = id;
      const data = response.notification.request.content.data as any;
      if (!data) return;
      const tab = resolveTab(data);
      if (immediate) {
        console.log('[PUSH] Backgrounded tap — routing immediately to:', tab);
        navigateToNotificationRoute(tab);
      } else {
        console.log('[PUSH] Terminated launch — capturing pending route to:', tab);
        pendingNotificationRouteRef.current = tab;
      }
    };

    Notifications.getLastNotificationResponseAsync().then(r => handleResponse(r, false));
    const sub = Notifications.addNotificationResponseReceivedListener(r => handleResponse(r, true));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!isReady || isCheckingAuth) {
      console.log('🚦 [LAYOUT] Auth check in progress, skipping navigation logic');
      return;
    }

    if (pendingNotificationRouteRef.current) {
      const tab = pendingNotificationRouteRef.current;
      pendingNotificationRouteRef.current = null;
      console.log('[PUSH] Executing pending notification route to activity tab:', tab);
      router.push({ pathname: '/activity', params: { tab } });
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
      console.log('🚀 [LAYOUT] Authenticated user on auth screen → redirecting to /home');
      router.replace('/home');
    } else if (!isAuthenticated && !inAuthGroup && segments[0] !== undefined) {
      console.log('🚀 [LAYOUT] Unauthenticated user on protected screen → redirecting to /login');
      router.replace('/login');
    } else {
      console.log('✅ [LAYOUT] User on correct screen, no redirect needed');
    }
  }, [isReady, isAuthenticated, isCheckingAuth, segments]);

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
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister: asyncStoragePersister, maxAge: 1000 * 60 * 60 * 24 }}
    >
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </PersistQueryClientProvider>
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
