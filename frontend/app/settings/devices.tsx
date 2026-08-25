/**
 * AssistMe - Linked Devices Screen
 * Location: /frontend/app/settings/devices.tsx
 * Created: Aug 2026 (Linked Devices feature, subtask 2 -- replaces the
 * pre-existing "Coming Soon" stub)
 *
 * List/rename/remove for devices currently registered to this org.
 * Remove is COOPERATIVE revocation (deletes the device_sessions row;
 * see the design note on the backend's device endpoints for why this
 * was chosen over Supabase Auth's own per-session sign-out).
 *
 * "Add Seat" is a placeholder for now -- the actual Razorpay seat-
 * purchase flow is a separate, deliberately follow-up subtask.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../../lib/auth';

interface DeviceSession {
  id: string;
  device_id: string;
  device_name: string;
  last_active_at: string;
  created_at: string;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 2) return 'Active now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function LinkedDevices() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [seatsPurchased, setSeatsPurchased] = useState(1);
  const [renamingDevice, setRenamingDevice] = useState<DeviceSession | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const getToken = async () => authService.getAccessToken();

  const loadDevices = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/devices`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
        setSeatsPurchased(data.seats_purchased || 1);
      }
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { loadDevices(); }, []);

  const openRename = (device: DeviceSession) => {
    setRenamingDevice(device);
    setRenameInput(device.device_name);
  };

  const saveRename = async () => {
    if (!renamingDevice || !renameInput.trim()) return;
    setSavingRename(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/devices/${renamingDevice.id}`, {
        method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_name: renameInput.trim() }),
      });
      if (res.ok) {
        setDevices(prev => prev.map(d => d.id === renamingDevice.id ? { ...d, device_name: renameInput.trim() } : d));
        setRenamingDevice(null);
      } else {
        Alert.alert('Error', 'Could not rename this device');
      }
    } catch {
      Alert.alert('Error', 'Could not rename this device');
    } finally { setSavingRename(false); }
  };

  const confirmRemove = (device: DeviceSession) => {
    Alert.alert(
      'Remove Device',
      `Remove "${device.device_name}"? It will be signed out the next time it connects.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removeDevice(device) },
      ]
    );
  };

  const removeDevice = async (device: DeviceSession) => {
    setRemovingId(device.id);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/devices/${device.id}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        setDevices(prev => prev.filter(d => d.id !== device.id));
      } else {
        Alert.alert('Error', 'Could not remove this device');
      }
    } catch {
      Alert.alert('Error', 'Could not remove this device');
    } finally { setRemovingId(null); }
  };

  const seatsUsed = devices.length;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Linked Devices</Text>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
      ) : (
        <ScrollView contentContainerStyle={s.scrollContent}>
          <View style={s.seatsCard}>
            <Text style={s.seatsText}>{seatsUsed} of {seatsPurchased} seat{seatsPurchased !== 1 ? 's' : ''} used</Text>
            {seatsUsed >= seatsPurchased && (
              <Text style={s.seatsWarning}>You're at your device limit. Remove a device or add a seat to link a new one.</Text>
            )}
          </View>

          <Text style={s.sectionLabel}>DEVICES</Text>
          {devices.length === 0 ? (
            <Text style={s.emptyText}>No devices linked yet</Text>
          ) : (
            devices.map(device => (
              <View key={device.id} style={s.deviceRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.deviceName}>{device.device_name}</Text>
                  <Text style={s.deviceMeta}>{relativeTime(device.last_active_at)}</Text>
                </View>
                <TouchableOpacity onPress={() => openRename(device)} style={s.iconBtn}>
                  <Ionicons name="create-outline" size={20} color="#075E54" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => confirmRemove(device)} style={s.iconBtn} disabled={removingId === device.id}>
                  {removingId === device.id ? (
                    <ActivityIndicator size="small" color="#D32F2F" />
                  ) : (
                    <Ionicons name="trash-outline" size={20} color="#D32F2F" />
                  )}
                </TouchableOpacity>
              </View>
            ))
          )}

          <TouchableOpacity
            style={s.addSeatBtn}
            onPress={() => Alert.alert('Add Seat', 'Seat purchasing is coming very soon.')}
          >
            <Ionicons name="add-circle-outline" size={20} color="#075E54" />
            <Text style={s.addSeatText}>Add Seat</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      <Modal visible={!!renamingDevice} transparent animationType="fade" onRequestClose={() => setRenamingDevice(null)}>
        <KeyboardAvoidingView style={s.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rename Device</Text>
            <TextInput
              style={s.modalInput}
              value={renameInput}
              onChangeText={setRenameInput}
              placeholder="e.g. Hemant's phone"
              autoFocus
            />
            <View style={s.modalBtns}>
              <TouchableOpacity onPress={() => setRenamingDevice(null)} style={s.modalCancelBtn}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={saveRename} style={s.modalSaveBtn} disabled={savingRename}>
                {savingRename ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.modalSaveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  seatsCard: { backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginBottom: 16 },
  seatsText: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  seatsWarning: { fontSize: 13, color: '#D32F2F', marginTop: 6 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5, marginBottom: 8 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 20, fontSize: 14 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 14, marginBottom: 8 },
  deviceName: { fontSize: 15, fontWeight: '600', color: '#1A1A1A' },
  deviceMeta: { fontSize: 12, color: '#999', marginTop: 2 },
  iconBtn: { padding: 8, marginLeft: 4 },
  addSeatBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, marginTop: 12, borderWidth: 1, borderColor: '#075E54', borderRadius: 10, borderStyle: 'dashed' },
  addSeatText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalCard: { backgroundColor: '#FFF', borderRadius: 14, padding: 20, width: '85%' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1A1A1A', marginBottom: 12 },
  modalInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 16 },
  modalBtns: { flexDirection: 'row', gap: 10 },
  modalCancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E0E0E0', alignItems: 'center' },
  modalCancelText: { fontSize: 14, fontWeight: '600', color: '#666' },
  modalSaveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: '#075E54', alignItems: 'center' },
  modalSaveText: { fontSize: 14, fontWeight: '700', color: '#FFF' },
});
