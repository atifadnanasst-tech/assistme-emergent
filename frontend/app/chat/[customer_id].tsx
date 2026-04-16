import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
  Keyboard, Modal, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { authService } from '../../lib/auth';

// ── Types ────────────────────────────────────────────────────
interface CustomerData {
  id: string; name: string; initials: string; avatar_color: string;
  outstanding_balance: number | null; health_score: number | null; status: string;
}
interface ChatMessage {
  id: string; role: string; content: string; created_at: string;
  sender_type: string | null; visibility: string; message_type: string;
  card_type: string | null; card_data: Record<string, any>;
  preview_text: string | null;
}

export default function CustomerChatScreen() {
  const router = useRouter();
  const { customer_id } = useLocalSearchParams<{ customer_id: string }>();
  const { setIsAuthenticated } = useAuth();
  const flatListRef = useRef<FlatList>(null);

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [activeTab, setActiveTab] = useState('direct');
  const [sentReminders, setSentReminders] = useState<Set<string>>(new Set());

  // ── Auth helper ────────────────────────────────────────────
  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      router.replace('/login');
      return null;
    }
    return token;
  };

  // ── Load conversation ──────────────────────────────────────
  useEffect(() => { loadChat(); }, [customer_id]);

  const loadChat = async () => {
    try {
      const token = await getToken();
      if (!token || !customer_id) return;

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${backendUrl}/api/chat/${customer_id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 401) {
        await authService.clearSession(); await supabase.auth.signOut();
        setIsAuthenticated(false); router.replace('/login'); return;
      }
      if (!res.ok) { setLoading(false); return; }

      const data = await res.json();
      setConversationId(data.conversation_id);
      setCustomer(data.customer);
      setMessages(data.messages || []);
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Load chat error:', err);
    } finally {
      setLoading(false);
    }
  };

  // ── Send message ───────────────────────────────────────────
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending || !conversationId) return;
    Keyboard.dismiss();
    setInputText('');

    const tempId = `temp-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId, role: 'assistant', content: text,
      created_at: new Date().toISOString(), sender_type: 'owner',
      visibility: 'both', message_type: 'text', card_type: null,
      card_data: {}, preview_text: text.substring(0, 50),
    };
    setMessages(prev => [...prev, optimistic]);
    setSending(true);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/message`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, conversation_id: conversationId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        setMessages(prev => prev.map(m =>
          m.id === tempId ? { ...m, id: data.message_id, created_at: data.created_at } : m
        ));
      } else {
        setMessages(prev => prev.filter(m => m.id !== tempId));
        Alert.alert('Error', "Couldn't send. Tap to retry.");
      }
    } catch (err: any) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      if (err.name !== 'AbortError') Alert.alert('Error', "Couldn't send message.");
    } finally {
      setSending(false);
    }
  };

  // ── Send reminder ──────────────────────────────────────────
  const handleSendReminder = async (invoiceId: string) => {
    if (sentReminders.has(invoiceId)) return;
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/reminder`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
      const data = await res.json();
      if (data.whatsapp_url) {
        try { await Linking.openURL(data.whatsapp_url); } catch {}
      }
      setSentReminders(prev => new Set(prev).add(invoiceId));
      if (data.message_id) loadChat(); // Refresh to show new reminder message
    } catch { Alert.alert('Error', 'Failed to send reminder.'); }
  };

  // ── Formatting helpers ─────────────────────────────────────
  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  };
  const formatCurrency = (n: number) => '₹' + n.toLocaleString('en-IN');
  const formatDateDivider = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  // ── Health dots ────────────────────────────────────────────
  const renderHealthDots = () => {
    const score = customer?.health_score ?? 50;
    const green = score >= 80; const yellow = score >= 40 && score < 80; const red = score < 40;
    return (
      <View style={styles.healthDots}>
        <View style={[styles.healthDot, { backgroundColor: green ? '#4CAF50' : '#E0E0E0' }]} />
        <View style={[styles.healthDot, { backgroundColor: yellow ? '#FFC107' : '#E0E0E0' }]} />
        <View style={[styles.healthDot, { backgroundColor: red ? '#F44336' : '#E0E0E0' }]} />
      </View>
    );
  };

  // ── Message renderers ──────────────────────────────────────
  const renderIncomingMessage = (msg: ChatMessage) => (
    <View style={styles.incomingContainer}>
      <View style={styles.incomingBubble}>
        <Text style={styles.incomingText}>{msg.content}</Text>
        <Text style={styles.incomingTime}>{formatTime(msg.created_at)}</Text>
      </View>
    </View>
  );

  const renderOutgoingMessage = (msg: ChatMessage) => (
    <View style={styles.outgoingContainer}>
      <View style={styles.outgoingBubble}>
        <Text style={styles.outgoingText}>{msg.content}</Text>
        <View style={styles.outgoingTimeRow}>
          <Text style={styles.outgoingTime}>{formatTime(msg.created_at)}</Text>
          <Ionicons name="checkmark-done" size={14} color="#53BDEB" style={{ marginLeft: 4 }} />
        </View>
      </View>
    </View>
  );

  const renderSystemAlert = (msg: ChatMessage) => (
    <View style={styles.systemAlertContainer}>
      <View style={styles.systemAlertStrip}>
        <Ionicons name="warning" size={14} color="#D32F2F" />
        <Text style={styles.systemAlertText}>{msg.content}</Text>
      </View>
    </View>
  );

  const renderInvoiceCard = (msg: ChatMessage) => {
    const cd = msg.card_data || {};
    const invoiceId = cd.invoice_id;
    const isOverdue = cd.status === 'overdue' || (cd.due_date && new Date(cd.due_date) < new Date() && cd.status !== 'paid');
    const statusText = cd.status === 'paid' ? 'PAID' : isOverdue ? 'OVERDUE' : 'SENT';
    const statusColor = cd.status === 'paid' ? '#4CAF50' : isOverdue ? '#D32F2F' : '#4CAF50';
    return (
      <View style={styles.invoiceCardContainer}>
        <View style={styles.invoiceCard}>
          <View style={styles.invoiceHeader}>
            <Text style={styles.invoiceNumber}>Invoice #{cd.invoice_number || '---'}</Text>
            <Text style={[styles.invoiceStatus, { color: statusColor }]}>{statusText}</Text>
          </View>
          {cd.items_summary && <Text style={styles.invoiceItems}>{cd.items_summary}</Text>}
          {cd.due_date && <Text style={styles.invoiceItems}>Due {new Date(cd.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</Text>}
          <Text style={[styles.invoiceAmount, isOverdue && { color: '#D32F2F' }]}>{formatCurrency(cd.total_amount || 0)}</Text>
          {cd.status !== 'paid' && (
            isOverdue ? (
              sentReminders.has(invoiceId) ? (
                <Text style={styles.invoiceActionDone}>Reminder sent ✓</Text>
              ) : (
                <TouchableOpacity onPress={() => handleSendReminder(invoiceId)}>
                  <Text style={styles.invoiceActionRed}>Send reminder ›</Text>
                </TouchableOpacity>
              )
            ) : (
              <TouchableOpacity onPress={() => {
                if (customer?.id) {
                  const phone = ''; // Would need customer phone
                  Linking.openURL(`https://wa.me/?text=${encodeURIComponent(`Invoice #${cd.invoice_number} - ${formatCurrency(cd.total_amount || 0)}`)}`).catch(() => {});
                }
              }}>
                <Text style={styles.invoiceActionGreen}>Share via WhatsApp ›</Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </View>
    );
  };

  // ── Date divider logic ─────────────────────────────────────
  const shouldShowDateDivider = (index: number) => {
    if (index === 0) return true;
    const curr = new Date(messages[index].created_at);
    const prev = new Date(messages[index - 1].created_at);
    return curr.getMonth() !== prev.getMonth() || curr.getFullYear() !== prev.getFullYear();
  };

  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const divider = shouldShowDateDivider(index) ? (
      <View style={styles.dateDividerContainer}>
        <View style={styles.dateDividerPill}>
          <Text style={styles.dateDividerText}>{formatDateDivider(item.created_at)}</Text>
        </View>
      </View>
    ) : null;

    let content = null;
    if (item.message_type === 'invoice_card' || item.card_type === 'invoice_card') {
      content = renderInvoiceCard(item);
    } else if (item.role === 'system' || item.message_type === 'system_alert') {
      content = renderSystemAlert(item);
    } else if (item.role === 'user') {
      content = renderIncomingMessage(item);
    } else {
      content = renderOutgoingMessage(item);
    }

    return <>{divider}{content}</>;
  };

  // ── 3-dot menu ─────────────────────────────────────────────
  const menuItems = [
    { icon: 'person-outline', label: 'View contact', action: () => { setMenuVisible(false); router.push(`/customer/${customer_id}/report`); } },
    { icon: 'search-outline', label: 'Search', action: () => { setMenuVisible(false); } },
    { icon: 'ban-outline', label: 'Block', color: '#D32F2F', action: () => { setMenuVisible(false); Alert.alert('Block', 'Block this customer?'); } },
    { icon: 'trash-outline', label: 'Clear chat', color: '#D32F2F', action: () => { setMenuVisible(false); Alert.alert('Clear Chat', 'Clear all messages?'); } },
    { divider: true },
    { icon: 'document-text-outline', label: 'Create quote', action: () => { setMenuVisible(false); router.push(`/customer/${customer_id}/quote`); } },
    { icon: 'receipt-outline', label: 'Create invoice', action: () => { setMenuVisible(false); router.push(`/customer/${customer_id}/invoice`); } },
    { icon: 'alarm-outline', label: 'Set payment reminder', action: () => { setMenuVisible(false); } },
    { icon: 'cash-outline', label: 'Record payment', action: () => { setMenuVisible(false); } },
    { divider: true },
    { icon: 'settings-outline', label: 'Set reminder rules', action: () => { setMenuVisible(false); } },
    { icon: 'language-outline', label: 'Set language', action: () => { setMenuVisible(false); } },
    { icon: 'options-outline', label: 'Customer preference', action: () => { setMenuVisible(false); } },
  ];

  // ── Loading state ──────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.safeTop} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Loading...</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  // ── Main render ────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.flex1}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <SafeAreaView style={styles.safeTop} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </TouchableOpacity>

          <View style={[styles.avatar, { backgroundColor: customer?.avatar_color || '#075E54' }]}>
            <Text style={styles.avatarText}>{customer?.initials || '?'}</Text>
          </View>

          <View style={styles.headerInfo}>
            <Text style={styles.headerName} numberOfLines={1}>{customer?.name || 'Customer'}</Text>
            {customer?.outstanding_balance != null && customer.outstanding_balance > 0 && (
              <Text style={styles.headerPending}>{formatCurrency(customer.outstanding_balance)} pending</Text>
            )}
          </View>

          <TouchableOpacity style={styles.headerBtn}>
            <Ionicons name="call-outline" size={20} color="#FFF" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn}>
            <Ionicons name="list-outline" size={20} color="#FFF" />
          </TouchableOpacity>
          {renderHealthDots()}
          <TouchableOpacity style={styles.headerBtn} onPress={() => setMenuVisible(true)}>
            <Ionicons name="ellipsis-vertical" size={20} color="#FFF" />
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'direct' && styles.tabActive]}
            onPress={() => setActiveTab('direct')}
          >
            <Text style={[styles.tabText, activeTab === 'direct' && styles.tabTextActive]}>Direct Messages</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'broadcast' && styles.tabActive]}
            onPress={() => setActiveTab('broadcast')}
          >
            <Text style={[styles.tabText, activeTab === 'broadcast' && styles.tabTextActive]}>Broadcast</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'ai' && styles.tabActive]}
            onPress={() => setActiveTab('ai')}
          >
            <Text style={[styles.tabText, activeTab === 'ai' && styles.tabTextActive]}>AI Messages</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Chat area */}
      <View style={styles.chatArea}>
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No messages yet. Start a conversation.</Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.chatContent}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>

      {/* Input bar */}
      <SafeAreaView style={styles.inputSafeArea} edges={['bottom']}>
        <View style={styles.inputRow}>
          <View style={styles.inputPill}>
            <TouchableOpacity style={styles.inputIconBtn}>
              <Ionicons name="happy-outline" size={22} color="#667781" />
            </TouchableOpacity>
            <TextInput
              style={styles.textInput}
              placeholder="Message or voice..."
              placeholderTextColor="#999"
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={2000}
            />
            <TouchableOpacity style={styles.inputIconBtn}>
              <Ionicons name="attach" size={22} color="#667781" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.inputIconBtn}>
              <Ionicons name="camera-outline" size={22} color="#667781" />
            </TouchableOpacity>
          </View>

          <View style={styles.rightCapsule}>
            {inputText.trim().length > 0 ? (
              <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={sending}>
                {sending ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Ionicons name="send" size={20} color="#FFF" />
                )}
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity style={styles.sparkBtn} onPress={() => {
                  // Phase 4: AI Spark will go here
                  Alert.alert('AI Spark', 'AI Spark coming in Phase 4');
                }}>
                  <Ionicons name="sparkles" size={22} color="#FFF" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.micBtn}>
                  <Ionicons name="mic" size={20} color="#CCC" />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </SafeAreaView>

      {/* 3-dot menu overlay */}
      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <View style={styles.menuContainer}>
            <View style={styles.menuHeader}>
              <View style={[styles.menuAvatar, { backgroundColor: customer?.avatar_color || '#075E54' }]}>
                <Text style={styles.menuAvatarText}>{customer?.initials || '?'}</Text>
              </View>
              <View>
                <Text style={styles.menuTitle}>Client Details</Text>
                <Text style={styles.menuStatus}>{(customer?.status || 'active').toUpperCase()}</Text>
              </View>
            </View>

            {menuItems.map((item: any, i) => {
              if (item.divider) return <View key={`div-${i}`} style={styles.menuDivider} />;
              return (
                <TouchableOpacity key={i} style={styles.menuItem} onPress={item.action}>
                  <Ionicons name={item.icon} size={20} color={item.color || '#333'} />
                  <Text style={[styles.menuItemText, item.color ? { color: item.color } : null]}>{item.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ── Styles ───────────────────────────────────────────────────
const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: '#ECE5DD' },
  safeTop: { backgroundColor: '#075E54' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#ECE5DD' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54',
    paddingVertical: 10, paddingHorizontal: 4, gap: 2,
  },
  headerBtn: { padding: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  headerInfo: { flex: 1, marginLeft: 8 },
  headerName: { color: '#FFF', fontSize: 17, fontWeight: '700' },
  headerPending: { color: '#FF8A80', fontSize: 12, fontWeight: '600' },
  headerTitle: { color: '#FFF', fontSize: 17, fontWeight: '700', flex: 1, marginLeft: 8 },
  healthDots: { flexDirection: 'row', gap: 4, paddingHorizontal: 4 },
  healthDot: { width: 8, height: 8, borderRadius: 4 },

  // Tab bar
  tabBar: {
    flexDirection: 'row', backgroundColor: '#075E54',
    paddingBottom: 2,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#FFFFFF' },
  tabText: { color: '#FFFFFFAA', fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: '#FFFFFF', fontWeight: '700' },

  // Chat area
  chatArea: { flex: 1, backgroundColor: '#ECE5DD' },
  chatContent: { padding: 8, paddingBottom: 8 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#999', fontSize: 15 },

  // Date divider
  dateDividerContainer: { alignItems: 'center', marginVertical: 12 },
  dateDividerPill: { backgroundColor: '#D4E4DC', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 },
  dateDividerText: { color: '#333', fontSize: 12, fontWeight: '600' },

  // Incoming (customer - left, white)
  incomingContainer: { alignItems: 'flex-start', marginBottom: 4, paddingHorizontal: 8 },
  incomingBubble: { backgroundColor: '#FFF', borderRadius: 12, borderTopLeftRadius: 0, padding: 10, maxWidth: '80%', elevation: 1 },
  incomingText: { color: '#1A1A1A', fontSize: 14, lineHeight: 20 },
  incomingTime: { color: '#999', fontSize: 11, textAlign: 'right', marginTop: 4 },

  // Outgoing (owner - right, green)
  outgoingContainer: { alignItems: 'flex-end', marginBottom: 4, paddingHorizontal: 8 },
  outgoingBubble: { backgroundColor: '#DCF8C6', borderRadius: 12, borderTopRightRadius: 0, padding: 10, maxWidth: '80%', elevation: 1 },
  outgoingText: { color: '#1A1A1A', fontSize: 14, lineHeight: 20 },
  outgoingTimeRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 4 },
  outgoingTime: { color: '#999', fontSize: 11 },

  // System alert (centered, red/pink)
  systemAlertContainer: { alignItems: 'center', marginVertical: 8, paddingHorizontal: 16 },
  systemAlertStrip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFEBEE',
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, gap: 8,
  },
  systemAlertText: { color: '#D32F2F', fontSize: 13, fontWeight: '500', flex: 1 },

  // Invoice card (centered, full width)
  invoiceCardContainer: { alignItems: 'center', marginVertical: 8, paddingHorizontal: 16 },
  invoiceCard: {
    backgroundColor: '#FFF', borderRadius: 12, padding: 16, width: '100%',
    borderWidth: 1, borderColor: '#E0E0E0', elevation: 1,
  },
  invoiceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  invoiceNumber: { fontSize: 15, fontWeight: '700', color: '#1A1A1A' },
  invoiceStatus: { fontSize: 13, fontWeight: '700' },
  invoiceItems: { fontSize: 13, color: '#666', marginBottom: 2 },
  invoiceAmount: { fontSize: 20, fontWeight: '700', color: '#1A1A1A', marginTop: 8 },
  invoiceActionGreen: { color: '#075E54', fontSize: 14, fontWeight: '600', marginTop: 10, textDecorationLine: 'underline' },
  invoiceActionRed: { color: '#D32F2F', fontSize: 14, fontWeight: '600', marginTop: 10, textDecorationLine: 'underline' },
  invoiceActionDone: { color: '#999', fontSize: 14, marginTop: 10 },

  // Input bar
  inputSafeArea: { backgroundColor: '#F0F0F0' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 6, gap: 6, backgroundColor: '#F0F0F0' },
  inputPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF',
    borderRadius: 24, paddingHorizontal: 8, minHeight: 48,
  },
  inputIconBtn: { padding: 6 },
  textInput: { flex: 1, fontSize: 15, color: '#333', maxHeight: 100, paddingVertical: 8 },
  rightCapsule: { alignItems: 'center', gap: 6 },
  sparkBtn: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#075E54',
    justifyContent: 'center', alignItems: 'center',
  },
  sendBtn: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#075E54',
    justifyContent: 'center', alignItems: 'center',
  },
  micBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#E0E0E0',
    justifyContent: 'center', alignItems: 'center',
  },

  // Menu overlay
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menuContainer: {
    position: 'absolute', top: 60, right: 8, backgroundColor: '#FFF',
    borderRadius: 12, paddingVertical: 8, width: 260, elevation: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12,
  },
  menuHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  menuAvatar: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  menuAvatarText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  menuTitle: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  menuStatus: { fontSize: 11, fontWeight: '700', color: '#4CAF50' },
  menuDivider: { height: 1, backgroundColor: '#F0F0F0', marginVertical: 4 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  menuItemText: { fontSize: 15, color: '#333' },
});
