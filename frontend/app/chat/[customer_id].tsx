import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
  Keyboard, Modal, Pressable, ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
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
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerData | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [activeTab, setActiveTab] = useState('direct');
  const [sentReminders, setSentReminders] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [sparkMode, setSparkMode] = useState(false);
  const [sparkProcessing, setSparkProcessing] = useState(false);
  const [sparkInput, setSparkInput] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Action Preview Sheet
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewDraftId, setPreviewDraftId] = useState<string | null>(null);
  const [previewActions, setPreviewActions] = useState<any[]>([]);
  const [previewInsight, setPreviewInsight] = useState<string | null>(null);
  const [checkedActions, setCheckedActions] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  // Auto-confirm banner
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerText, setBannerText] = useState('');
  const [bannerDraftId, setBannerDraftId] = useState<string | null>(null);
  const [bannerActionIds, setBannerActionIds] = useState<string[]>([]);
  // Date edit sheet
  const [dateEditVisible, setDateEditVisible] = useState(false);
  const [dateEditAction, setDateEditAction] = useState<any>(null);
  const [dateEditValue, setDateEditValue] = useState(new Date());
  const [dateEditDesc, setDateEditDesc] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  // AI query
  const [aiQueryText, setAiQueryText] = useState('');
  const [aiQuerying, setAiQuerying] = useState(false);

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

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

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
setTimeout(() => {
  flatListRef.current?.scrollToEnd({ animated: false });
}, 100);
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Load chat error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
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

  // ── AI Spark handler ───────────────────────────────────────
  const handleSpark = async () => {
    const text = sparkInput.trim() || inputText.trim();
    if (!text || sparkProcessing || !conversationId) return;
    Keyboard.dismiss();
    setSparkInput('');
    setInputText('');
    setSparkMode(false);
    setSparkProcessing(true);

    // Do NOT add instruction to messages — it is NOT a chat message to the customer.
    // The sparkProcessing indicator shows the owner that AI is working.

    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/spark`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, conversation_id: conversationId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 401) {
        await authService.clearSession(); await supabase.auth.signOut();
        setIsAuthenticated(false); router.replace('/login'); return;
      }

      const data = await res.json();

      if (data.routing === 'clarify') {
        // AI asks clarifying question — reload to show it
        await loadChat();
      } else if (data.routing === 'preview') {
        // Show Action Preview Sheet
        setPreviewDraftId(data.draft_id);
        setPreviewActions(data.actions || []);
        setPreviewInsight(data.ai_insight);
        setCheckedActions(new Set((data.actions || []).map((a: any) => a.action_id)));
        setPreviewVisible(true);
      } else if (data.routing === 'auto_confirm') {
        // Auto-confirm: execute immediately, show banner
        const confirmRes = await fetch(`${backendUrl}/api/chat/${customer_id}/spark/confirm`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft_id: data.draft_id, action_ids: (data.actions || []).map((a: any) => a.action_id) }),
        });
        const confirmData = await confirmRes.json();
        if (confirmData.executed?.length > 0) {
          setBannerText(data.actions?.[0]?.details || 'Action completed');
          setBannerDraftId(data.draft_id);
          setBannerActionIds((data.actions || []).map((a: any) => a.action_id));
          setBannerVisible(true);
          // 5 second auto-dismiss
          setTimeout(() => setBannerVisible(false), 5000);
        }
        await loadChat();
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        Alert.alert('Spark Error', 'Could not process your request. Try again.');
      }
    } finally {
      setSparkProcessing(false);
    }
  };

  // ── Confirm All handler ────────────────────────────────────
  const handleConfirmAll = async () => {
    if (confirming || !previewDraftId) return;
    setConfirming(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const selectedIds = Array.from(checkedActions);

      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/spark/confirm`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_id: previewDraftId, action_ids: selectedIds }),
      });
      const data = await res.json();

      setPreviewVisible(false);
      setPreviewDraftId(null);
      setPreviewActions([]);

      if (data.executed?.length > 0) {
        await loadChat(); // Refresh to show invoice card
      }
      if (data.failed?.length > 0) {
        Alert.alert('Warning', `${data.failed.length} action(s) failed to execute.`);
      }
    } catch {
      Alert.alert('Error', 'Failed to execute actions.');
    } finally {
      setConfirming(false);
    }
  };

  // ── Cancel draft handler ───────────────────────────────────
  const handleCancelDraft = async () => {
    if (!previewDraftId) return;
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      await fetch(`${backendUrl}/api/chat/${customer_id}/spark/${previewDraftId}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch {}
    setPreviewVisible(false);
    setPreviewDraftId(null);
    setPreviewActions([]);
  };

  // ── Banner Undo handler ────────────────────────────────────
  const handleBannerUndo = async () => {
    if (!bannerDraftId) return;
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      await fetch(`${backendUrl}/api/chat/${customer_id}/spark/${bannerDraftId}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch {}
    setBannerVisible(false);
    setBannerText('Action undone');
    setBannerVisible(true);
    setTimeout(() => setBannerVisible(false), 2000);
  };

  // ── AI Query handler ───────────────────────────────────────
  const handleAiQuery = async () => {
    const text = aiQueryText.trim();
    if (!text || aiQuerying || !conversationId) return;
    Keyboard.dismiss();
    setAiQueryText('');
    setAiQuerying(true);

    // Optimistic: add owner's query locally
    const tempQId = `aiq-${Date.now()}`;
    const queryMsg: ChatMessage = {
      id: tempQId, role: 'user', content: text,
      created_at: new Date().toISOString(), sender_type: 'owner',
      visibility: 'owner_only', message_type: 'ai_query', card_type: null,
      card_data: {}, preview_text: text.substring(0, 50),
    };
    setMessages(prev => [...prev, queryMsg]);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/ai-query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, conversation_id: conversationId }),
      });
      if (res.ok) {
        const data = await res.json();
        const respMsg: ChatMessage = {
          id: data.message_id || `air-${Date.now()}`, role: 'assistant', content: data.response,
          created_at: new Date().toISOString(), sender_type: 'ai',
          visibility: 'owner_only', message_type: 'ai_response', card_type: null,
          card_data: {}, preview_text: data.response?.substring(0, 50),
        };
        setMessages(prev => [...prev, respMsg]);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      } else {
        Alert.alert('Error', 'Could not get AI response. Try again.');
      }
    } catch {
      Alert.alert('Error', 'AI query failed.');
    } finally {
      setAiQuerying(false);
    }
  };

  // ── Formatting helpers ─────────────────────────────────────
  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  };
  const formatCurrency = (n: number) => '₹' + n.toLocaleString('en-IN');
  const formatDateDivider = (ts: string) => {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
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
    return curr.toDateString() !== prev.toDateString();
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
    } else if (item.message_type === 'ai_query') {
      // Owner's AI query — right-aligned teal bubble
      content = (
        <View style={styles.outgoingContainer}>
          <View style={[styles.outgoingBubble, { backgroundColor: '#E0F2F1' }]}>
            <Text style={[styles.outgoingText, { color: '#00695C' }]}>{item.content}</Text>
            <Text style={styles.outgoingTime}>{formatTime(item.created_at)}</Text>
          </View>
        </View>
      );
    } else if (item.message_type === 'ai_response') {
      // AI response — left-aligned with AI icon
      content = (
        <View style={styles.incomingContainer}>
          <View style={[styles.incomingBubble, { backgroundColor: '#F0FAF8', borderLeftWidth: 3, borderLeftColor: '#075E54' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="sparkles" size={14} color="#075E54" />
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#075E54' }}>AI</Text>
            </View>
            <Text style={styles.incomingText}>{item.content}</Text>
            <Text style={styles.incomingTime}>{formatTime(item.created_at)}</Text>
          </View>
        </View>
      );
    } else if (item.role === 'system' || item.message_type === 'system_alert' || item.message_type === 'spark_clarify') {
      content = renderSystemAlert(item);
    } else if (item.visibility === 'owner_only' && item.sender_type === 'ai') {
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
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
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

      {/* Chat area — filtered by active tab */}
      <View style={styles.chatArea}>
        {activeTab === 'broadcast' ? (
          <View style={styles.emptyState}>
            <Ionicons name="megaphone-outline" size={48} color="#CCC" />
            <Text style={styles.emptyText}>Broadcast Messages</Text>
            <Text style={[styles.emptyText, { fontSize: 13, marginTop: 4 }]}>Coming soon</Text>
          </View>
        ) : (() => {
          const filtered = messages.filter(m => {
            if (activeTab === 'direct') {
              // Direct: customer-facing messages + invoice cards + system alerts (pink strips)
              return m.visibility === 'both' || m.message_type === 'invoice_card' || m.message_type === 'system_alert' || m.message_type === 'spark_clarify';
            } else {
              // AI: owner-only messages (pink strips, AI queries, AI responses)
              return m.visibility === 'owner_only' || m.message_type === 'ai_query' || m.message_type === 'ai_response' || m.message_type === 'system_alert' || m.message_type === 'spark_clarify';
            }
          });
          return filtered.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name={activeTab === 'ai' ? 'sparkles-outline' : 'chatbubbles-outline'} size={48} color="#CCC" />
              <Text style={styles.emptyText}>
                {activeTab === 'ai' ? `Ask AI anything about ${customer?.name || 'this customer'}` : 'No messages yet'}
              </Text>
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={filtered}
              renderItem={renderMessage}
              keyExtractor={item => item.id}
              contentContainerStyle={styles.chatContent}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
              showsVerticalScrollIndicator={false}
              refreshing={refreshing}
              onRefresh={loadChat}
            />
          );
        })()}
      </View>

      {/* Spark FAB — only on Direct Messages tab */}
      {activeTab === 'direct' && !sparkMode && !sparkProcessing && inputText.trim().length === 0 && (
        <TouchableOpacity style={[styles.sparkFab, { bottom: 68 + (keyboardVisible ? 0 : insets.bottom) }]} onPress={() => setSparkMode(true)}>
          <Ionicons name="sparkles" size={22} color="#FFF" />
        </TouchableOpacity>
      )}

      {/* Input bar — different for each tab */}
      {activeTab === 'broadcast' ? null : activeTab === 'ai' ? (
        /* AI Messages input */
        <View style={[styles.inputBarWrapper, { paddingBottom: keyboardVisible ? 0 : insets.bottom }]}>
          {aiQuerying && (
            <View style={styles.sparkProcessingBar}>
              <ActivityIndicator size="small" color="#075E54" />
              <Text style={styles.sparkProcessingText}>AI is thinking...</Text>
            </View>
          )}
          <View style={styles.inputRow}>
            <View style={[styles.inputPill, styles.aiInputPill]}>
              <Ionicons name="sparkles" size={20} color="#075E54" style={{ marginLeft: 6 }} />
              <TextInput
                style={styles.textInput}
                placeholder={`Ask about ${customer?.name || 'this customer'}...`}
                placeholderTextColor="#075E54"
                value={aiQueryText}
                onChangeText={setAiQueryText}
                multiline
                maxLength={2000}
              />
            </View>
            <TouchableOpacity
              style={[styles.sendBtn, styles.sparkSendBtn]}
              onPress={handleAiQuery}
              disabled={aiQuerying || aiQueryText.trim().length === 0}
            >
              {aiQuerying ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <Ionicons name="send" size={20} color="#FFF" />
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* Direct Messages input */
        <View style={[styles.inputBarWrapper, { paddingBottom: keyboardVisible ? 0 : insets.bottom }]}>
          {sparkProcessing && (
            <View style={styles.sparkProcessingBar}>
              <ActivityIndicator size="small" color="#075E54" />
              <Text style={styles.sparkProcessingText}>AI is analyzing your request...</Text>
            </View>
          )}
          {sparkMode && !sparkProcessing && (
            <View style={styles.sparkIndicator}>
              <Ionicons name="sparkles" size={16} color="#075E54" />
              <Text style={styles.sparkIndicatorText}>AI Spark Mode — type a natural language instruction</Text>
              <TouchableOpacity onPress={() => { setSparkMode(false); setSparkInput(''); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={20} color="#999" />
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.inputRow}>
            <View style={[styles.inputPill, sparkMode && styles.inputPillSpark]}>
              <TouchableOpacity style={styles.inputIconBtn}>
                <Ionicons name={sparkMode ? 'sparkles' : 'happy-outline'} size={22} color={sparkMode ? '#075E54' : '#667781'} />
              </TouchableOpacity>
              <TextInput
                style={styles.textInput}
                placeholder={sparkMode ? 'What would you like to do?' : 'Message or voice...'}
                placeholderTextColor={sparkMode ? '#075E54' : '#999'}
                value={inputText}
                onChangeText={setInputText}
                multiline
                maxLength={2000}
              />
              {!sparkMode && (
                <>
                  <TouchableOpacity style={styles.inputIconBtn}>
                    <Ionicons name="attach" size={22} color="#667781" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.inputIconBtn}>
                    <Ionicons name="camera-outline" size={22} color="#667781" />
                  </TouchableOpacity>
                </>
              )}
            </View>
            {sparkMode ? (
              <TouchableOpacity style={[styles.sendBtn, styles.sparkSendBtn]} onPress={handleSpark} disabled={sparkProcessing || inputText.trim().length === 0}>
                {sparkProcessing ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="send" size={20} color="#FFF" />}
              </TouchableOpacity>
            ) : inputText.trim().length > 0 ? (
              <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={sending}>
                {sending ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="send" size={20} color="#FFF" />}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.micBtn}>
                <Ionicons name="mic" size={22} color="#FFF" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

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

      {/* Action Preview Sheet */}
      <Modal visible={previewVisible} transparent animationType="slide" onRequestClose={handleCancelDraft}>
        <View style={styles.sheetOverlay}>
          <Pressable style={styles.sheetDismiss} onPress={handleCancelDraft} />
          <View style={styles.sheetContainer}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetHeading}>I've prepared this:</Text>
            <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>

            {previewActions.map((action: any) => (
              <View key={action.action_id} style={styles.actionBlock}>
                <TouchableOpacity
                  style={styles.actionCheckbox}
                  onPress={() => setCheckedActions(prev => {
                    const next = new Set(prev);
                    next.has(action.action_id) ? next.delete(action.action_id) : next.add(action.action_id);
                    return next;
                  })}
                >
                  <Ionicons
                    name={checkedActions.has(action.action_id) ? 'checkbox' : 'square-outline'}
                    size={24} color={checkedActions.has(action.action_id) ? '#075E54' : '#CCC'}
                  />
                </TouchableOpacity>
                <View style={styles.actionContent}>
                  <Text style={styles.actionName}>
                    {action.action_type === 'create_invoice' ? 'Create Invoice' :
                     action.action_type === 'schedule_delivery' ? 'Delivery' :
                     action.action_type === 'set_reminder' ? 'Payment Reminder' :
                     action.action_type === 'record_payment' ? 'Record Payment' :
                     action.action_type}
                  </Text>

                  {/* Rich invoice items rendering */}
                  {action.action_type === 'create_invoice' && action.items?.length > 0 ? (
                    <View>
                      {action.items.map((item: any, idx: number) => (
                        <View key={idx} style={styles.invoiceItemRow}>
                          <Text style={styles.invoiceItemName}>
                            {item.quantity} × {item.product_name}
                          </Text>
                          {item.unit_price != null && (
                            <Text style={styles.invoiceItemPrice}>
                              @ ₹{item.unit_price.toLocaleString('en-IN')} = ₹{(item.line_total || item.unit_price * item.quantity).toLocaleString('en-IN')}
                            </Text>
                          )}
                          {item.alternatives?.length > 1 && (
                            <View style={styles.altRow}>
                              <Text style={styles.altLabel}>Also found:</Text>
                              {item.alternatives.filter((a: any) => a.id !== item.product_id).slice(0, 3).map((alt: any) => (
                                <TouchableOpacity key={alt.id} style={styles.altChip} onPress={() => {
                                  // Swap product in this item
                                  const updated = previewActions.map((pa: any) => {
                                    if (pa.action_id !== action.action_id) return pa;
                                    const newItems = [...pa.items];
                                    newItems[idx] = { ...newItems[idx], product_name: alt.name, product_id: alt.id, unit_price: alt.selling_price, line_total: alt.selling_price * newItems[idx].quantity };
                                    const newTotal = newItems.reduce((s: number, i: any) => s + (i.line_total || 0), 0);
                                    return { ...pa, items: newItems, parameters: { ...pa.parameters, items: newItems, amount: newTotal } };
                                  });
                                  setPreviewActions(updated);
                                }}>
                                  <Text style={styles.altChipText}>{alt.name} (₹{alt.selling_price})</Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                        </View>
                      ))}
                      {action.parameters?.amount > 0 && (
                        <Text style={styles.invoiceTotalText}>Total: ₹{action.parameters.amount.toLocaleString('en-IN')}</Text>
                      )}
                      {action.parameters?.due_date && (
                        <Text style={styles.invoiceDueText}>Due: {action.parameters.due_date}</Text>
                      )}
                    </View>
                  ) : (
                    <Text style={styles.actionDetails}>{action.details}</Text>
                  )}
                </View>
                <TouchableOpacity style={styles.actionEditBtn} onPress={() => {
                  if (action.action_type === 'create_invoice') {
                    setPreviewVisible(false);
                    const p = action.parameters || {};
                    const params: Record<string, string> = {};
                    if (p.items) params.items = JSON.stringify(p.items);
                    if (p.due_date) params.due_date = p.due_date;
                    if (p.amount) params.amount = String(p.amount);
                    if (previewDraftId) params.draft_id = previewDraftId;
                    if (action.action_id) params.action_id = action.action_id;
                    router.push({ pathname: `/customer/${customer_id}/invoice`, params });
                  } else if (action.action_type === 'schedule_delivery' || action.action_type === 'set_reminder') {
                    const dateStr = action.action_type === 'schedule_delivery'
                      ? action.parameters?.delivery_date
                      : action.parameters?.due_date;
                    setDateEditAction(action);
                    setDateEditValue(dateStr ? new Date(dateStr + 'T00:00:00') : new Date());
                    setDateEditDesc(action.parameters?.description || action.details || '');
                    setShowDatePicker(Platform.OS === 'ios');
                    setDateEditVisible(true);
                  }
                }}>
                  <Text style={styles.actionEditText}>Edit</Text>
                </TouchableOpacity>
              </View>
            ))}

            {previewInsight && (
              <View style={styles.insightBox}>
                <Ionicons name="bulb-outline" size={18} color="#00796B" />
                <Text style={styles.insightBoxText}>{previewInsight}</Text>
              </View>
            )}
            </ScrollView>

            <View style={styles.sheetButtons}>
              <TouchableOpacity
                style={[styles.confirmAllBtn, confirming && { opacity: 0.6 }]}
                onPress={handleConfirmAll}
                disabled={confirming || checkedActions.size === 0}
              >
                {confirming ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Text style={styles.confirmAllText}>Confirm All</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.editMasterBtn}>
                <Text style={styles.editMasterText}>Edit</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={handleCancelDraft} style={styles.cancelLink}>
              <Text style={styles.cancelLinkText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Date Edit Sheet for Delivery / Reminder */}
      <Modal visible={dateEditVisible} transparent animationType="slide" onRequestClose={() => setDateEditVisible(false)}>
        <View style={styles.sheetOverlay}>
          <Pressable style={styles.sheetDismiss} onPress={() => setDateEditVisible(false)} />
          <View style={[styles.sheetContainer, { paddingBottom: 40 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetHeading}>
              {dateEditAction?.action_type === 'schedule_delivery' ? 'Edit Delivery' : 'Edit Payment Reminder'}
            </Text>

            {/* Date picker */}
            <View style={styles.dateField}>
              <Ionicons name="calendar-outline" size={22} color="#075E54" />
              <Text style={styles.dateFieldLabel}>Date</Text>
              <TouchableOpacity
                style={styles.dateFieldValue}
                onPress={() => setShowDatePicker(true)}
              >
                <Text style={styles.dateFieldValueText}>
                  {dateEditValue.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
                <Ionicons name="chevron-down" size={18} color="#666" />
              </TouchableOpacity>
            </View>
            {showDatePicker && (
              <DateTimePicker
                value={dateEditValue}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                minimumDate={new Date()}
                onChange={(event: any, date?: Date) => {
                  if (Platform.OS === 'android') setShowDatePicker(false);
                  if (date) setDateEditValue(date);
                }}
                themeVariant="light"
              />
            )}

            {/* Description */}
            <View style={styles.dateDescField}>
              <Ionicons name="document-text-outline" size={22} color="#075E54" />
              <TextInput
                style={styles.dateDescInput}
                value={dateEditDesc}
                onChangeText={setDateEditDesc}
                placeholder="Description"
                placeholderTextColor="#999"
                multiline
              />
            </View>

            {/* Save button */}
            <TouchableOpacity
              style={styles.confirmAllBtn}
              onPress={() => {
                const dateStr = dateEditValue.toISOString().split('T')[0];
                const updated = previewActions.map((pa: any) => {
                  if (pa.action_id !== dateEditAction?.action_id) return pa;
                  const key = pa.action_type === 'schedule_delivery' ? 'delivery_date' : 'due_date';
                  return {
                    ...pa,
                    details: pa.action_type === 'schedule_delivery' ? `Schedule: ${dateStr}` : `Send on: ${dateStr}`,
                    parameters: { ...pa.parameters, [key]: dateStr, description: dateEditDesc },
                  };
                });
                setPreviewActions(updated);
                setDateEditVisible(false);
              }}
            >
              <Text style={styles.confirmAllText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Auto-confirm Banner */}
      {bannerVisible && (
        <View style={styles.bannerContainer}>
          <Text style={styles.bannerText} numberOfLines={2}>{bannerText}</Text>
          <View style={styles.bannerButtons}>
            <TouchableOpacity style={styles.bannerBtn} onPress={() => setBannerVisible(false)}>
              <Text style={styles.bannerBtnText}>OK</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.bannerBtn} onPress={() => {
              setBannerVisible(false);
              // Re-open preview with the auto-confirmed action
              if (bannerDraftId && bannerActionIds.length > 0) {
                setPreviewDraftId(bannerDraftId);
                setPreviewActions(bannerActionIds.map(id => ({ action_id: id, action_type: 'edit', details: bannerText, editable: true })));
                setCheckedActions(new Set(bannerActionIds));
                setPreviewVisible(true);
              }
            }}>
              <Text style={styles.bannerBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.bannerBtn} onPress={handleBannerUndo}>
              <Text style={[styles.bannerBtnText, { color: '#D32F2F' }]}>Undo</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.bannerTimerBar} />
        </View>
      )}
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
  inputBarWrapper: { backgroundColor: '#F0F0F0' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingVertical: 4, paddingHorizontal: 6, gap: 6, backgroundColor: '#F0F0F0' },
  inputPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF',
    borderRadius: 24, paddingHorizontal: 8, minHeight: 44,
  },
  inputPillSpark: {
    borderWidth: 1.5, borderColor: '#075E54', backgroundColor: '#F0FAF8',
  },
  aiInputPill: {
    borderWidth: 1.5, borderColor: '#00796B', backgroundColor: '#E0F2F1',
  },
  sparkIndicator: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#E8F5E9',
    paddingVertical: 8, paddingHorizontal: 14, gap: 8,
  },
  sparkIndicatorText: { flex: 1, fontSize: 12, color: '#075E54', fontWeight: '500' },
  sparkProcessingBar: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#E0F2F1',
    paddingVertical: 10, paddingHorizontal: 14, gap: 10,
  },
  sparkProcessingText: { fontSize: 13, color: '#00796B', fontWeight: '500' },
  inputIconBtn: { padding: 6 },
  textInput: { flex: 1, fontSize: 15, color: '#333', maxHeight: 100, paddingVertical: 6 },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#075E54',
    justifyContent: 'center', alignItems: 'center',
  },
  sparkSendBtn: {
    backgroundColor: '#00796B',
  },
  sparkFab: {
    position: 'absolute', right: 16, zIndex: 20,
    width: 52, height: 52, borderRadius: 26, backgroundColor: '#075E54',
    justifyContent: 'center', alignItems: 'center',
    elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25, shadowRadius: 4,
  },
  micBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#075E54',
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

  // Action Preview Sheet
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheetDismiss: { flex: 1 },
  sheetContainer: {
    backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingBottom: 30, maxHeight: '80%',
  },
  sheetHandle: { width: 40, height: 4, backgroundColor: '#DDD', borderRadius: 2, alignSelf: 'center', marginVertical: 12 },
  sheetHeading: { fontSize: 18, fontWeight: '600', color: '#333', marginBottom: 16 },
  actionBlock: {
    flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1, borderColor: '#E0E0E0',
    borderRadius: 12, padding: 14, marginBottom: 12, gap: 12,
  },
  actionCheckbox: { paddingTop: 2 },
  actionContent: { flex: 1 },
  actionName: { fontSize: 16, fontWeight: '700', color: '#1A1A1A', marginBottom: 4 },
  actionDetails: { fontSize: 13, color: '#666', lineHeight: 18 },
  // Invoice item rows in action preview
  invoiceItemRow: { marginBottom: 6 },
  invoiceItemName: { fontSize: 14, color: '#1A1A1A', fontWeight: '500' },
  invoiceItemPrice: { fontSize: 13, color: '#075E54', fontWeight: '600', marginTop: 1 },
  invoiceTotalText: { fontSize: 15, fontWeight: '700', color: '#075E54', marginTop: 8, borderTopWidth: 1, borderTopColor: '#E0E0E0', paddingTop: 6 },
  invoiceDueText: { fontSize: 12, color: '#999', marginTop: 2 },
  altRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 4 },
  altLabel: { fontSize: 11, color: '#999' },
  altChip: { backgroundColor: '#E8F5E9', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  altChipText: { fontSize: 11, color: '#2E7D32', fontWeight: '500' },
  actionEditBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  actionEditText: { fontSize: 14, fontWeight: '600', color: '#075E54' },
  insightBox: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#E0F2F1',
    borderLeftWidth: 3, borderLeftColor: '#009688', borderRadius: 8,
    padding: 12, marginBottom: 16, gap: 10,
  },
  insightBoxText: { flex: 1, fontSize: 13, color: '#004D40', lineHeight: 18 },
  sheetButtons: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  confirmAllBtn: {
    flex: 2, backgroundColor: '#075E54', borderRadius: 12,
    paddingVertical: 16, alignItems: 'center',
  },
  confirmAllText: { color: '#FFF', fontSize: 17, fontWeight: '700' },
  editMasterBtn: {
    flex: 1, borderWidth: 2, borderColor: '#075E54', borderRadius: 12,
    paddingVertical: 16, alignItems: 'center',
  },
  editMasterText: { color: '#075E54', fontSize: 17, fontWeight: '700' },
  cancelLink: { alignItems: 'center', paddingVertical: 8 },
  cancelLinkText: { color: '#999', fontSize: 15 },

  // Date edit sheet
  dateField: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5',
    borderRadius: 12, padding: 14, gap: 12, marginBottom: 12,
  },
  dateFieldLabel: { fontSize: 14, color: '#666', fontWeight: '500' },
  dateFieldValue: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
  },
  dateFieldValueText: { fontSize: 15, color: '#1A1A1A', fontWeight: '600' },
  dateDescField: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#F5F5F5',
    borderRadius: 12, padding: 14, gap: 12, marginBottom: 20,
  },
  dateDescInput: { flex: 1, fontSize: 15, color: '#333', minHeight: 40, paddingVertical: 0 },

  // Auto-confirm banner
  bannerContainer: {
    position: 'absolute', bottom: 80, left: 12, right: 12,
    backgroundColor: '#FFF', borderRadius: 12, padding: 14,
    elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 8,
  },
  bannerText: { fontSize: 14, color: '#333', marginBottom: 10 },
  bannerButtons: { flexDirection: 'row', gap: 12 },
  bannerBtn: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#F5F5F5' },
  bannerBtnText: { fontSize: 14, fontWeight: '600', color: '#075E54' },
  bannerTimerBar: { height: 3, backgroundColor: '#075E54', borderRadius: 2, marginTop: 10 },
});
