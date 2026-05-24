import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  ActivityIndicator,
  Alert,
  Linking,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  useWindowDimensions,
  ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';
import VisualizationCard from '../components/charts/VisualizationCard';
import ActionExecutionModal, { ActionData, ActionEntity } from './components/ActionExecutionModal';

interface AIMessage {
  id: string;
  role: string;
  content: string;
  card_type: string | null;
  card_data: Record<string, any>;
  chart_data: Record<string, any> | null;
  next_action: ActionData | null;
  created_at: string;
}

type SendingState = 'idle' | 'sending' | 'ai_responding';

export default function AIScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  // Pagination state — same pattern as customer chat (WhatsApp-style cursor pagination)
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [oldestTimestamp, setOldestTimestamp] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingState, setSendingState] = useState<SendingState>('idle');
  const [inputText, setInputText] = useState('');
  const [executingActions, setExecutingActions] = useState<Set<string>>(new Set());
  const [sentReminders, setSentReminders] = useState<Set<string>>(new Set());
  const [actionModalVisible, setActionModalVisible] = useState(false);
  const [actionModalData, setActionModalData] = useState<ActionData | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [aiRecording, setAiRecording] = useState<Audio.Recording | null>(null);

  // TODO: consolidate handleMenuQuery + handleSendDirect into shared sendAiRequest helper
  // Pure helper — index-based dropdown positioning (no layout measurement needed)
  const DROPDOWN_WIDTH = 220;
  const clampDropdownLeft = (rawLeft: number): number => {
    return Math.max(12, Math.min(rawLeft, screenWidth - DROPDOWN_WIDTH - 12));
  };
  const MENU_CATEGORIES = [
    { id: 'finance', label: '💰 Finance', items: [
      { id: 'collections_today', label: '📥 Collections Today' },
      { id: 'total_outstanding', label: '🔴 Total Outstanding' },
      { id: 'revenue_this_month', label: '📊 Revenue This Month' },
      { id: 'invoices_due_this_week', label: '📋 Invoices Due This Week' },
      { id: 'weekly_trend', label: '📈 Weekly Trend' },
    ]},
    { id: 'customers', label: '👥 Customers', items: [
      { id: 'top_customers', label: '🏆 Top Customers' },
      { id: 'follow_up_today', label: '📞 Follow Up Today' },
      { id: 'risk_alerts', label: '⚠️ Risk Alerts' },
      { id: 'gone_silent', label: '🔇 Gone Silent' },
    ]},
    { id: 'products', label: '📦 Products', items: [
      { id: 'top_sellers', label: '⭐ Top Sellers' },
      { id: 'low_stock', label: '🔴 Low Stock' },
      { id: 'slow_moving', label: '🐌 Slow Moving' },
    ]},
    { id: 'ops', label: '⚙️ Ops', items: [
      { id: 'deliveries_today', label: '🚚 Deliveries Today' },
      { id: 'expiring_quotes', label: '📄 Expiring Quotes' },
      { id: 'todays_tasks', label: "✅ Today's Tasks" },
    ]},
    { id: 'suppliers', label: '🏭 Suppliers', items: [
      { id: 'what_i_owe', label: '💸 What I Owe' },
      { id: 'overdue_payables', label: '⏰ Overdue Payables' },
      { id: 'top_supplier', label: '🥇 Top Supplier' },
    ]},
  ];
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const { width: screenWidth } = useWindowDimensions();
  const [activeMenuIndex, setActiveMenuIndex] = useState<number>(0);
  const pillPositions = useRef<Record<number, number>>({});
  const [dropdownLeft, setDropdownLeft] = useState<number>(12);
  const sendMenuQuery = (menuId: string, label: string) => {
    if (sendingState !== 'idle' || !conversationId) return;
    setActiveMenuId(null);
    const tempId = `menu-${Date.now()}`;
    const userMsg: AIMessage = {
      id: tempId,
      role: 'user',
      content: label,
      card_type: null,
      card_data: {},
      chart_data: null,
      next_action: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [userMsg, ...prev]); // inverted: prepend = visually bottom
    setSendingState('sending');
    handleMenuQuery(menuId);
  };
  const handleMenuQuery = async (menuId: string) => {
    try {
      setSendingState('ai_responding');
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      const res = await fetch(`${backendUrl}/api/home/ai-query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ menu_id: menuId, ai_conversation_id: conversationId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (data.error) {
        setMessages(prev => [{
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: "Could not load this data. Please try again.",
          card_type: 'query_response',
          card_data: {},
          chart_data: null,
          next_action: null,
          created_at: new Date().toISOString(),
        }, ...prev]);
        return;
      }
      const aiMsg: AIMessage = {
        id: data.message_id || `ai-${Date.now()}`,
        role: 'assistant',
        content: data.response,
        card_type: data.message_type || 'query_response',
        card_data: {},
        chart_data: data.chart_data || null,
        next_action: data.next_action || null,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [aiMsg, ...prev]); // inverted: prepend = visually bottom
    } catch (error: any) {
      if (error.name === 'AbortError') {
        Alert.alert('Timeout', "This query took too long. Try again.");
      } else {
        setMessages(prev => [{
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: "Something went wrong. Please try again.",
          card_type: 'query_response',
          card_data: {},
          chart_data: null,
          next_action: null,
          created_at: new Date().toISOString(),
        }]);
      }
    } finally {
      setSendingState('idle');
    }
  };

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const s2 = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadConversation();
    }, [])
  );

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

  const loadConversation = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      // Step 1: Get existing org AI conversations
      const listRes = await fetch(`${backendUrl}/api/home/ai-conversations`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (listRes.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }
      const listData = await listRes.json();
      let convId: string | null = null;
      if (listData.conversations && listData.conversations.length > 0) {
        convId = listData.conversations[0].id;
      } else {
        // Step 2: No conversation exists — create one
        const createRes = await fetch(`${backendUrl}/api/home/ai-conversations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        const createData = await createRes.json();
        convId = createData.conversation?.id || null;
      }
      if (!convId) {
        console.error('[AI] Could not get or create conversation');
        setLoading(false);
        return;
      }
      setConversationId(convId);
      // Step 3: Load messages for this conversation
      const msgRes = await fetch(`${backendUrl}/api/home/ai-messages?ai_conversation_id=${convId}&limit=30`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const msgData = await msgRes.json();
      if (msgData.messages && msgData.messages.length > 0) {
        const mapped = msgData.messages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          card_type: m.metadata?.message_type || 'query_response',
          card_data: {},
          chart_data: m.metadata?.chart_data || null,
          next_action: m.metadata?.next_action || null,
          created_at: m.created_at,
        }));
        // DESC order from backend + inverted FlatList = natural bottom anchoring (canonical chat pattern)
        // Same architecture as customer chat. No scrollToEnd needed — inverted handles viewport.
        // TODO: extract normalizeOrgAiMessage to /shared/chat/normalize.ts
        setMessages(mapped);
        setHasMore(msgData.has_more || false);
        if (mapped.length > 0) setOldestTimestamp(mapped[mapped.length - 1].created_at);
      } else {
        // Welcome message
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: "Hi! I'm your business assistant. Tap a category above to get insights about your business.",
          card_type: 'query_response',
          card_data: {},
          chart_data: null,
          next_action: null,
          created_at: new Date().toISOString(),
        }]);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Load AI conversation error:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  // ── normalizeOrgAiMessage — canonical message shape ─────────
  // TODO: extract to /shared/chat/normalize.ts alongside customer chat normalization
  const normalizeOrgAiMessage = (m: any) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    card_type: m.metadata?.message_type || 'query_response',
    card_data: {},
    chart_data: m.metadata?.chart_data || null,
    next_action: m.metadata?.next_action || null,
    created_at: m.created_at,
  });

  // ── Load older messages (WhatsApp-style cursor pagination) ───
  // Same pattern as customer chat loadOlderMessages.
  // inverted FlatList: appending older msgs to array = appearing above visually. Correct.
  const loadOlderMessages = async () => {
    if (!hasMore || loadingOlderRef.current || !oldestTimestamp || !conversationId) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(
        `${backendUrl}/api/home/ai-messages?ai_conversation_id=${conversationId}&before=${encodeURIComponent(oldestTimestamp)}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const older = data.messages || [];
      if (older.length > 0) {
        setMessages(prev => {
          const existingIds = new Set(prev.map((m: any) => m.id));
          const uniqueOlder = older
            .filter((m: any) => !existingIds.has(m.id))
            .map(normalizeOrgAiMessage);
          return [...prev, ...uniqueOlder];
        });
        setOldestTimestamp(older[older.length - 1].created_at);
        setHasMore(data.has_more || false);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error('loadOlderMessages error:', err);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const openActionModal = (action: ActionData) => {
    setActionModalData(action);
    setActionModalVisible(true);
  };

  const closeActionModal = () => {
    setActionModalVisible(false);
    setActionModalData(null);
  };

  const handleSimulatedConfirm = (checkedEntities: ActionEntity[], message: string) => {
    const names = checkedEntities.map(e => e.customer_name);
    const nameStr = names.length === 1
      ? names[0]
      : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
    const confirmMsg: AIMessage = {
      id: `sim-${Date.now()}`,
      role: 'assistant',
      content: `✓ Simulated: Reminder sent to ${nameStr}. Real sending will be wired in the next pipeline phase.`,
      card_type: 'system_event',
      card_data: {},
      chart_data: null,
      next_action: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev: any) => [confirmMsg, ...prev]);
    closeActionModal();
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sendingState !== 'idle' || !conversationId) return;
    Keyboard.dismiss();
    setInputText('');
    await handleSendDirect(text);
  };

  const handleSendDirect = async (text: string) => {
    if (!text || sendingState !== 'idle' || !conversationId) return;

    // Optimistic render
    const tempId = `temp-${Date.now()}`;
    const userMsg: AIMessage = {
      id: tempId,
      role: 'user',
      content: text,
      card_type: null,
      card_data: {},
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [userMsg, ...prev]); // inverted: prepend = visually bottom
    setSendingState('sending');

    try {
      setSendingState('ai_responding');
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${backendUrl}/api/home/ai-query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: text, ai_conversation_id: conversationId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 429) {
        Alert.alert('Rate Limited', 'Please wait before sending another message.');
        setSendingState('idle');
        return;
      }
      if (res.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }
      const data = await res.json();
      if (data.error) {
        setMessages(prev => [{
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: "I couldn't process that request. Please try again.",
          card_type: 'query_response',
          card_data: {},
          chart_data: null,
          next_action: null,
          created_at: new Date().toISOString(),
        }]);
        setSendingState('idle');
        return;
      }
      const aiMsg: AIMessage = {
        id: data.message_id || `ai-${Date.now()}`,
        role: 'assistant',
        content: data.response,
        card_type: data.message_type || 'query_response',
        card_data: {},
        chart_data: data.chart_data || null,
        next_action: data.next_action || null,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [aiMsg, ...prev]); // inverted: prepend = visually bottom
    } catch (error: any) {
      if (error.name === 'AbortError') {
        Alert.alert('Timeout', "AI took too long. Try again.");
      } else {
        setMessages(prev => [{
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: "Something went wrong. Please try again.",
          card_type: 'query_response',
          card_data: {},
          chart_data: null,
          next_action: null,
          created_at: new Date().toISOString(),
        }]);
      }
    } finally {
      setSendingState('idle');
    }
  };

  const handleSendReminders = async (msgId: string, customerData: Array<{ id: string; name: string; amount: number }>) => {
    if (sentReminders.has(msgId) || executingActions.has(msgId)) return;

    const names = customerData.map(c => c.name).join(', ');
    Alert.alert(
      'Send Reminders',
      `Send payment reminders to ${customerData.length} customers?\n\n${names}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: async () => {
            setExecutingActions(prev => new Set(prev).add(msgId));
            try {
              const token = await getToken();
              if (!token) return;

              const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
              const res = await fetch(`${backendUrl}/api/reminders/send-bulk`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ customer_ids: customerData.map(c => c.id) }),
              });
              const data = await res.json();

              // Open WhatsApp links
              if (data.whatsapp_urls) {
                for (const link of data.whatsapp_urls) {
                  try { await Linking.openURL(link.url); } catch {}
                }
              }

              setSentReminders(prev => new Set(prev).add(msgId));
            } catch (err) {
              Alert.alert('Error', 'Failed to send reminders.');
            } finally {
              setExecutingActions(prev => {
                const next = new Set(prev);
                next.delete(msgId);
                return next;
              });
            }
          },
        },
      ]
    );
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const formatCurrency = (amount: number) => {
    return '₹' + amount.toLocaleString('en-IN');
  };

  // ── Card renderers ─────────────────────────────────────
  const renderDailySummary = (msg: AIMessage) => {
    const cd = msg.card_data || {};
    return (
      <View style={styles.cardContainer}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>📊</Text>
          <Text style={styles.cardTitle}>Today's Summary</Text>
        </View>
        <Text style={styles.bulletText}>• {formatCurrency(cd.pending_amount || 0)} pending payments</Text>
        <Text style={styles.bulletText}>• {cd.delivery_count || 0} deliveries due</Text>
        <Text style={styles.bulletText}>• {cd.quote_count || 0} quote expiring</Text>
        <Text style={styles.cardTimestamp}>{formatTime(msg.created_at)}</Text>
      </View>
    );
  };

  const renderPaymentReminder = (msg: AIMessage) => {
    const customers = msg.card_data?.customers || [];
    return (
      <View style={[styles.cardContainer, styles.cardBordered]}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>🔔</Text>
          <Text style={styles.cardTitle}>You have {customers.length} payment reminders today</Text>
        </View>
        {customers.map((c: any, i: number) => (
          <View key={i} style={styles.reminderRow}>
            <Text style={styles.reminderName}>{c.name}</Text>
            <Text style={styles.reminderAmount}>{formatCurrency(c.amount)}</Text>
          </View>
        ))}
        {sentReminders.has(msg.id) ? (
          <View style={styles.ctaSentButton}>
            <Text style={styles.ctaSentText}>Reminders Sent ✓</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.ctaButton}
            disabled={executingActions.has(msg.id)}
            onPress={() => handleSendReminders(msg.id, customers)}
          >
            {executingActions.has(msg.id) ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.ctaButtonText}>➤ Send Reminders</Text>
            )}
          </TouchableOpacity>
        )}
        <Text style={styles.cardTimestamp}>{formatTime(msg.created_at)}</Text>
      </View>
    );
  };

  const renderReorderSuggestion = (msg: AIMessage) => (
    <View style={styles.cardContainer}>
      <View style={styles.aiInsightBadge}>
        <Text style={styles.aiInsightText}>AI INSIGHT</Text>
      </View>
      <View style={styles.cardHeader}>
        <Text style={styles.cardIcon}>📦</Text>
        <Text style={styles.cardTitle}>Reorder suggestion</Text>
      </View>
      <Text style={styles.cardBody}>{msg.content}</Text>
      <TouchableOpacity
        style={styles.ctaOutlineButton}
        onPress={() => router.push('/purchase-order/new')}
      >
        <Text style={styles.ctaOutlineText}>Create Purchase Order</Text>
      </TouchableOpacity>
      <Text style={styles.cardTimestamp}>{formatTime(msg.created_at)}</Text>
    </View>
  );

  const renderBankSummary = (msg: AIMessage) => {
    const accounts = msg.card_data?.accounts || [];
    return (
      <View style={styles.cardContainer}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>🏦</Text>
          <Text style={styles.cardTitle}>Today's Bank Summary</Text>
        </View>
        {accounts.map((a: any, i: number) => (
          <View key={i} style={styles.reminderRow}>
            <Text style={styles.reminderName}>{a.name}</Text>
            <Text style={styles.reminderAmount}>{formatCurrency(a.balance || a.amount || 0)}</Text>
          </View>
        ))}
        <TouchableOpacity onPress={() => router.push('/bank/summary')}>
          <Text style={styles.viewDetailsLink}>View Details</Text>
        </TouchableOpacity>
        <Text style={styles.cardTimestamp}>{formatTime(msg.created_at)}</Text>
      </View>
    );
  };

  const renderCollectionInsight = (msg: AIMessage) => (
    <View style={styles.insightCard}>
      <Text style={styles.insightText}>{msg.content}</Text>
      <Text style={styles.insightTimestamp}>{formatTime(msg.created_at)}</Text>
    </View>
  );

  const renderQueryResponse = (msg: AIMessage) => {
    const na = msg.next_action;
    const hasAction = na && na.type && na.type !== 'none' && na.entities && na.entities.length > 0;
    const isBulk = na?.execution_mode === 'bulk';
    return (
      <View style={styles.aiTextBubble}>
        <Text style={styles.aiTextContent}>{msg.content}</Text>
        {msg.chart_data && (
          <VisualizationCard data={msg.chart_data} />
        )}
        {na?.text && (
          <Text style={styles.nextActionText}>→ {na.text}</Text>
        )}
        {hasAction && (
          <TouchableOpacity
            style={styles.actionTriggerBtn}
            onPress={() => openActionModal(na!)}
          >
            <Text style={styles.actionTriggerBtnText}>
              {isBulk
                ? `📨 Send Reminders to All (${na!.entities.length})`
                : `📨 Send Reminder to ${na!.entities[0]?.customer_name}`}
            </Text>
          </TouchableOpacity>
        )}
        <Text style={styles.cardTimestamp}>{formatTime(msg.created_at)}</Text>
      </View>
    );
  };

  const renderUserMessage = (msg: AIMessage) => (
    <View style={styles.userBubbleContainer}>
      <View style={styles.userBubble}>
        <Text style={styles.userBubbleText}>{msg.content}</Text>
        <Text style={styles.userTimestamp}>{formatTime(msg.created_at)}</Text>
      </View>
    </View>
  );

  const renderMessage = ({ item }: { item: AIMessage }) => {
    if (item.role === 'user') return renderUserMessage(item);

    switch (item.card_type) {
      case 'clarification': return (
        <View style={styles.cardContainer}>
          <Text style={{ fontSize: 14, color: '#333333', marginBottom: 8 }}>
            {item.content || 'Which customer do you mean?'}
          </Text>
        </View>
      );
      case 'daily_summary': return renderDailySummary(item);
      case 'payment_reminder': return renderPaymentReminder(item);
      case 'reorder_suggestion': return renderReorderSuggestion(item);
      case 'bank_summary': return renderBankSummary(item);
      case 'collection_insight': return renderCollectionInsight(item);
      case 'query_response':
      default: return renderQueryResponse(item);
    }
  };

  const handleAiMicPress = async () => {
    try {
      if (aiRecording) {
        await aiRecording.stopAndUnloadAsync();
        const uri = aiRecording.getURI();
        setAiRecording(null);
        if (uri) {
          const fileName = `ai_audio_${Date.now()}.m4a`;
          const token = await getToken();
          const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
          const formData = new FormData();
          formData.append('file', { uri, name: fileName, type: 'audio/x-m4a' } as any);
          const res = await fetch(`${backendUrl}/api/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });
          if (res.ok) {
            const data = await res.json();
            handleSendDirect(`[Voice note: ${data.url}]`);
          }
        }
      } else {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') return;
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY
        );
        setAiRecording(recording);
      }
    } catch (e) {
      console.error('AI mic error:', e);
      setAiRecording(null);
    }
  };

  // ── Loading state ──────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.safeTop} edges={['top']}>
        <View style={styles.header}>
          <Ionicons name="sparkles" size={22} color="#FFFFFF" />
          <View style={styles.headerTextGroup}>
            <Text style={styles.headerTitle}>AI</Text>
            <Text style={styles.headerSubtitle}>Your business assistant</Text>
          </View>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
    <KeyboardAvoidingView
      style={styles.flex1}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
keyboardVerticalOffset={80}
    >
      {/* Header */}
      <SafeAreaView style={styles.safeTop} edges={['top']}>
        <View style={styles.header}>
          <Ionicons name="sparkles" size={22} color="#FFFFFF" />
          <View style={styles.headerTextGroup}>
            <Text style={styles.headerTitle}>AI</Text>
            <Text style={styles.headerSubtitle}>Your business assistant</Text>
          </View>
          <TouchableOpacity style={styles.headerMenuBtn}>
            <Ionicons name="ellipsis-vertical" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Category tabs */}
      <View style={styles.pillsContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillsScroll}>
          {MENU_CATEGORIES.map((cat, index) => (
            <TouchableOpacity
              key={cat.id}
              style={[styles.pill, activeMenuId === cat.id && styles.pillActive]}
              onPress={() => {
                if (activeMenuId === cat.id) {
                  setActiveMenuId(null);
                } else {
                  setActiveMenuId(cat.id);
                  setActiveMenuIndex(index);
                  setDropdownLeft(clampDropdownLeft(pillPositions.current[index] || 12));
                }
              }}
              disabled={sendingState !== 'idle'}
              onLayout={(e) => { pillPositions.current[index] = e.nativeEvent.layout.x; }}
              activeOpacity={0.7}
            >
              <Text style={styles.pillLabel}>{cat.label} {activeMenuId === cat.id ? '▲' : '▼'}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
      {/* Submenu absolute overlay */}
      {activeMenuId && (
        <>
          <TouchableOpacity
            style={styles.menuBackdrop}
            onPress={() => setActiveMenuId(null)}
            activeOpacity={1}
          />
          <View style={[styles.submenuOverlay, { left: dropdownLeft }]}>
            <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
              {(() => {
                const cat = MENU_CATEGORIES.find(c => c.id === activeMenuId);
                if (!cat) return null;
                return cat.items.map(item => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.submenuItem}
                    onPress={() => sendMenuQuery(item.id, item.label)}
                    disabled={sendingState !== 'idle'}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.submenuItemText}>{item.label}</Text>
                  </TouchableOpacity>
                ));
              })()}
            </ScrollView>
          </View>
        </>
      )}


      {/* Chat area */}
      <View style={styles.chatArea}>
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.chatContent, { paddingBottom: 120 }]}
          // inverted={true}: WhatsApp-style bottom anchoring. Newest message at index 0 (visually bottom).
          // Eliminates scrollToEnd timing dependencies. Aligns with customer chat architecture.
          // TODO: extract shared chat config to /shared/chat/ when pagination is added.
          inverted={true}
          showsVerticalScrollIndicator={false}
          onEndReached={() => {
            if (hasMore && !loadingOlderRef.current) loadOlderMessages();
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={loadingOlder ? (
            <ActivityIndicator size="small" color="#075E54" style={{ marginVertical: 8 }} />
          ) : null}
        />

        {/* Typing indicator */}
        {sendingState === 'ai_responding' && (
          <View style={styles.typingContainer}>
            <View style={styles.typingBubble}>
              <View style={styles.typingDots}>
                <View style={[styles.dot, styles.dot1]} />
                <View style={[styles.dot, styles.dot2]} />
                <View style={[styles.dot, styles.dot3]} />
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Input bar */}
      <View style={[styles.inputBar, { paddingBottom: keyboardVisible ? 4 : insets.bottom + 4 }]}>
        <TextInput
          style={styles.textInput}
          placeholder="Ask AI about your business..."
          placeholderTextColor="#999999"
          value={inputText}
          onChangeText={setInputText}
          editable={sendingState === 'idle'}
          maxLength={2000}
          multiline
        />
        <TouchableOpacity
          onPress={handleAiMicPress}
          style={[styles.sendButton, { marginRight: 6, backgroundColor: aiRecording ? '#e53935' : undefined }]}
        >
          <Ionicons
            name={aiRecording ? 'stop' : 'mic'}
            size={20}
            color="#fff"
          />
        </TouchableOpacity>
        {inputText.trim().length > 0 ? (
          <TouchableOpacity
            style={styles.sendButton}
            onPress={handleSend}
            disabled={sendingState !== 'idle'}
          >
            <Ionicons name="send" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        ) : (
          <View style={styles.micButtonDisabled}>
            <Ionicons name="mic" size={20} color="#CCCCCC" />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>

    <ActionExecutionModal
      visible={actionModalVisible}
      action={actionModalData}
      onClose={closeActionModal}
      onSimulatedConfirm={handleSimulatedConfirm}
    />
    </>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: '#ECE5DD' },
  safeTop: { backgroundColor: '#075E54' },
  // Quick pills
  pillsContainer: {
    backgroundColor: '#F5F5F0',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    zIndex: 20,
  },
  pillsScroll: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  pillIcon: { fontSize: 14 },
  pillLabel: { fontSize: 13, fontWeight: '500', color: '#1A1A1A' },
  pillActive: { backgroundColor: '#E8F5E9', borderColor: '#075E54', borderWidth: 1 },
  submenuContainer: { backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E0E0E0', paddingVertical: 4, maxHeight: 220, elevation: 3, zIndex: 10 },
  menuBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 },
  // TODO: replace hardcoded top offset with measured header/layout constant
  // heuristic offset below pills row — adjust if header height changes
  submenuOverlay: { position: 'absolute', top: 148, width: 220, backgroundColor: '#FFFFFF', zIndex: 30, elevation: 30, maxHeight: 220, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8 },
  submenuItem: { paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  submenuItemText: { fontSize: 14, color: '#1A1A1A' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  headerTextGroup: { flex: 1 },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#FFFFFF' },
  headerSubtitle: { fontSize: 12, color: '#FFFFFFCC' },
  headerMenuBtn: { padding: 4 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#ECE5DD' },
  chatArea: { flex: 1, backgroundColor: '#ECE5DD' },
  chatContent: { padding: 12, paddingBottom: 8 },

  // ── AI cards ───────────────────────────────────────────
  cardContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    maxWidth: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  cardBordered: {
    borderLeftWidth: 4,
    borderLeftColor: '#075E54',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
  cardIcon: { fontSize: 18 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#1A1A1A', flex: 1 },
  cardBody: { fontSize: 14, color: '#333333', lineHeight: 20, marginBottom: 12 },
  bulletText: { fontSize: 14, color: '#333333', marginBottom: 4, paddingLeft: 4 },
  cardTimestamp: { fontSize: 11, color: '#999999', textAlign: 'right', marginTop: 8 },

  reminderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#F0F0F0',
  },
  reminderName: { fontSize: 14, fontWeight: '500', color: '#1A1A1A' },
  reminderAmount: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },

  ctaButton: {
    backgroundColor: '#075E54',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  ctaButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  ctaSentButton: {
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  ctaSentText: { color: '#388E3C', fontSize: 15, fontWeight: '600' },

  ctaOutlineButton: {
    borderWidth: 1.5,
    borderColor: '#075E54',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  ctaOutlineText: { color: '#075E54', fontSize: 15, fontWeight: '700' },

  viewDetailsLink: {
    color: '#075E54',
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
    textAlign: 'center',
    marginTop: 10,
  },

  aiInsightBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: '#075E54',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  aiInsightText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

  // ── Collection insight card ────────────────────────────
  insightCard: {
    backgroundColor: '#B2DFDB',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    maxWidth: '88%',
  },
  insightText: { fontSize: 14, color: '#004D40', lineHeight: 20 },
  insightTimestamp: { fontSize: 11, color: '#00695C', textAlign: 'right', marginTop: 8 },

  // ── AI text bubble ─────────────────────────────────────
  aiTextBubble: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    maxWidth: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  aiTextContent: { fontSize: 14, color: '#333333', lineHeight: 20 },
  nextActionText: { fontSize: 13, color: '#E65100', marginTop: 8, fontStyle: 'italic' },
  actionTriggerBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  actionTriggerBtnText: { color: '#FFF', fontSize: 13, fontWeight: '700' },

  // ── User bubble ────────────────────────────────────────
  userBubbleContainer: { alignItems: 'flex-end', marginBottom: 12 },
  userBubble: {
    backgroundColor: '#DCF8C6',
    borderRadius: 12,
    padding: 12,
    maxWidth: '80%',
  },
  userBubbleText: { fontSize: 14, color: '#1A1A1A', lineHeight: 20 },
  userTimestamp: { fontSize: 11, color: '#999999', textAlign: 'right', marginTop: 4 },

  // ── Typing indicator ───────────────────────────────────
  typingContainer: { paddingHorizontal: 12, paddingBottom: 8 },
  typingBubble: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    width: 70,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  typingDots: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#999999' },
  dot1: { opacity: 0.4 },
  dot2: { opacity: 0.6 },
  dot3: { opacity: 0.8 },

  // ── Input bar ──────────────────────────────────────────
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
    gap: 6,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    color: '#333333',
    maxHeight: 100,
    paddingVertical: 8,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#075E54',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micButtonDisabled: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F0F0F0',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
