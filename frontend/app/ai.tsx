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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';

interface AIMessage {
  id: string;
  role: string;
  content: string;
  card_type: string | null;
  card_data: Record<string, any>;
  created_at: string;
}

type SendingState = 'idle' | 'sending' | 'ai_responding';

export default function AIScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const flatListRef = useRef<FlatList>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingState, setSendingState] = useState<SendingState>('idle');
  const [inputText, setInputText] = useState('');
  const [executingActions, setExecutingActions] = useState<Set<string>>(new Set());
  const [sentReminders, setSentReminders] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadConversation();
  }, []);

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

      const res = await fetch(`${backendUrl}/api/ai/conversation`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }

      const data = await res.json();
      setConversationId(data.conversation_id);

      if (data.messages && data.messages.length > 0) {
        setMessages(data.messages);
      } else {
        // Welcome message (E1 — only static message allowed)
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: "Hi! I'm your business assistant. Ask me anything about your customers, payments, or inventory.",
          card_type: 'query_response',
          card_data: {},
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

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sendingState !== 'idle' || !conversationId) return;

    Keyboard.dismiss();
    setInputText('');

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
    setMessages(prev => [...prev, userMsg]);
    setSendingState('sending');

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      setSendingState('ai_responding');
      const token = await getToken();
      if (!token) return;

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${backendUrl}/api/ai/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: text, conversation_id: conversationId }),
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
        setMessages(prev => [...prev, {
  id: `error-${Date.now()}`,
  role: 'assistant',
  content: "I couldn't find matching data for that. Try asking about payments, summary, or customers.",
  card_type: 'query_response',
  card_data: {},
  created_at: new Date().toISOString(),
}]);
setSendingState('idle');
        setSendingState('idle');
        return;
      }

      const aiMsg: AIMessage = {
        id: data.message_id || `ai-${Date.now()}`,
        role: 'assistant',
        content: data.response_text,
        card_type: data.card_type,
        card_data: data.card_data || {},
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, aiMsg]);

      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        Alert.alert('Timeout', "AI took too long. Try again.");
      } else {
        setMessages(prev => [...prev, {
  id: `error-${Date.now()}`,
  role: 'assistant',
  content: "I couldn't find matching data for that. Try asking about payments, summary, or customers.",
  card_type: 'query_response',
  card_data: {},
  created_at: new Date().toISOString(),
}]);
setSendingState('idle');
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

  const renderQueryResponse = (msg: AIMessage) => (
    <View style={styles.aiTextBubble}>
      <Text style={styles.aiTextContent}>{msg.content}</Text>
      <Text style={styles.cardTimestamp}>{formatTime(msg.created_at)}</Text>
    </View>
  );

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
      case 'daily_summary': return renderDailySummary(item);
      case 'payment_reminder': return renderPaymentReminder(item);
      case 'reorder_suggestion': return renderReorderSuggestion(item);
      case 'bank_summary': return renderBankSummary(item);
      case 'collection_insight': return renderCollectionInsight(item);
      case 'query_response':
      default: return renderQueryResponse(item);
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
    <KeyboardAvoidingView
      style={styles.flex1}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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

      {/* Chat area */}
      <View style={styles.chatArea}>
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.chatContent}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
          showsVerticalScrollIndicator={false}
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

      {/* Input bar — wrapped in SafeAreaView for bottom inset */}
      <SafeAreaView style={styles.inputSafeArea} edges={['bottom']}>
        <View style={styles.inputBar}>
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
          <TouchableOpacity style={styles.inputIconDisabled}>
            <Ionicons name="attach" size={22} color="#CCCCCC" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.inputIconDisabled}>
            <Ionicons name="camera-outline" size={22} color="#CCCCCC" />
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
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1, backgroundColor: '#ECE5DD' },
  safeTop: { backgroundColor: '#075E54' },
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
  inputSafeArea: {
    backgroundColor: '#FFFFFF',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
    gap: 8,
  },
  inputIconDisabled: {
    padding: 6,
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
