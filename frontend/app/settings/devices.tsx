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
import { supabase } from '../../lib/supabase';
import RazorpayCheckout from 'react-native-razorpay';
import { getOrCreateDeviceId } from '../../lib/deviceId';
import { useAuth } from '../../contexts/AuthContext';

interface DeviceSession {
  id: string;
  device_id: string;
  device_name: string;
  last_active_at: string;
  created_at: string;
  is_primary?: boolean;
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
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [blockedDevices, setBlockedDevices] = useState<DeviceSession[]>([]);
  const [seatsPurchased, setSeatsPurchased] = useState(1);
  const [renamingDevice, setRenamingDevice] = useState<DeviceSession | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [purchasingSeat, setPurchasingSeat] = useState(false);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);

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
        setBlockedDevices(data.blocked_devices || []);
        setSeatsPurchased(data.seats_purchased || 1);
      }
    } catch {} finally { setLoading(false); }
  };

  // Seat purchase (Aug 2026). Mirrors billing.tsx's own
  // openCheckoutAndVerify() pattern almost exactly, since a seat
  // purchase IS just another instance of the same Razorpay
  // subscription checkout (Atif's own design call) -- same
  // RazorpayCheckout.open() call shape, same verify-then-fallback
  // flow, just pointed at the new /api/seats/* endpoints.
  const handleAddSeat = async () => {
    if (purchasingSeat) return;
    setPurchasingSeat(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      const createRes = await fetch(`${backendUrl}/api/seats/create-subscription`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!createRes.ok) {
        Alert.alert('Could not start seat purchase', 'Please try again.');
        return;
      }
      const created = await createRes.json();

      // Pre-fill contact/email (Aug 2026, Atif's request) -- the owner
      // is already a known, logged-in member buying a seat for their
      // own org, so there's no reason to make them retype their own
      // phone number and email on Razorpay's own contact-details step.
      // react-native-razorpay's own documented prefill option (contact,
      // email, name) is exactly for this. Fails open to no pre-fill
      // (Razorpay just asks the person directly) if getUser() has any
      // trouble -- never blocks the purchase over this.
      let prefillContact: string | undefined;
      let prefillEmail: string | undefined;
      try {
        const { data: { user } } = await supabase.auth.getUser();
        prefillContact = user?.phone || undefined;
        prefillEmail = user?.email || undefined;
      } catch {}

      let paymentResult;
      try {
        paymentResult = await RazorpayCheckout.open({
          description: 'AssistMe — additional seat (monthly)',
          key: created.keyId,
          subscription_id: created.subscriptionId,
          name: 'AssistMe',
          theme: { color: '#075E54' },
          prefill: { contact: prefillContact, email: prefillEmail },
        });
      } catch (checkoutErr: any) {
        if (checkoutErr?.code !== 0) {
          Alert.alert('Not completed', checkoutErr?.description || 'Please try again.');
        }
        return;
      }

      const verifyRes = await fetch(`${backendUrl}/api/seats/verify-payment`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_subscription_id: paymentResult.razorpay_subscription_id,
          razorpay_payment_id: paymentResult.razorpay_payment_id,
          razorpay_signature: paymentResult.razorpay_signature,
        }),
      });

      if (verifyRes.ok) {
        Alert.alert('Seat Added', 'Your new seat is ready to use.');
        loadDevices();
      } else {
        Alert.alert('Payment received', 'Your payment went through. Your seat count may take a moment to update.');
        loadDevices();
      }
    } catch (err) {
      console.error('[handleAddSeat] error:', err);
      Alert.alert('Something went wrong', 'Please try again, or contact support if this continues.');
    } finally {
      setPurchasingSeat(false);
    }
  };

  useEffect(() => {
    loadDevices();
    // "This Device" label (Aug 2026, Atif's suggestion) -- lets the
    // owner immediately identify which row belongs to the phone
    // they're currently looking at, rather than guessing from the
    // generic default name.
    getOrCreateDeviceId().then(setThisDeviceId).catch(() => {});
  }, []);

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
        // Self-delete signs out immediately (Aug 2026, Atif's real-world
        // testing/suggestion) -- previously, deleting your OWN row only
        // took effect the next time this device happened to check in
        // (relaunch or resume from background, itself throttled to once
        // per 30s), which looked broken since the app just kept working
        // as if nothing happened. This device already knows, at this
        // exact moment, that it just removed itself -- no reason to
        // wait for a future check to notice what it already knows.
        if (device.device_id === thisDeviceId) {
          // Real bug fixed (Aug 2026, found via Atif's live testing):
          // this cleared the underlying session but never updated the
          // app's own shared auth state (setIsAuthenticated), leaving
          // the navigation guard still believing the user was logged
          // in while a direct router.replace('/login') fought it at
          // the same time -- two contradicting navigation instructions
          // produced a stuck, blank screen requiring a force-close.
          // Fixed to match the exact same pattern AuthContext.tsx's own
          // runDeviceCheck() already uses successfully: update
          // setIsAuthenticated(false) and let the existing navigation
          // guard handle the redirect itself, rather than forcing
          // navigation directly.
          await authService.clearSession();
          await supabase.auth.signOut();
          setIsAuthenticated(false);
        }
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
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={s.deviceName}>{device.device_name}</Text>
                    {device.is_primary && (
                      <View style={s.primaryBadge}><Text style={s.primaryBadgeText}>PRIMARY</Text></View>
                    )}
                    {device.device_id === thisDeviceId && (
                      <View style={s.thisDeviceBadge}><Text style={s.thisDeviceBadgeText}>THIS DEVICE</Text></View>
                    )}
                  </View>
                  <Text style={s.deviceMeta}>{relativeTime(device.last_active_at)}</Text>
                </View>
                <TouchableOpacity onPress={() => openRename(device)} style={s.iconBtn}>
                  <Ionicons name="create-outline" size={20} color="#075E54" />
                </TouchableOpacity>
                {/* Primary device can never be removed (Aug 2026) --
                    prevents a device given to a manager from removing
                    the actual owner's own device and locking them out. */}
                {!device.is_primary && (
                  <TouchableOpacity onPress={() => confirmRemove(device)} style={s.iconBtn} disabled={removingId === device.id}>
                    {removingId === device.id ? (
                      <ActivityIndicator size="small" color="#D32F2F" />
                    ) : (
                      <Ionicons name="trash-outline" size={20} color="#D32F2F" />
                    )}
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}

          <TouchableOpacity
            style={s.addSeatBtn}
            onPress={handleAddSeat}
            disabled={purchasingSeat}
          >
            {purchasingSeat ? (
              <ActivityIndicator size="small" color="#075E54" />
            ) : (
              <Ionicons name="add-circle-outline" size={20} color="#075E54" />
            )}
            <Text style={s.addSeatText}>{purchasingSeat ? 'Processing...' : 'Add Seat'}</Text>
          </TouchableOpacity>

          {/* Blocked attempts (Aug 2026, Atif's explicit ask) --
              "allowing is one thing, recognizing is another." A device
              rejected for exceeding the seat limit is now visible here,
              never counted toward the seat limit itself. */}
          {blockedDevices.length > 0 && (
            <>
              <Text style={[s.sectionLabel, { marginTop: 24 }]}>BLOCKED ATTEMPTS</Text>
              {blockedDevices.map(device => (
                <View key={device.id} style={[s.deviceRow, s.blockedRow]}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.deviceName}>{device.device_name}</Text>
                    <Text style={s.deviceMeta}>Blocked — tried {relativeTime(device.last_active_at)}</Text>
                  </View>
                </View>
              ))}
            </>
          )}
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
  primaryBadge: { backgroundColor: '#E8F5E9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  blockedRow: { opacity: 0.6, borderLeftWidth: 3, borderLeftColor: '#D32F2F' },
  primaryBadgeText: { fontSize: 9, fontWeight: '700', color: '#075E54', letterSpacing: 0.3 },
  thisDeviceBadge: { backgroundColor: '#E3F2FD', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  thisDeviceBadgeText: { fontSize: 9, fontWeight: '700', color: '#1565C0', letterSpacing: 0.3 },
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
