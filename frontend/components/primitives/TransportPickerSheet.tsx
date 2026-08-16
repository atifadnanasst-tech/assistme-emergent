/**
 * AssistMe - TransportPickerSheet primitive
 * Location: /frontend/components/primitives/TransportPickerSheet.tsx
 * Created: Aug 2026 (Delivery Challan feature)
 *
 * PURPOSE: UI-only picker for a customer's saved transport names -- a
 * simpler sibling to AddressPickerSheet (deliberately NOT a modification
 * of that already-working component, to avoid any regression risk to
 * the address picker). Same BottomSheet primitive, same list + inline
 * "add new" pattern, but a single text field instead of a full address.
 *
 * Backend: reuses the EXISTING GET/POST /api/customer/:customer_id/addresses
 * endpoints with type=transport -- no new backend work needed. The
 * transport name is stored in that table's existing line1 column.
 *
 * CURRENT CONSUMERS: customer/[id]/invoice.tsx (Delivery Challan transport field)
 */

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';

export interface TransportOption {
  id: string;
  line1: string;
  is_default?: boolean;
}

interface TransportPickerSheetProps {
  visible: boolean;
  options: TransportOption[];
  loading?: boolean;
  saving?: boolean;
  onSelect: (option: TransportOption) => void;
  onAddNew: (name: string) => void;
  onDismiss: () => void;
}

export default function TransportPickerSheet({
  visible, options, loading = false, saving = false, onSelect, onAddNew, onDismiss,
}: TransportPickerSheetProps) {
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [newName, setNewName] = useState('');

  const handleDismiss = () => {
    setMode('list');
    setNewName('');
    onDismiss();
  };

  const handleSelect = (option: TransportOption) => {
    setMode('list');
    setNewName('');
    onSelect(option);
  };

  const canSave = newName.trim().length > 0;

  const handleSaveNew = () => {
    if (!canSave) return;
    onAddNew(newName.trim());
  };

  return (
    <BottomSheet visible={visible} onDismiss={handleDismiss}>
      <Text style={styles.heading}>
        {mode === 'list' ? 'Choose Transport' : 'Add New Transport'}
      </Text>

      {mode === 'list' ? (
        <>
          {loading ? (
            <ActivityIndicator color="#075E54" style={{ marginVertical: 20 }} />
          ) : options.length === 0 ? (
            <Text style={styles.emptyText}>No saved transport names yet for this customer.</Text>
          ) : (
            options.map(opt => (
              <TouchableOpacity key={opt.id} style={styles.optionRow} onPress={() => handleSelect(opt)}>
                <Text style={styles.optionText}>{opt.line1}</Text>
                {opt.is_default && <Text style={styles.defaultBadge}>Default</Text>}
              </TouchableOpacity>
            ))
          )}

          <TouchableOpacity style={styles.addNewRow} onPress={() => setMode('add')}>
            <Ionicons name="add-circle-outline" size={20} color="#075E54" />
            <Text style={styles.addNewText}>Add new transport</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.label}>Transport Name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Janta Carrying"
            placeholderTextColor="#999"
            value={newName}
            onChangeText={setNewName}
            autoFocus
          />

          <View style={styles.actions}>
            <TouchableOpacity style={styles.backBtn} onPress={() => { setMode('list'); setNewName(''); }} disabled={saving}>
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
              onPress={handleSaveNew} disabled={saving || !canSave}
            >
              {saving ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.saveText}>Save & Use</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 16 },
  emptyText: { color: '#999', fontSize: 14, marginVertical: 12 },
  optionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  optionText: { fontSize: 14, fontWeight: '600', color: '#333' },
  defaultBadge: { fontSize: 11, fontWeight: '700', color: '#075E54', backgroundColor: '#E8F5E9', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  addNewRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, marginTop: 4 },
  addNewText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  label: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6, marginTop: 4 },
  input: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1A1A1A', backgroundColor: '#FAFAFA' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 24, marginBottom: 8 },
  backBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: '#E0E0E0', alignItems: 'center' },
  backText: { fontSize: 15, fontWeight: '600', color: '#666' },
  saveBtn: { flex: 2, paddingVertical: 14, borderRadius: 10, backgroundColor: '#075E54', alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: '#CCC' },
  saveText: { fontSize: 15, fontWeight: '700', color: '#FFF' },
});
