import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

// Get Supabase credentials from environment variables
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('⚠️ Missing Supabase credentials in .env');
}

// Determine if we are running on a native device (not SSR, not web)
const isNative =
  typeof window !== 'undefined' && Platform.OS !== 'web';

// No-op storage for SSR / web — silent, returns null
const NoOpStorage = {
  getItem: async (_key: string): Promise<string | null> => null,
  setItem: async (_key: string, _value: string): Promise<void> => {},
  removeItem: async (_key: string): Promise<void> => {},
};

// Build the storage adapter lazily so SecureStore is never imported at
// module-evaluation time in non-native environments.
function buildStorageAdapter() {
  if (!isNative) return NoOpStorage;

  // Dynamic require keeps the import out of the SSR bundle evaluation path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require('expo-secure-store');

  return {
    getItem: async (key: string): Promise<string | null> => {
      return await SecureStore.getItemAsync(key);
    },
    setItem: async (key: string, value: string): Promise<void> => {
      await SecureStore.setItemAsync(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      await SecureStore.deleteItemAsync(key);
    },
  };
}

const StorageAdapter = buildStorageAdapter();

// Create Supabase client with environment-safe storage
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: StorageAdapter,
    autoRefreshToken: true,
    persistSession: isNative,
    detectSessionInUrl: false,
  },
});
