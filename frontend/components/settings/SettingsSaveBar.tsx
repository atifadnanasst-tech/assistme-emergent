import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface SettingsSaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

// Shared Save/Discard bar for every Business Preferences category screen.
// Wrapped in its own bottom-edge SafeAreaView so it never sits behind the
// device's on-screen navigation buttons, regardless of phone/gesture mode --
// matches the established pattern already used in products.tsx, invoice.tsx,
// report.tsx, activity.tsx, and catalogs.tsx for fixed bottom action bars.
export default function SettingsSaveBar({ dirty, saving, onSave, onDiscard }: SettingsSaveBarProps) {
  if (!dirty) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.bar}>
        <TouchableOpacity style={styles.discardButton} onPress={onDiscard} disabled={saving}>
          <Text style={styles.discardButtonText}>Discard</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.saveButton} onPress={onSave} disabled={saving}>
          {saving ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.saveButtonText}>Save Changes</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: '#FFFFFF' },
  bar: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
    backgroundColor: '#FFFFFF',
  },
  discardButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginRight: 8,
    backgroundColor: '#F5F5F5',
  },
  discardButtonText: { color: '#667781', fontWeight: '600', fontSize: 15 },
  saveButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginLeft: 8,
    backgroundColor: '#25D366',
  },
  saveButtonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
});
