import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { authService } from '../../lib/auth';

// Sept 2026 -- inventory module Phase 2, second screen. Opened by
// tapping a product on the inventory list screen (app/inventory.tsx).
// Shows the real movement history from inventory_transactions, each
// row already resolved by the backend to its real source document
// (invoice number, purchase bill number, or "Manual entry") -- no
// document-resolution logic duplicated here, the backend route does
// all of that once, correctly.

interface HistoryEntry {
  id: string;
  type: 'in' | 'out';
  quantity: number;
  document_label: string;
  notes: string | null;
  actor_name: string | null;
  created_at: string;
}

interface InventoryDetail {
  product: { id: string; name: string; unit: string };
  current_quantity: number | null;
  history: HistoryEntry[];
}

export default function ProductInventoryDetailScreen() {
  const router = useRouter();
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<InventoryDetail | null>(null);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  const loadDetail = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token || !productId) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/products/${productId}/inventory`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setDetail(data);
      }
    } catch {
      // fail quiet -- read-only screen, retry by reopening
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const formatDate = (iso: string) => new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const renderItem = ({ item }: { item: HistoryEntry }) => (
    <View style={styles.historyRow}>
      <View style={[styles.directionDot, item.type === 'in' ? styles.dotIn : styles.dotOut]}>
        <Ionicons name={item.type === 'in' ? 'arrow-down' : 'arrow-up'} size={14} color="#FFFFFF" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.historyDoc}>{item.document_label}</Text>
        <Text style={styles.historyMeta}>
          {formatDate(item.created_at)}{item.actor_name ? ` · ${item.actor_name}` : ''}
        </Text>
        {item.notes ? <Text style={styles.historyNotes}>{item.notes}</Text> : null}
      </View>
      <Text style={[styles.historyQty, item.type === 'in' ? styles.qtyIn : styles.qtyOut]}>
        {item.type === 'in' ? '+' : '-'}{item.quantity}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{detail?.product?.name || 'Inventory'}</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#075E54" style={{ marginTop: 40 }} />
      ) : !detail ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>Could not load inventory history.</Text>
        </View>
      ) : (
        <>
          <View style={styles.currentBlock}>
            <Text style={styles.currentLabel}>Current Stock</Text>
            <Text style={styles.currentValue}>
              {detail.current_quantity ?? 0} {detail.product.unit}
            </Text>
          </View>

          {detail.history.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="time-outline" size={40} color="#CCCCCC" />
              <Text style={styles.emptyText}>No movement history yet</Text>
            </View>
          ) : (
            <FlatList
              data={detail.history}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              contentContainerStyle={{ paddingBottom: 20 }}
            />
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#075E54', paddingHorizontal: 16, paddingVertical: 14, gap: 12,
  },
  headerTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center' },
  currentBlock: {
    alignItems: 'center', paddingVertical: 18, backgroundColor: '#F0F7F5',
    borderBottomWidth: 1, borderBottomColor: '#E0E0E0',
  },
  currentLabel: { fontSize: 12, color: '#888', textTransform: 'uppercase' },
  currentValue: { fontSize: 26, fontWeight: '800', color: '#075E54', marginTop: 2 },
  historyRow: {
    flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#F5F5F5', gap: 12,
  },
  directionDot: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  dotIn: { backgroundColor: '#2E7D32' },
  dotOut: { backgroundColor: '#D32F2F' },
  historyDoc: { fontSize: 14, fontWeight: '600', color: '#222' },
  historyMeta: { fontSize: 12, color: '#999', marginTop: 2 },
  historyNotes: { fontSize: 12, color: '#666', marginTop: 3, fontStyle: 'italic' },
  historyQty: { fontSize: 15, fontWeight: '700' },
  qtyIn: { color: '#2E7D32' },
  qtyOut: { color: '#D32F2F' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { color: '#999', fontSize: 14 },
});
