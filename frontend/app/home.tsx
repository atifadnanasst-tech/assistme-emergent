import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { authService } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export default function HomeScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();

  const handleLogout = async () => {
    console.log('🚪 [LOGOUT] Starting logout sequence...');
    
    try {
      // STEP 1: Delete all SecureStore items in sequence
      console.log('🗑️ [LOGOUT] Clearing SecureStore...');
      await authService.clearSession();
      console.log('✅ [LOGOUT] SecureStore cleared');
      
      // STEP 2: Sign out from Supabase
      console.log('🔓 [LOGOUT] Signing out from Supabase...');
      await supabase.auth.signOut();
      console.log('✅ [LOGOUT] Supabase signOut complete');
      
      // STEP 3: Update auth state
      console.log('🔐 [LOGOUT] Setting authentication state to false');
      setIsAuthenticated(false);
      console.log('✅ [LOGOUT] Auth state updated');
      
      // STEP 4: Navigate to login
      console.log('🚀 [LOGOUT] Navigating to login...');
      router.replace('/login');
      console.log('✅ [LOGOUT] Logout complete');
    } catch (error) {
      console.error('❌ [LOGOUT] Error during logout:', error);
      // Still update state and navigate even if there's an error
      setIsAuthenticated(false);
      router.replace('/login');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerText}>AssistMe Home</Text>
      </View>
      
      <View style={styles.content}>
        <Text style={styles.title}>Welcome to AssistMe!</Text>
        <Text style={styles.subtitle}>
          You&apos;re now logged in. Future flows will be built here.
        </Text>

        <TouchableOpacity style={styles.button} onPress={handleLogout}>
          <Text style={styles.buttonText}>Logout</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    backgroundColor: '#075E54',
    paddingVertical: 16,
    paddingHorizontal: 24,
  },
  headerText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#075E54',
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 16,
    color: '#667781',
    textAlign: 'center',
    marginBottom: 32,
  },
  button: {
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
