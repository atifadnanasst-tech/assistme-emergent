import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';
import SharedActivityCard from '../components/activity/SharedActivityCard';

// Batch C.17 -- the recoverability mini-feature's screen. Reused by both
// "Archived Reminders" and "Snoozed Reminders" (header menu, C.16) via a
// ?view= query param, exactly like activity.tsx's own watchlist/mytasks
// tab pattern. Mirrors activity.tsx's structure closely -- same header,
// loading, and empty-state conventions, for consistency.
export default function ActivityFilteredScreen() {
  const router = useRouter();
  const { view: viewParam } = useLocalSearchParams<{ view?: string }>();
  const view = viewParam === 'snoozed' ? 'snoozed'
    : viewParam === 'completed' ? 'completed' : 'archived';
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [items, setItems] = useState<any[]>([]);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => { loadData(); }, [view]);

  const loadData = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/activity?tab=mytasks&view=${view}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setItems(data.items || []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  };

  const renderItem = ({ item }: { item: any }) => (
    <SharedActivityCard item={item} source="mytasks" onRefresh={loadData} />
  );

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>
          {view === 'archived' ? 'Archived Reminders' : view === 'snoozed' ? 'Snoozed Reminders' : 'Completed Tasks'}
        </Text>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
      ) : items.length === 0 ? (
        <View style={s.center}>
          <Ionicons name={view === 'archived' ? 'archive-outline' : view === 'snoozed' ? 'time-outline' : 'checkmark-done-outline'} size={48} color="#CCC" />
          <Text style={s.emptyText}>{view === 'archived' ? 'No archived reminders' : view === 'snoozed' ? 'No snoozed reminders' : 'No completed tasks yet'}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          renderItem={renderItem}
          keyExtractor={item => item.id}
          contentContainerStyle={s.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} />}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8, gap: 8 },
  backBtn: { padding: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFF' },
  listContent: { padding: 12 },
  emptyText: { fontSize: 15, color: '#999' },
});
