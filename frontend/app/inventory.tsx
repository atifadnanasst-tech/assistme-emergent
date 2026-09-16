import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';

// Sept 2026 -- inventory module Phase 2 ("See Inventory" screen),
// designed with Atif ahead of building (a demo-morning session), built
// after the demo once time allowed for it to be done properly rather
// than rushed. Entry point: Home -> Products -> 3-dot menu -> See
// Inventory. This list screen is the first of two -- tapping a product
// opens app/inventory/[productId].tsx, the per-product movement
// history tied back to source documents.
//
// Deliberately sorted lowest-stock-first by default, not alphabetically
// like the main catalog grid -- this screen exists specifically to
// answer "what's running low," which is the actionable question a
// trader opening this screen actually has, unlike browsing the full
// catalog.

interface InventoryProduct {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: number | null;
}

export default function InventoryListScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<InventoryProduct[]>([]);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  const loadInventory = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/products/list`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      const tracked = (data.products || []).filter((p: InventoryProduct) => p.quantity !== null);
      tracked.sort((a: InventoryProduct, b: InventoryProduct) => (a.quantity ?? 0) - (b.quantity ?? 0));
      setProducts(tracked);
    } catch {
      // fail quiet -- an empty list with a retry-by-reopening is safer
      // than a crash on this read-only screen
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadInventory(); }, [loadInventory]);

  const renderItem = ({ item }: { item: InventoryProduct }) => {
    const qty = item.quantity ?? 0;
    const isLow = qty <= 0;
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() => router.push(`/inventory/${item.id}`)}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.rowName}>{item.name}</Text>
          {item.sku ? <Text style={styles.rowSku}>{item.sku}</Text> : null}
        </View>
        <View style={styles.qtyBlock}>
          <Text style={[styles.qtyText, isLow && styles.qtyTextLow]}>
            {qty} {item.unit}
          </Text>
          {isLow && <Text style={styles.lowBadge}>LOW</Text>}
        </View>
        <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Inventory</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#075E54" style={{ marginTop: 40 }} />
      ) : products.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="cube-outline" size={48} color="#CCCCCC" />
          <Text style={styles.emptyText}>No tracked products yet</Text>
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 20 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#075E54', paddingHorizontal: 16, paddingVertical: 14,
  },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#F0F0F0',
  },
  rowName: { fontSize: 15, fontWeight: '600', color: '#222' },
  rowSku: { fontSize: 12, color: '#999', marginTop: 2 },
  qtyBlock: { alignItems: 'flex-end', marginRight: 8 },
  qtyText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  qtyTextLow: { color: '#D32F2F' },
  lowBadge: {
    fontSize: 9, fontWeight: '700', color: '#FFFFFF', backgroundColor: '#D32F2F',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 3,
  },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { color: '#999', fontSize: 14 },
});
