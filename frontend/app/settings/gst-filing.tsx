// GST Filing Report screen (Aug 2026, dedicated session).
// Entry: Home -> Tools -> "GST Filing Report" (next to "Export my data").
//
// Reuses established patterns rather than inventing new ones:
// - DateTimePicker for Custom range, same pattern as
//   settings/business-preferences/hours.tsx
// - Download/share flow (idempotent File.downloadFileAsync + Sharing),
//   same pattern as settings/export.tsx, including its documented
//   idempotent:true fix for repeat-download DestinationAlreadyExists.
//
// Quarter boundaries follow the Indian financial year (Apr-Mar), NOT
// calendar quarters -- Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar.
// Verified against 5 reference dates including FY-rollover edge cases
// before writing this UI.

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { authService } from '../../lib/auth';

type PeriodMode = 'month' | 'quarter' | 'custom';

function toISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function getMonthBounds(refDate: Date) {
  const start = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
  const end = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0);
  const label = start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

function getFYQuarterBounds(refDate: Date) {
  const month = refDate.getMonth();
  const year = refDate.getFullYear();
  const fyStartYear = month >= 3 ? year : year - 1;
  const quarterIndex = Math.floor(((month - 3 + 12) % 12) / 3);
  const quarterStartMonth = (3 + quarterIndex * 3) % 12;
  const quarterStartYear = quarterStartMonth >= 3 ? fyStartYear : fyStartYear + 1;
  const start = new Date(quarterStartYear, quarterStartMonth, 1);
  const end = new Date(quarterStartYear, quarterStartMonth + 3, 0);
  const fyLabel = `FY ${fyStartYear}-${(fyStartYear + 1).toString().slice(-2)}`;
  const label = `Q${quarterIndex + 1} ${fyLabel} (${start.toLocaleDateString('en-IN', { month: 'short' })}-${end.toLocaleDateString('en-IN', { month: 'short' })})`;
  return { start, end, label };
}

interface FilingRecord {
  id: string;
  period_type: string;
  period_start: string;
  period_end: string;
  invoice_count: number;
  created_at: string;
}

export default function GstFilingReportScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<PeriodMode>('month');
  const [refDate, setRefDate] = useState(new Date());
  const [customStart, setCustomStart] = useState(new Date());
  const [customEnd, setCustomEnd] = useState(new Date());
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const [history, setHistory] = useState<FilingRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

  const getToken = useCallback(async () => {
    const token = await authService.getAccessToken();
    if (!token) {
      router.back();
      return null;
    }
    return token;
  }, [router]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${backendUrl}/api/gst-filing/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setHistory(json.filings || []);
      }
    } catch {
      // Silent -- history is a nice-to-have, not blocking the generate flow.
    } finally {
      setLoadingHistory(false);
    }
  }, [getToken, backendUrl]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const monthOffset = (delta: number) => {
    setRefDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  const currentBounds = mode === 'month' ? getMonthBounds(refDate)
    : mode === 'quarter' ? getFYQuarterBounds(refDate)
    : { start: customStart, end: customEnd, label: 'Custom Range' };

  const downloadFiling = async (auditId: string, periodStart: string, periodEnd: string) => {
    setDownloading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${backendUrl}/api/gst-filing/${auditId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        Alert.alert('Download failed', 'Could not prepare your download link. Please try again.');
        return;
      }
      const json = await res.json();
      if (!json.url) {
        Alert.alert('Download failed', 'Could not prepare your download link. Please try again.');
        return;
      }
      const destination = new Directory(Paths.cache, 'gst-filings');
      destination.create({ intermediates: true, idempotent: true });
      const localFile = await File.downloadFileAsync(json.url, destination, { idempotent: true });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(localFile.uri, {
          mimeType: 'text/csv',
          dialogTitle: `GST Filing Report (${periodStart} to ${periodEnd})`,
        });
      } else {
        Alert.alert('Downloaded', `Saved to: ${localFile.uri}`);
      }
    } catch (err) {
      console.error('GST filing download error:', err);
      Alert.alert('Download failed', 'Could not download the report. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const token = await getToken();
      if (!token) return;
      const periodStart = toISODate(currentBounds.start);
      const periodEnd = toISODate(currentBounds.end);
      const res = await fetch(`${backendUrl}/api/gst-filing/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_type: mode, period_start: periodStart, period_end: periodEnd }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Generation failed', err.message || 'Could not generate the report. Please try again.');
        return;
      }
      const json = await res.json();
      await loadHistory();
      await downloadFiling(json.auditId, periodStart, periodEnd);
    } catch (err) {
      console.error('GST filing generate error:', err);
      Alert.alert('Generation failed', 'Could not generate the report. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>GST Filing Report</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>SELECT PERIOD</Text>
        <View style={styles.modeRow}>
          {(['month', 'quarter', 'custom'] as PeriodMode[]).map(m => (
            <TouchableOpacity
              key={m}
              style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
              onPress={() => setMode(m)}
            >
              <Text style={[styles.modeBtnText, mode === m && styles.modeBtnTextActive]}>
                {m === 'month' ? 'Month' : m === 'quarter' ? 'Quarter' : 'Custom'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {mode === 'month' && (
          <View style={styles.stepperRow}>
            <TouchableOpacity onPress={() => monthOffset(-1)} style={styles.stepperArrow}>
              <Ionicons name="chevron-back" size={22} color="#075E54" />
            </TouchableOpacity>
            <Text style={styles.stepperLabel}>{getMonthBounds(refDate).label}</Text>
            <TouchableOpacity onPress={() => monthOffset(1)} style={styles.stepperArrow}>
              <Ionicons name="chevron-forward" size={22} color="#075E54" />
            </TouchableOpacity>
          </View>
        )}

        {mode === 'quarter' && (
          <View style={styles.stepperRow}>
            <TouchableOpacity onPress={() => monthOffset(-3)} style={styles.stepperArrow}>
              <Ionicons name="chevron-back" size={22} color="#075E54" />
            </TouchableOpacity>
            <Text style={styles.stepperLabel}>{getFYQuarterBounds(refDate).label}</Text>
            <TouchableOpacity onPress={() => monthOffset(3)} style={styles.stepperArrow}>
              <Ionicons name="chevron-forward" size={22} color="#075E54" />
            </TouchableOpacity>
          </View>
        )}

        {mode === 'custom' && (
          <View>
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>From</Text>
              <TouchableOpacity style={styles.fieldValue} onPress={() => setShowStartPicker(true)}>
                <Text style={styles.fieldValueText}>{customStart.toLocaleDateString('en-IN')}</Text>
                <Ionicons name="chevron-down" size={18} color="#666" />
              </TouchableOpacity>
            </View>
            {showStartPicker && (
              <DateTimePicker
                value={customStart}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={(event: any, date?: Date) => {
                  if (Platform.OS === 'android') setShowStartPicker(false);
                  if (date) setCustomStart(date);
                }}
                themeVariant="light"
              />
            )}
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>To</Text>
              <TouchableOpacity style={styles.fieldValue} onPress={() => setShowEndPicker(true)}>
                <Text style={styles.fieldValueText}>{customEnd.toLocaleDateString('en-IN')}</Text>
                <Ionicons name="chevron-down" size={18} color="#666" />
              </TouchableOpacity>
            </View>
            {showEndPicker && (
              <DateTimePicker
                value={customEnd}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={(event: any, date?: Date) => {
                  if (Platform.OS === 'android') setShowEndPicker(false);
                  if (date) setCustomEnd(date);
                }}
                themeVariant="light"
              />
            )}
          </View>
        )}

        <TouchableOpacity
          style={[styles.generateBtn, (generating || downloading) && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          disabled={generating || downloading}
        >
          {generating || downloading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.generateBtnText}>Generate Report</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>PAST FILINGS</Text>
        {loadingHistory ? (
          <ActivityIndicator color="#075E54" style={{ marginTop: 12 }} />
        ) : history.length === 0 ? (
          <Text style={styles.emptyText}>No filings generated yet.</Text>
        ) : (
          history.map(f => (
            <TouchableOpacity
              key={f.id}
              style={styles.historyRow}
              onPress={() => downloadFiling(f.id, f.period_start, f.period_end)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.historyPeriod}>{f.period_start} to {f.period_end}</Text>
                <Text style={styles.historyMeta}>{f.invoice_count} invoices · {new Date(f.created_at).toLocaleDateString('en-IN')}</Text>
              </View>
              <Ionicons name="download-outline" size={20} color="#075E54" />
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingHorizontal: 12, paddingVertical: 14 },
  headerBtn: { padding: 4, marginRight: 8 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  content: { padding: 16, paddingBottom: 40 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#888', marginTop: 20, marginBottom: 10, letterSpacing: 0.5 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#075E54', alignItems: 'center' },
  modeBtnActive: { backgroundColor: '#075E54' },
  modeBtnText: { color: '#075E54', fontWeight: '600' },
  modeBtnTextActive: { color: '#FFF' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, paddingVertical: 8 },
  stepperArrow: { padding: 8 },
  stepperLabel: { fontSize: 16, fontWeight: '600', color: '#333' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  fieldLabel: { fontSize: 14, color: '#333', fontWeight: '500' },
  fieldValue: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fieldValueText: { fontSize: 14, color: '#075E54' },
  generateBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 28 },
  generateBtnDisabled: { opacity: 0.6 },
  generateBtnText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  emptyText: { color: '#999', fontSize: 14, marginTop: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  historyPeriod: { fontSize: 14, fontWeight: '600', color: '#333' },
  historyMeta: { fontSize: 12, color: '#888', marginTop: 2 },
});
