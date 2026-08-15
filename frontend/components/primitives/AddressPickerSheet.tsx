/**
 * AssistMe - AddressPickerSheet primitive
 * Location: /frontend/components/primitives/AddressPickerSheet.tsx
 * Created: Aug 2026, ATT list #2 (Amazon-style shipping address picker)
 *
 * PURPOSE: UI-only address picker — shows saved addresses, lets the user
 *          pick one or add a new one inline. No API calls inside; caller
 *          owns fetching the list and creating new addresses, matching
 *          the exact same architecture as ProductFormSheet for consistency.
 *
 * Supports the middleman/affiliate use case: a customer with one default
 * warehouse address may still need shipments sent to many different
 * locations across different invoices -- this shows ALL saved addresses,
 * not just the single default one, sorted most-recent-first (caller's
 * responsibility to sort; this component just renders what it's given).
 *
 * CURRENT CONSUMERS: customer/[id]/invoice.tsx (Change delivery address)
 */

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';

export interface PickerAddress {
  id: string;
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  is_default?: boolean;
}

export interface NewAddressData {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

interface AddressPickerSheetProps {
  visible: boolean;
  addresses: PickerAddress[];
  loading?: boolean;
  saving?: boolean;
  onSelect: (address: PickerAddress) => void;
  onAddNew: (data: NewAddressData) => void;
  onDismiss: () => void;
}

export default function AddressPickerSheet({
  visible, addresses, loading = false, saving = false, onSelect, onAddNew, onDismiss,
}: AddressPickerSheetProps) {
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');

  const resetAddForm = () => {
    setLine1(''); setLine2(''); setCity(''); setState(''); setPostalCode('');
  };

  const handleDismiss = () => {
    setMode('list');
    resetAddForm();
    onDismiss();
  };

  const handleSelect = (address: PickerAddress) => {
    setMode('list');
    resetAddForm();
    onSelect(address);
  };

  const canSaveNew = line1.trim().length > 0;

  const handleSaveNew = () => {
    if (!canSaveNew) return;
    onAddNew({
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim() || undefined,
      state: state.trim() || undefined,
      postal_code: postalCode.trim() || undefined,
    });
  };

  const formatAddress = (a: PickerAddress) => {
    const parts = [a.line1, a.city, a.state].filter(Boolean);
    return parts.join(', ');
  };

  return (
    <BottomSheet visible={visible} onDismiss={handleDismiss}>
      <Text style={styles.heading}>
        {mode === 'list' ? 'Choose Delivery Address' : 'Add New Address'}
      </Text>

      {mode === 'list' ? (
        <>
          {loading ? (
            <ActivityIndicator color="#075E54" style={{ marginVertical: 20 }} />
          ) : addresses.length === 0 ? (
            <Text style={styles.emptyText}>No saved addresses yet for this customer.</Text>
          ) : (
            addresses.map(addr => (
              <TouchableOpacity key={addr.id} style={styles.addressRow} onPress={() => handleSelect(addr)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.addressText}>{formatAddress(addr)}</Text>
                  {addr.postal_code && <Text style={styles.addressSub}>{addr.postal_code}</Text>}
                </View>
                {addr.is_default && <Text style={styles.defaultBadge}>Default</Text>}
              </TouchableOpacity>
            ))
          )}

          <TouchableOpacity style={styles.addNewRow} onPress={() => setMode('add')}>
            <Ionicons name="add-circle-outline" size={20} color="#075E54" />
            <Text style={styles.addNewText}>Add new address</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.label}>Address Line 1 *</Text>
          <TextInput style={styles.input} placeholder="e.g. 12 MG Road" placeholderTextColor="#999" value={line1} onChangeText={setLine1} autoFocus />

          <Text style={styles.label}>Address Line 2</Text>
          <TextInput style={styles.input} placeholder="e.g. Near Brigade Towers" placeholderTextColor="#999" value={line2} onChangeText={setLine2} />

          <Text style={styles.label}>City</Text>
          <TextInput style={styles.input} placeholder="e.g. Bangalore" placeholderTextColor="#999" value={city} onChangeText={setCity} />

          <Text style={styles.label}>State</Text>
          <TextInput style={styles.input} placeholder="e.g. Karnataka" placeholderTextColor="#999" value={state} onChangeText={setState} />

          <Text style={styles.label}>Postal Code</Text>
          <TextInput style={styles.input} placeholder="e.g. 560001" placeholderTextColor="#999" keyboardType="numeric" value={postalCode} onChangeText={setPostalCode} />

          <View style={styles.actions}>
            <TouchableOpacity style={styles.backBtn} onPress={() => { setMode('list'); resetAddForm(); }} disabled={saving}>
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, !canSaveNew && styles.saveBtnDisabled]}
              onPress={handleSaveNew} disabled={saving || !canSaveNew}
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
  addressRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  addressText: { fontSize: 14, fontWeight: '600', color: '#333' },
  addressSub: { fontSize: 12, color: '#888', marginTop: 2 },
  defaultBadge: { fontSize: 11, fontWeight: '700', color: '#075E54', backgroundColor: '#E8F5E9', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  addNewRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, marginTop: 4 },
  addNewText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  label: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6, marginTop: 12 },
  input: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1A1A1A', backgroundColor: '#FAFAFA' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 24, marginBottom: 8 },
  backBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: '#E0E0E0', alignItems: 'center' },
  backText: { fontSize: 15, fontWeight: '600', color: '#666' },
  saveBtn: { flex: 2, paddingVertical: 14, borderRadius: 10, backgroundColor: '#075E54', alignItems: 'center' },
  saveBtnDisabled: { backgroundColor: '#CCC' },
  saveText: { fontSize: 15, fontWeight: '700', color: '#FFF' },
});
