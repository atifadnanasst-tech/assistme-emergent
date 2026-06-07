/**
 * AssistMe — SettingsScreenShell.tsx
 * Phase 2, Jun 2026
 *
 * Reusable shell for all settings screens.
 * Handles: header, back, save button, loading state, error state,
 * KeyboardAvoidingView, ScrollView, SafeAreaView.
 *
 * Used by: BusinessProfileScreen (v1), future: Subscription, Permissions, Toggles
 */
import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

interface SettingsScreenShellProps {
  title: string;
  saving?: boolean;
  loading?: boolean;
  error?: string | null;
  onSave?: () => void;
  onRetry?: () => void;
  showSave?: boolean;
  saveLabel?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsScreenShell({
  title,
  saving = false,
  loading = false,
  error = null,
  onSave,
  onRetry,
  showSave = true,
  saveLabel = 'Save',
  footer,
  children,
}: SettingsScreenShellProps) {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safeTop} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          disabled={saving}
        >
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
        {showSave && onSave ? (
          <TouchableOpacity
            onPress={onSave}
            style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
            disabled={saving || loading}
          >
            {saving
              ? <ActivityIndicator size="small" color="#FFFFFF" />
              : <Text style={styles.saveBtnText}>{saveLabel}</Text>
            }
          </TouchableOpacity>
        ) : (
          <View style={styles.headerRight} />
        )}
      </View>

      {/* Loading state */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      ) : error ? (
        /* Error state */
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          {onRetry && (
            <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        /* Content */
        <KeyboardAvoidingView
          style={styles.flex1}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
            {footer}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeTop: { flex: 1, backgroundColor: '#075E54' },
  flex1: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '600', color: '#FFFFFF' },
  headerRight: { width: 60 },
  saveBtn: {
    backgroundColor: '#25D366',
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 8,
    minWidth: 60,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: { color: '#666666', fontSize: 14 },
  errorContainer: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  errorText: { color: '#D32F2F', fontSize: 15, textAlign: 'center' },
  retryBtn: {
    backgroundColor: '#075E54',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryBtnText: { color: '#FFFFFF', fontWeight: '600' },
  scroll: { flex: 1, backgroundColor: '#F5F5F5' },
  scrollContent: { padding: 16 },
});
