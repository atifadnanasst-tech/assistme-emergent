import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../lib/auth';

// Dashboard — Home Menu Audit, Tier 1. Reuses getFinancialPosition() via
// GET /api/dashboard for You'll Get / You'll Give. Sales trend rendered as
// proportional bars (View width%), mirroring VisualizationCard's existing
// pattern -- no react-native-svg dependency. A real line/curve chart is
// noted as a backlog upgrade (Home Menu Audit doc) once svg is added.
// Tier 2 (downloadable Sales/Purchases/BalSheet/P&L reports) is NOT here
// -- separate scoped session.

interface SalesTrendPoint {
  month: string;
  label: string;
  total: number;
}
interface DashboardData {
  position: {
    totalReceivables?: number;
    totalPayables?: number;
  } | null;
  expensesThisMonth: number;
  salesTrend: SalesTrendPoint[];
  pctChangeVsPriorMonth: number;
}

const BAR_MAX_HEIGHT = 120;

export default function Dashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      const token = await authService.getAccessToken();
      if (!token) {
        router.back();
        return;
      }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error('Load dashboard error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    fetchDashboard(false);
  }, [fetchDashboard]);

  const formatCurrency = (n: number | undefined) => {
    const val = n || 0;
    return `₹${val.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  };

  const maxTrend = data ? Math.max(1, ...data.salesTrend.map(p => p.total)) : 1;
  const pctChange = data?.pctChangeVsPriorMonth ?? 0;
  const isDecline = pctChange < 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Dashboard</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      ) : (
        <ScrollView
          style={styles.body}
          contentContainerStyle={{ padding: 12, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetchDashboard(true)} />
          }
        >
          {/* You'll Get / You'll Give */}
          <View style={styles.rowCards}>
            <View style={[styles.halfCard, styles.getCard]}>
              <View style={styles.cardIconRow}>
                <Ionicons name="arrow-down-circle" size={18} color="#2E7D32" />
                <Text style={styles.cardLabel}>You'll Get</Text>
              </View>
              <Text style={[styles.cardAmount, { color: '#2E7D32' }]}>
                {formatCurrency(data?.position?.totalReceivables)}
              </Text>
            </View>
            <View style={[styles.halfCard, styles.giveCard]}>
              <View style={styles.cardIconRow}>
                <Ionicons name="arrow-up-circle" size={18} color="#C62828" />
                <Text style={styles.cardLabel}>You'll Give</Text>
              </View>
              <Text style={[styles.cardAmount, { color: '#C62828' }]}>
                {formatCurrency(data?.position?.totalPayables)}
              </Text>
            </View>
          </View>

          {/* Sale Overview */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              Your Sale Overview ({data?.salesTrend?.[data.salesTrend.length - 1]?.label || ''})
            </Text>
            <Text style={styles.bigAmount}>
              {formatCurrency(data?.salesTrend?.[data.salesTrend.length - 1]?.total)}
            </Text>
            <View style={styles.changeRow}>
              <Ionicons
                name={isDecline ? 'arrow-down' : 'arrow-up'}
                size={14}
                color={isDecline ? '#C62828' : '#2E7D32'}
              />
              <Text style={[styles.changeText, { color: isDecline ? '#C62828' : '#2E7D32' }]}>
                {Math.abs(pctChange)}% {isDecline ? 'decline' : 'growth'} this month
              </Text>
            </View>

            {/* Bar chart — proportional Views, no svg dependency (see file header) */}
            <View style={styles.barChartRow}>
              {(data?.salesTrend || []).map((point) => {
                const barHeight = Math.max(4, (point.total / maxTrend) * BAR_MAX_HEIGHT);
                return (
                  <View key={point.month} style={styles.barColumn}>
                    <View style={styles.barTrackVertical}>
                      <View style={[styles.barFillVertical, { height: barHeight }]} />
                    </View>
                    <Text style={styles.barLabel}>{point.label}</Text>
                  </View>
                );
              })}
            </View>
          </View>

          {/* Expenses */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Expenses (this month)</Text>
            <Text style={styles.bigAmount}>{formatCurrency(data?.expensesThisMonth)}</Text>
          </View>

          {/* Tier 2 placeholder — deliberately not built yet */}
          <View style={[styles.card, styles.comingSoonCard]}>
            <Text style={styles.cardTitle}>Reports</Text>
            <Text style={styles.tier2Text}>
              Downloadable Sales, Purchases, Balance Sheet, and Profit & Loss reports are coming soon.
            </Text>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backBtn: { marginRight: 12 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  body: { flex: 1 },
  rowCards: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  halfCard: {
    flex: 1,
    borderRadius: 12,
    padding: 14,
    backgroundColor: '#FFFFFF',
  },
  getCard: {},
  giveCard: {},
  cardIconRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  cardLabel: { fontSize: 13, color: '#666', marginLeft: 6 },
  cardAmount: { fontSize: 20, fontWeight: '700' },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 8 },
  bigAmount: { fontSize: 24, fontWeight: '700', color: '#222', textAlign: 'center', marginVertical: 4 },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  changeText: { fontSize: 13, fontWeight: '600', marginLeft: 4 },
  barChartRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    height: BAR_MAX_HEIGHT + 28,
  },
  barColumn: { alignItems: 'center' },
  barTrackVertical: {
    width: 36,
    height: BAR_MAX_HEIGHT,
    justifyContent: 'flex-end',
  },
  barFillVertical: {
    width: 36,
    backgroundColor: '#075E54',
    borderRadius: 6,
  },
  barLabel: { fontSize: 12, color: '#888', marginTop: 6 },
  comingSoonCard: { opacity: 0.7 },
  tier2Text: { fontSize: 13, color: '#999', lineHeight: 19 },
});
