import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { authService } from '../../../lib/auth';

interface ReportData {
  customer: any; summary: any; metrics: any; financial: any;
  behavior_insights: any[]; ai_analysis: any[];
}

export default function CustomerReportScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<ReportData | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [reminderSent, setReminderSent] = useState(false);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) {
      await authService.clearSession(); await supabase.auth.signOut();
      setIsAuthenticated(false); router.replace('/login'); return null;
    }
    return token;
  };

  useEffect(() => { loadReport(); }, [id]);

  const loadReport = async () => {
    try {
      const token = await getToken();
      if (!token || !id) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${backendUrl}/api/customer/${id}/report`, {
        headers: { 'Authorization': `Bearer ${token}` }, signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 401) {
        await authService.clearSession(); await supabase.auth.signOut();
        setIsAuthenticated(false); router.replace('/login'); return;
      }
      if (res.status === 404) { Alert.alert('Error', 'Customer not found'); router.back(); return; }
      const data = await res.json();
      setReport(data);
    } catch (err: any) {
      if (err.name !== 'AbortError') Alert.alert('Error', "Couldn't load report. Pull down to retry.");
    } finally { setLoading(false); setRefreshing(false); }
  };

  const loadHistory = async () => {
    if (history.length > 0) { setHistoryVisible(!historyVisible); return; }
    setHistoryLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/customer/${id}/history`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setHistory(data.transactions || []);
      setHistoryVisible(true);
    } catch {} finally { setHistoryLoading(false); }
  };

  const handleSendReminder = async () => {
    if (sendingReminder) return;
    setSendingReminder(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      await fetch(`${backendUrl}/api/chat/${id}/reminder`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: null }),
      });
      setReminderSent(true);
      setTimeout(() => setReminderSent(false), 3000);
    } catch { Alert.alert('Error', 'Failed to send reminder'); }
    finally { setSendingReminder(false); }
  };

  const fmt = (n: number | null | undefined) => {
    if (n === null || n === undefined) return '—';
    return '₹' + n.toLocaleString('en-IN');
  };
  const fmtDate = (d: string | null) => {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  if (loading) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <View style={s.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  const c = report?.customer;
  const sum = report?.summary;
  const met = report?.metrics;
  const fin = report?.financial;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadReport(); }} />}
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#333" />
          </TouchableOpacity>
          <View style={[s.avatar, { backgroundColor: c?.avatar_color || '#075E54' }]}>
            <Text style={s.avatarText}>{c?.initials || '?'}</Text>
          </View>
          <View style={s.headerInfo}>
            <Text style={s.headerTitle}>Customer Report</Text>
            <Text style={s.headerSubtitle}>{c?.name || 'Customer'}</Text>
          </View>
          <TouchableOpacity style={s.menuBtn}>
            <Ionicons name="ellipsis-vertical" size={22} color="#666" />
          </TouchableOpacity>
        </View>

        {/* Section 1: Summary Card */}
        <View style={s.card}>
          <View style={s.grid2x2}>
            <View style={s.gridItem}>
              <Text style={s.gridLabel}>LIFETIME VALUE</Text>
              <Text style={s.gridValue}>{fmt(sum?.lifetime_value)}</Text>
            </View>
            <View style={s.gridItem}>
              <Text style={s.gridLabel}>OUTSTANDING</Text>
              <Text style={[s.gridValue, { color: '#D32F2F' }]}>{fmt(c?.outstanding_balance)}</Text>
            </View>
            <View style={s.gridItem}>
              <Text style={s.gridLabel}>TOTAL ORDERS</Text>
              <Text style={s.gridValue}>{sum?.total_orders_12mo ?? 0} (12mo)</Text>
            </View>
            <View style={s.gridItem}>
              <Text style={s.gridLabel}>AVG ORDER</Text>
              <Text style={s.gridValue}>{sum?.avg_order_value !== null ? fmt(sum?.avg_order_value) : '—'}</Text>
            </View>
          </View>
        </View>

        {/* Section 2: Health Card */}
        <View style={s.card}>
          <View style={s.healthRow}>
            <View style={[s.healthIcon, { backgroundColor: c?.health_label === 'Good' ? '#E8F5E9' : c?.health_label === 'At Risk' ? '#FFEBEE' : '#FFF8E1' }]}>
              <Ionicons name="pulse" size={22} color={c?.health_label === 'Good' ? '#4CAF50' : c?.health_label === 'At Risk' ? '#D32F2F' : '#F9A825'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.healthLabel}>CUSTOMER HEALTH</Text>
              <Text style={[s.healthValue, { color: c?.health_label === 'Good' ? '#4CAF50' : c?.health_label === 'At Risk' ? '#D32F2F' : '#F9A825' }]}>
                {c?.health_label || 'Moderate'}
              </Text>
            </View>
            {c?.health_label !== 'Good' && (
              <View style={[s.alertBadge, { backgroundColor: c?.health_label === 'At Risk' ? '#FFEBEE' : '#FFF8E1' }]}>
                <View style={[s.alertDot, { backgroundColor: c?.health_label === 'At Risk' ? '#D32F2F' : '#F9A825' }]} />
                <Text style={[s.alertText, { color: c?.health_label === 'At Risk' ? '#D32F2F' : '#F9A825' }]}>ALERT</Text>
              </View>
            )}
          </View>
        </View>

        {/* Section 3: Key Metrics Grid */}
        <View style={s.metricsGrid}>
          <View style={s.metricCard}>
            <Text style={s.metricLabel}>TOTAL ORDERS</Text>
            <Text style={s.metricValue}>{met?.total_orders ?? 0}</Text>
          </View>
          <View style={s.metricCard}>
            <Text style={s.metricLabel}>PAYMENT DELAY</Text>
            <Text style={s.metricValue}>{met?.payment_delay_avg_days !== null ? `${met?.payment_delay_avg_days} days` : '—'}</Text>
            <Text style={s.metricSub}>(Avg)</Text>
          </View>
          <View style={s.metricCard}>
            <Text style={s.metricLabel}>LAST ORDER</Text>
            <Text style={s.metricValue}>{fmtDate(met?.last_order_date)}</Text>
          </View>
          <View style={s.metricCard}>
            <Text style={s.metricLabel}>ORDER FREQ</Text>
            <Text style={s.metricValue}>{met?.order_frequency_days !== null ? `${met?.order_frequency_days} days` : '—'}</Text>
          </View>
        </View>

        {/* Section 4: Financial Metrics */}
        <View style={s.card}>
          <Text style={s.sectionTitle}>Financial Metrics</Text>
          <View style={s.finRow}>
            <Text style={s.finLabel}>Total Payments Received</Text>
            <Text style={s.finValue}>{fin?.total_payments_received !== null ? fmt(fin?.total_payments_received) : '—'}</Text>
          </View>
          <View style={s.finRow}>
            <Text style={s.finLabel}>Profit Contribution</Text>
            <Text style={s.finValue}>{fin?.profit_contribution_pct !== null ? `${fin?.profit_contribution_pct}%` : '—'}</Text>
          </View>
          <View style={s.progressBarBg}>
            <View style={[s.progressBarFill, { width: `${fin?.invoice_cleared_pct || 0}%` }]} />
          </View>
          <Text style={s.progressLabel}>{fin?.invoice_cleared_pct || 0}% OF TOTAL INVOICE VALUE CLEARED</Text>
        </View>

        {/* Section 5: Behavior Insights */}
        <View style={s.card}>
          <Text style={s.sectionTitle}>Behavior Insights</Text>
          {(report?.behavior_insights?.length || 0) === 0 ? (
            <Text style={s.emptyText}>Insights will appear as you interact with this customer</Text>
          ) : (
            report?.behavior_insights?.map((insight, i) => (
              <View key={i} style={s.insightRow}>
                <Ionicons name={
                  insight.memory_key?.includes('order') ? 'cube-outline' :
                  insight.memory_key?.includes('pay') ? 'cash-outline' :
                  insight.memory_key?.includes('prefer') ? 'heart-outline' : 'checkmark-circle-outline'
                } size={18} color="#075E54" />
                <Text style={s.insightText}>
                  {insight.memory_key === 'order_frequency_days' ? `Usually orders every ${insight.memory_value} days` :
                   insight.memory_key === 'payment_days' ? `Pays within ${insight.memory_value} days` :
                   insight.memory_key === 'preferred_product' ? `Prefers ${insight.memory_value}` :
                   insight.memory_key === 'customer_tier' ? `${insight.memory_value} customer` :
                   `${insight.memory_key}: ${insight.memory_value}`}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Section 6: AI Smart Analysis */}
        <View style={s.aiCard}>
          <View style={s.aiHeader}>
            <Ionicons name="sparkles" size={18} color="#FFF" />
            <Text style={s.aiHeaderText}>AI SMART ANALYSIS</Text>
          </View>
          {(report?.ai_analysis?.length || 0) === 0 ? (
            <Text style={s.aiEmptyText}>Not enough data for analysis yet</Text>
          ) : (
            report?.ai_analysis?.map((insight, i) => (
              <View key={i} style={[s.aiBlock, insight.highlight && s.aiBlockHighlight]}>
                <Text style={[s.aiBlockText, insight.highlight && s.aiBlockTextHighlight]}>{insight.text}</Text>
              </View>
            ))
          )}
        </View>

        {/* History (inline expandable) */}
        {historyVisible && history.length > 0 && (
          <View style={s.card}>
            <Text style={s.sectionTitle}>Transaction History</Text>
            {history.map((tx, i) => (
              <View key={i} style={s.historyRow}>
                <Ionicons name={tx.type === 'invoice' ? 'receipt-outline' : 'cash-outline'} size={18} color="#666" />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={s.historyTitle}>Invoice #{tx.invoice_number || '—'}</Text>
                  <Text style={s.historySub}>{fmtDate(tx.date)} · {tx.status}</Text>
                </View>
                <Text style={s.historyAmount}>{fmt(tx.amount)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomBarSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity
            style={[s.actionBtn, s.actionBtnPrimary]}
            onPress={handleSendReminder}
            disabled={sendingReminder}
          >
            {sendingReminder ? <ActivityIndicator size="small" color="#FFF" /> :
             reminderSent ? <Text style={s.actionBtnTextPrimary}>Reminder Sent ✓</Text> :
             <>
               <Ionicons name="notifications" size={18} color="#FFF" />
               <Text style={s.actionBtnTextPrimary}>Send Reminder</Text>
             </>
            }
          </TouchableOpacity>
          <TouchableOpacity style={s.actionBtn} onPress={() => router.push(`/customer/${id}/invoice`)}>
            <Ionicons name="document-text-outline" size={18} color="#333" />
            <Text style={s.actionBtnText}>Create Invoice</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionBtn} onPress={loadHistory} disabled={historyLoading}>
            {historyLoading ? <ActivityIndicator size="small" color="#333" /> :
             <>
               <Ionicons name="time-outline" size={18} color="#333" />
               <Text style={s.actionBtnText}>View History</Text>
             </>
            }
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16 },

  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 },
  backBtn: { padding: 4 },
  avatar: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  headerInfo: { flex: 1 },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#075E54' },
  headerSubtitle: { fontSize: 14, color: '#666' },
  menuBtn: { padding: 4 },

  card: { backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginBottom: 12, elevation: 1 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#1A1A1A', marginBottom: 12 },

  grid2x2: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { width: '50%', paddingVertical: 8 },
  gridLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5 },
  gridValue: { fontSize: 22, fontWeight: '700', color: '#1A1A1A', marginTop: 2 },

  healthRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  healthIcon: { width: 44, height: 44, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  healthLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5 },
  healthValue: { fontSize: 18, fontWeight: '700' },
  alertBadge: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, gap: 6 },
  alertDot: { width: 8, height: 8, borderRadius: 4 },
  alertText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  metricCard: { width: '48%', backgroundColor: '#FFF', borderRadius: 12, padding: 14, elevation: 1 },
  metricLabel: { fontSize: 10, fontWeight: '600', color: '#999', letterSpacing: 0.5 },
  metricValue: { fontSize: 20, fontWeight: '700', color: '#1A1A1A', marginTop: 4 },
  metricSub: { fontSize: 12, color: '#999' },

  finRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  finLabel: { fontSize: 14, color: '#666' },
  finValue: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  progressBarBg: { height: 6, backgroundColor: '#E0E0E0', borderRadius: 3, marginTop: 12 },
  progressBarFill: { height: 6, backgroundColor: '#075E54', borderRadius: 3 },
  progressLabel: { fontSize: 11, color: '#999', marginTop: 4, letterSpacing: 0.3 },

  insightRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  insightText: { fontSize: 14, color: '#333', flex: 1 },
  emptyText: { fontSize: 14, color: '#999', fontStyle: 'italic' },

  aiCard: { backgroundColor: '#3E2723', borderRadius: 16, padding: 16, marginBottom: 12 },
  aiHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  aiHeaderText: { fontSize: 13, fontWeight: '700', color: '#FFF', letterSpacing: 1 },
  aiBlock: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 10, padding: 12, marginBottom: 8 },
  aiBlockHighlight: { backgroundColor: 'rgba(76,175,80,0.25)', borderWidth: 1, borderColor: 'rgba(76,175,80,0.5)' },
  aiBlockText: { fontSize: 14, color: '#FFFFFFCC', lineHeight: 20 },
  aiBlockTextHighlight: { color: '#A5D6A7', fontWeight: '600' },
  aiEmptyText: { fontSize: 14, color: '#FFFFFF88', fontStyle: 'italic' },

  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: '#F0F0F0' },
  historyTitle: { fontSize: 14, fontWeight: '600', color: '#333' },
  historySub: { fontSize: 12, color: '#999' },
  historyAmount: { fontSize: 15, fontWeight: '700', color: '#1A1A1A' },

  bottomBarSafe: { backgroundColor: '#FFF' },
  bottomBar: { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12, backgroundColor: '#F5F5F5' },
  actionBtnPrimary: { backgroundColor: '#075E54' },
  actionBtnText: { fontSize: 12, fontWeight: '600', color: '#333' },
  actionBtnTextPrimary: { fontSize: 12, fontWeight: '600', color: '#FFF' },
});
