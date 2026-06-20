import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { authService } from '../../../lib/auth';
import SettingsSaveBar from '../../../components/settings/SettingsSaveBar';

function timeStringToDate(timeStr: string): Date {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

function dateToTimeString(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatDisplay(d: Date): string {
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export default function HoursAvailabilityScreen() {
  const router = useRouter();
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedStart, setSavedStart] = useState<string>('08:00');
  const [savedEnd, setSavedEnd] = useState<string>('23:00');
  const [start, setStart] = useState<Date>(timeStringToDate('08:00'));
  const [end, setEnd] = useState<Date>(timeStringToDate('23:00'));
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  const dirty = dateToTimeString(start) !== savedStart || dateToTimeString(end) !== savedEnd;

  const loadSettings = async () => {
    try {
      const token = await authService.getAccessToken();
      const res = await fetch(`${backendUrl}/api/organisations/settings`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const wh = data?.settings?.working_hours;
      if (wh?.start) { setSavedStart(wh.start); setStart(timeStringToDate(wh.start)); }
      if (wh?.end) { setSavedEnd(wh.end); setEnd(timeStringToDate(wh.end)); }
    } catch (err) {
      console.error('[HoursAvailability] load error:', err);
      Alert.alert('Error', 'Could not load your current settings. Showing defaults.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSettings(); }, []);

  const handleDiscard = () => {
    setStart(timeStringToDate(savedStart));
    setEnd(timeStringToDate(savedEnd));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = await authService.getAccessToken();
      const res = await fetch(`${backendUrl}/api/organisations/settings`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ working_hours: { start: dateToTimeString(start), end: dateToTimeString(end) } }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Save failed');
      }
      const data = await res.json();
      const wh = data?.settings?.working_hours;
      if (wh?.start) { setSavedStart(wh.start); setStart(timeStringToDate(wh.start)); }
      if (wh?.end) { setSavedEnd(wh.end); setEnd(timeStringToDate(wh.end)); }
    } catch (err) {
      console.error('[HoursAvailability] save error:', err);
      Alert.alert('Error', 'Could not save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Hours & Availability</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      ) : (
        <View style={styles.content}>
          <Text style={styles.sectionLabel}>WORKING HOURS</Text>
          <Text style={styles.sectionDescription}>
            AssistMe will only send you pushes and nudges within this window. Background work still happens outside it -- you just won't be interrupted.
          </Text>

          <View style={styles.fieldRow}>
            <Ionicons name="sunny-outline" size={22} color="#075E54" />
            <Text style={styles.fieldLabel}>Start</Text>
            <TouchableOpacity style={styles.fieldValue} onPress={() => setShowStartPicker(true)}>
              <Text style={styles.fieldValueText}>{formatDisplay(start)}</Text>
              <Ionicons name="chevron-down" size={18} color="#666" />
            </TouchableOpacity>
          </View>
          {showStartPicker && (
            <DateTimePicker
              value={start}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event: any, date?: Date) => {
                if (Platform.OS === 'android') setShowStartPicker(false);
                if (date) setStart(date);
              }}
              themeVariant="light"
            />
          )}

          <View style={styles.fieldRow}>
            <Ionicons name="moon-outline" size={22} color="#075E54" />
            <Text style={styles.fieldLabel}>End</Text>
            <TouchableOpacity style={styles.fieldValue} onPress={() => setShowEndPicker(true)}>
              <Text style={styles.fieldValueText}>{formatDisplay(end)}</Text>
              <Ionicons name="chevron-down" size={18} color="#666" />
            </TouchableOpacity>
          </View>
          {showEndPicker && (
            <DateTimePicker
              value={end}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event: any, date?: Date) => {
                if (Platform.OS === 'android') setShowEndPicker(false);
                if (date) setEnd(date);
              }}
              themeVariant="light"
            />
          )}
        </View>
      )}

      {!loading && (
        <SettingsSaveBar dirty={dirty} saving={saving} onSave={handleSave} onDiscard={handleDiscard} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '600', color: '#FFFFFF', marginLeft: 8 },
  headerSpacer: { width: 40 },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1, padding: 16 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#667781', letterSpacing: 0.5, marginBottom: 6 },
  sectionDescription: { fontSize: 13, color: '#667781', marginBottom: 20, lineHeight: 18 },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  fieldLabel: { fontSize: 15, color: '#111111', marginLeft: 12, flex: 1 },
  fieldValue: { flexDirection: 'row', alignItems: 'center' },
  fieldValueText: { fontSize: 15, color: '#075E54', fontWeight: '600', marginRight: 4 },
});
