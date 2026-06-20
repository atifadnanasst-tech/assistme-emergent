import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, ActivityIndicator, Alert, Switch, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { authService } from '../../../lib/auth';
import SettingsSaveBar from '../../../components/settings/SettingsSaveBar';
import {
  OptionDef,
  ATTENTION_BUDGET_OPTIONS,
  PUSH_FREQUENCY_OPTIONS,
  WEEKEND_BEHAVIOR_OPTIONS,
  REMINDER_ESCALATION_OPTIONS,
} from '../../../constants/businessPreferences';

interface NotificationSettings {
  attention_budget: string;
  push_frequency: string;
  daily_brief_time: string;
  weekend_behavior: string;
  vacation_mode: boolean;
  reminder_escalation_mode: string;
}

const DEFAULTS: NotificationSettings = {
  attention_budget: 'balanced',
  push_frequency: 'normal',
  daily_brief_time: '08:00',
  weekend_behavior: 'reduced',
  vacation_mode: false,
  reminder_escalation_mode: 'notify_once',
};

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

function OptionPicker({ options, selected, onSelect }: { options: OptionDef[]; selected: string; onSelect: (v: string) => void }) {
  return (
    <View>
      {options.map((opt) => (
        <TouchableOpacity key={opt.value} style={pickerStyles.row} onPress={() => onSelect(opt.value)}>
          <Ionicons
            name={selected === opt.value ? 'checkmark-circle' : 'ellipse-outline'}
            size={20}
            color={selected === opt.value ? '#075E54' : '#CCCCCC'}
          />
          <View style={pickerStyles.textWrap}>
            <Text style={pickerStyles.label}>{opt.label}</Text>
            <Text style={pickerStyles.description}>{opt.description}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  textWrap: { marginLeft: 12, flex: 1 },
  label: { fontSize: 15, color: '#111111' },
  description: { fontSize: 12, color: '#667781', marginTop: 1 },
});

export default function NotificationsAttentionScreen() {
  const router = useRouter();
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<NotificationSettings>(DEFAULTS);
  const [current, setCurrent] = useState<NotificationSettings>(DEFAULTS);
  const [showBriefTimePicker, setShowBriefTimePicker] = useState(false);

  const dirty = JSON.stringify(current) !== JSON.stringify(saved);

  const loadSettings = async () => {
    try {
      const token = await authService.getAccessToken();
      const res = await fetch(`${backendUrl}/api/organisations/settings`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const n = data?.settings?.notifications;
      if (n) {
        const merged = { ...DEFAULTS, ...n };
        setSaved(merged);
        setCurrent(merged);
      }
    } catch (err) {
      console.error('[NotificationsAttention] load error:', err);
      Alert.alert('Error', 'Could not load your current settings. Showing defaults.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSettings(); }, []);

  const handleDiscard = () => setCurrent(saved);

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = await authService.getAccessToken();
      const res = await fetch(`${backendUrl}/api/organisations/settings`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: current }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Save failed');
      }
      const data = await res.json();
      const n = data?.settings?.notifications;
      if (n) {
        const merged = { ...DEFAULTS, ...n };
        setSaved(merged);
        setCurrent(merged);
      }
    } catch (err) {
      console.error('[NotificationsAttention] save error:', err);
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
        <Text style={styles.headerTitle}>Notifications & Attention</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      ) : (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          <Text style={styles.sectionLabel}>ATTENTION BUDGET</Text>
          <OptionPicker
            options={ATTENTION_BUDGET_OPTIONS}
            selected={current.attention_budget}
            onSelect={(v) => setCurrent({ ...current, attention_budget: v })}
          />

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>PUSH FREQUENCY</Text>
          <OptionPicker
            options={PUSH_FREQUENCY_OPTIONS}
            selected={current.push_frequency}
            onSelect={(v) => setCurrent({ ...current, push_frequency: v })}
          />

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>DAILY BRIEF TIME</Text>
          <TouchableOpacity style={styles.fieldRow} onPress={() => setShowBriefTimePicker(true)}>
            <Ionicons name="time-outline" size={22} color="#075E54" />
            <Text style={styles.fieldLabel}>Send daily brief at</Text>
            <View style={styles.fieldValue}>
              <Text style={styles.fieldValueText}>{formatDisplay(timeStringToDate(current.daily_brief_time))}</Text>
              <Ionicons name="chevron-down" size={18} color="#666" />
            </View>
          </TouchableOpacity>
          {showBriefTimePicker && (
            <DateTimePicker
              value={timeStringToDate(current.daily_brief_time)}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event: any, date?: Date) => {
                if (Platform.OS === 'android') setShowBriefTimePicker(false);
                if (date) setCurrent({ ...current, daily_brief_time: dateToTimeString(date) });
              }}
              themeVariant="light"
            />
          )}

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>WEEKEND BEHAVIOR</Text>
          <OptionPicker
            options={WEEKEND_BEHAVIOR_OPTIONS}
            selected={current.weekend_behavior}
            onSelect={(v) => setCurrent({ ...current, weekend_behavior: v })}
          />

          <View style={styles.divider} />
          <View style={styles.switchRow}>
            <Ionicons name="airplane-outline" size={22} color="#075E54" />
            <View style={styles.switchTextWrap}>
              <Text style={styles.fieldLabel}>Vacation Mode</Text>
              <Text style={styles.switchDescription}>
                {current.vacation_mode
                  ? "Saved -- will pause pushes once notification routing is built. Nothing changes yet."
                  : 'Off'}
              </Text>
            </View>
            <Switch
              value={current.vacation_mode}
              onValueChange={(v) => setCurrent({ ...current, vacation_mode: v })}
              trackColor={{ false: '#CCCCCC', true: '#25D366' }}
              thumbColor="#FFFFFF"
            />
          </View>

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>REMINDER ESCALATION</Text>
          <OptionPicker
            options={REMINDER_ESCALATION_OPTIONS}
            selected={current.reminder_escalation_mode}
            onSelect={(v) => setCurrent({ ...current, reminder_escalation_mode: v })}
          />
        </ScrollView>
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
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '600', color: '#FFFFFF', marginLeft: 8 },
  headerSpacer: { width: 40 },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingBottom: 32 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#667781', letterSpacing: 0.5, marginBottom: 8 },
  divider: { height: 1, backgroundColor: '#F0F0F0', marginVertical: 16 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  fieldLabel: { fontSize: 15, color: '#111111', marginLeft: 12, flex: 1 },
  fieldValue: { flexDirection: 'row', alignItems: 'center' },
  fieldValueText: { fontSize: 15, color: '#075E54', fontWeight: '600', marginRight: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center' },
  switchTextWrap: { flex: 1, marginLeft: 12, marginRight: 8 },
  switchDescription: { fontSize: 12, color: '#667781', marginTop: 2 },
});
