import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, Alert, Linking, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';

export default function ActivityScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'mytasks'>('watchlist');
  const [items, setItems] = useState<any[]>([]);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => { loadData(); }, [tab]);

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

  const handleMarkDone = async (taskId: string) => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      await fetch(`${backendUrl}/api/tasks/${taskId}`, {
        method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      loadData();
    } catch { Alert.alert('Error', 'Failed to update task'); }
  };

  const handleCall = (phone: string) => {
    if (phone) Linking.openURL(`tel:${phone}`).catch(() => {});
    else Alert.alert('No Phone', 'No phone number available');
  };

  const handleWhatsApp = (phone: string) => {
    if (phone) {
      const clean = phone.replace(/[^0-9]/g, '');
      Linking.openURL(`https://wa.me/${clean}`).catch(() => {});
    } else Alert.alert('No Phone', 'No phone number available');
  };

  const fmtDate = (d: string | null) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const getAlertIcon = (type: string) => {
    switch (type) {
      case 'delivery_due': return '🚚';
      case 'reminder_due': return '💰';
      case 'overdue_invoice': return '⚠️';
      case 'bank_reconciliation': return '🏦';
      default: return '🔔';
    }
  };

  const getPriorityColor = (p: string) => {
    switch (p) {
      case 'urgent': return '#D32F2F';
      case 'high': return '#F57C00';
      case 'medium': return '#FBC02D';
      default: return '#4CAF50';
    }
  };

  const renderWatchlistItem = ({ item }: { item: any }) => (
    <View style={[s.card, item.is_silenced && { opacity: 0.5 }]}>
      <Text style={s.alertIcon}>{getAlertIcon(item.type)}</Text>
      <View style={s.cardContent}>
        <Text style={s.cardText}>{item.content}</Text>
        <View style={s.cardMeta}>
          {item.customer_name && <Text style={s.metaText}>{item.customer_name}</Text>}
          <Text style={s.metaDate}>{fmtDate(item.alert_date)}</Text>
        </View>
      </View>
      <View style={s.actionIcons}>
        {item.customer_id && (
          <TouchableOpacity style={s.iconBtn} onPress={() => router.push(`/chat/${item.customer_id}`)}>
            <Ionicons name="chatbubble-outline" size={18} color="#075E54" />
          </TouchableOpacity>
        )}
        {item.customer_phone && (
          <>
            <TouchableOpacity style={s.iconBtn} onPress={() => handleWhatsApp(item.customer_phone)}>
              <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
            </TouchableOpacity>
            <TouchableOpacity style={s.iconBtn} onPress={() => handleCall(item.customer_phone)}>
              <Ionicons name="call-outline" size={18} color="#075E54" />
            </TouchableOpacity>
          </>
        )}
        {item.task_id && (
          <TouchableOpacity style={s.iconBtn} onPress={() => handleMarkDone(item.task_id)}>
            <Ionicons name="checkmark-circle-outline" size={18} color="#4CAF50" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  const renderTaskItem = ({ item }: { item: any }) => (
    <View style={s.card}>
      <View style={[s.priorityDot, { backgroundColor: getPriorityColor(item.priority) }]} />
      <View style={s.cardContent}>
        <Text style={[s.cardText, item.status === 'completed' && s.strikethrough]}>{item.title}</Text>
        <View style={s.cardMeta}>
          {item.customer_name && <Text style={s.metaText}>{item.customer_name}</Text>}
          {item.due_date && <Text style={s.metaDate}>Due {fmtDate(item.due_date)}</Text>}
          <View style={[s.statusBadge, { backgroundColor: item.status === 'completed' ? '#E8F5E9' : item.status === 'cancelled' ? '#FFEBEE' : '#FFF8E1' }]}>
            <Text style={[s.statusText, { color: item.status === 'completed' ? '#4CAF50' : item.status === 'cancelled' ? '#D32F2F' : '#F9A825' }]}>
              {item.status}
            </Text>
          </View>
        </View>
      </View>
      <View style={s.actionIcons}>
        {item.status !== 'completed' && (
          <TouchableOpacity style={s.iconBtn} onPress={() => handleMarkDone(item.id)}>
            <Ionicons name="checkmark-circle-outline" size={18} color="#4CAF50" />
          </TouchableOpacity>
        )}
        {item.customer_id && (
          <TouchableOpacity style={s.iconBtn} onPress={() => router.push(`/chat/${item.customer_id}`)}>
            <Ionicons name="chatbubble-outline" size={18} color="#075E54" />
          </TouchableOpacity>
        )}
        {item.customer_phone && (
          <TouchableOpacity style={s.iconBtn} onPress={() => handleWhatsApp(item.customer_phone)}>
            <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Activity Center</Text>
      </View>

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
          data={items}
          renderItem={tab === 'watchlist' ? renderWatchlistItem : renderTaskItem}
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
  tabBar: { flexDirection: 'row', backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#075E54' },
  tabText: { fontSize: 14, color: '#999', fontWeight: '500' },
  tabTextActive: { color: '#075E54', fontWeight: '700' },
  listContent: { padding: 12 },
  card: { flexDirection: 'row', backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 8, elevation: 1, gap: 10, alignItems: 'flex-start' },
  alertIcon: { fontSize: 20, marginTop: 2 },
  priorityDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  cardContent: { flex: 1 },
  cardText: { fontSize: 14, color: '#1A1A1A', lineHeight: 20 },
  strikethrough: { textDecorationLine: 'line-through', color: '#999' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  metaText: { fontSize: 12, color: '#075E54', fontWeight: '600' },
  metaDate: { fontSize: 12, color: '#999' },
  statusBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  statusText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  actionIcons: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  iconBtn: { padding: 6, borderRadius: 6, backgroundColor: '#F5F5F5' },
  emptyText: { fontSize: 15, color: '#999' },
});
