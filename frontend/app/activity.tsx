import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, RefreshControl, Modal, Pressable, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';
import SharedActivityCard from '../components/activity/SharedActivityCard';

export default function ActivityScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'mytasks'>('watchlist');
  const [items, setItems] = useState<any[]>([]);
  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => { loadData(); setSearchExpanded(false); setSearchQuery(''); }, [tab]);

  // Refetch whenever this screen regains focus -- catches returning from
  // task-detail.tsx (create or edit) without needing a manual pull-to-
  // refresh. The tab-change effect above doesn't cover this case, since
  // switching tabs is a local state change, not a navigation focus event.
  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [tab])
  );

  const loadData = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/activity?tab=${tab}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setItems(data.items || []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  };

  // Mirrors SharedActivityCard's own internal taskId derivation exactly --
  // for Watchlist items, item.id is the alert (a messages row), not a
  // task. The real task id, if one exists, is item.task_id. Alerts with
  // no task at all (e.g. bank_reconciliation, overdue_invoice) correctly
  // have nothing to open here, same as Row 2/3-dot menu already
  // conditionally hiding themselves for those same cases.
  const handleTapCard = (item: any) => {
    const taskId = tab === 'mytasks' ? item.id : item.task_id;
    if (!taskId) return;
    router.push({ pathname: '/task-detail', params: { task_id: taskId } });
  };

  const renderItem = ({ item }: { item: any }) => (
    <SharedActivityCard item={item} source={tab} onRefresh={loadData} onTapCard={handleTapCard} />
  );

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      {/* Header -- WhatsApp-style expand-in-place search. Tapping the
          search icon (My Tasks only) replaces the title with an inline
          input; the back arrow becomes "close search" instead of leaving
          the screen while search is active. */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => { if (searchExpanded) { setSearchExpanded(false); setSearchQuery(''); } else { router.back(); } }}
          style={s.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        {searchExpanded ? (
          <TextInput
            style={s.headerSearchInput}
            placeholder="Search reminders..."
            placeholderTextColor="rgba(255,255,255,0.7)"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
        ) : (
          <>
            <Text style={s.headerTitle}>Activity Center</Text>
            <View style={{ flex: 1 }} />
          </>
        )}
        {!searchExpanded && tab === 'mytasks' && items.length > 0 && (
          <TouchableOpacity onPress={() => setSearchExpanded(true)} style={s.backBtn}>
            <Ionicons name="search" size={22} color="#FFF" />
          </TouchableOpacity>
        )}
        {!searchExpanded && (
          <TouchableOpacity onPress={() => setHeaderMenuVisible(true)} style={s.backBtn}>
            <Ionicons name="ellipsis-vertical" size={22} color="#FFF" />
          </TouchableOpacity>
        )}
      </View>

      {/* Header 3-dot menu (Batch C.16) -- same centered-popup pattern as
          SharedActivityCard's own menus, for consistency. Object-form
          navigation matches the proven convention already used in
          login.tsx and chat/[customer_id].tsx -- not a literal query
          string, which has zero precedent in this app. */}
      <Modal visible={headerMenuVisible} transparent animationType="fade" onRequestClose={() => setHeaderMenuVisible(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setHeaderMenuVisible(false)}>
          <View style={s.menuBox}>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { setHeaderMenuVisible(false); router.push({ pathname: '/activity-filtered', params: { view: 'archived' } }); }}
            >
              <Ionicons name="archive-outline" size={20} color="#075E54" />
              <Text style={s.menuItemText}>Archived Reminders</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => { setHeaderMenuVisible(false); router.push({ pathname: '/activity-filtered', params: { view: 'snoozed' } }); }}
            >
              <Ionicons name="time-outline" size={20} color="#075E54" />
              <Text style={s.menuItemText}>Snoozed Reminders</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Tabs */}
      <View style={s.tabBar}>
        <TouchableOpacity style={[s.tab, tab === 'watchlist' && s.tabActive]} onPress={() => { setTab('watchlist'); setLoading(true); }}>
          <Ionicons name="eye-outline" size={18} color={tab === 'watchlist' ? '#075E54' : '#999'} />
          <Text style={[s.tabText, tab === 'watchlist' && s.tabTextActive]}>Watchlist</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'mytasks' && s.tabActive]} onPress={() => { setTab('mytasks'); setLoading(true); }}>
          <Ionicons name="checkbox-outline" size={18} color={tab === 'mytasks' ? '#075E54' : '#999'} />
          <Text style={[s.tabText, tab === 'mytasks' && s.tabTextActive]}>My Tasks</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
      ) : items.length === 0 ? (
        <View style={s.center}>
          <Ionicons name={tab === 'watchlist' ? 'notifications-off-outline' : 'checkmark-done-circle-outline'} size={48} color="#CCC" />
          <Text style={s.emptyText}>{tab === 'watchlist' ? 'No alerts in the last 7 days' : 'No tasks yet'}</Text>
        </View>
      ) : (
        <FlatList
          data={tab === 'mytasks' && searchQuery.trim()
            ? items.filter(i => (i.title || '').toLowerCase().includes(searchQuery.toLowerCase()))
            : items}
          renderItem={renderItem}
          keyExtractor={item => item.id}
          contentContainerStyle={s.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} />}
        />
      )}

      {/* Batch C.9 -- 4th way to create a reminder (alongside Spark,
          Customer AI, Org AI). My Tasks only -- Watchlist is exclusively
          system-generated, creating a task there wouldn't make sense. */}
      {tab === 'mytasks' && (
        <TouchableOpacity style={s.fab} onPress={() => router.push('/task-detail')}>
          <Ionicons name="add" size={28} color="#FFFFFF" />
        </TouchableOpacity>
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
  tabBar: { flexDirection: 'row', backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#075E54' },
  tabText: { fontSize: 14, color: '#999', fontWeight: '500' },
  tabTextActive: { color: '#075E54', fontWeight: '700' },
  listContent: { padding: 12 },
  emptyText: { fontSize: 15, color: '#999' },
  fab: {
    position: 'absolute', right: 16, bottom: 90, width: 56, height: 56,
    backgroundColor: '#075E54', borderRadius: 28, justifyContent: 'center', alignItems: 'center',
    elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4,
  },
  headerSearchInput: {
    flex: 1, fontSize: 17, color: '#FFF', paddingVertical: 4,
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 95, paddingRight: 12 },
  menuBox: { backgroundColor: '#FFF', borderRadius: 12, paddingVertical: 6, minWidth: 200, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14, gap: 12 },
  menuItemText: { fontSize: 15, color: '#333' },
});
