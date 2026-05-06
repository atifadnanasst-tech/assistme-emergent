import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
  Keyboard, Modal, Pressable, ScrollView, InteractionManager,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { authService } from '../../lib/auth';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Audio } from 'expo-av';

// ── Types ────────────────────────────────────────────────────
interface CustomerData {
  id: string; name: string; initials: string; avatar_color: string;
  outstanding_balance: number | null; health_score: number | null; status: string; phone?: string;
}
interface ChatMessage {
  id: string; role: string; content: string; created_at: string;
  sender_type: string | null; visibility: string; message_type: string;
  card_type: string | null; card_data: Record<string, any>;
  preview_text: string | null;
  delivery_status?: 'sent' | 'delivered' | 'read';
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
  // Unresolved product prices, GST and removed items
  const [unresolvedPrices, setUnresolvedPrices] = useState<Record<string, string>>({});
  const [unresolvedGst, setUnresolvedGst] = useState<Record<string, string>>({});
  const [removedItems, setRemovedItems] = useState<Set<string>>(new Set());
  // Date edit sheet
  const [dateEditVisible, setDateEditVisible] = useState(false);
  const [dateEditAction, setDateEditAction] = useState<any>(null);
  const [dateEditValue, setDateEditValue] = useState(new Date());
  const [dateEditDesc, setDateEditDesc] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  // AI query
  const [aiQueryText, setAiQueryText] = useState('');
  const [aiQuerying, setAiQuerying] = useState(false);
  // Pagination
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [oldestTimestamp, setOldestTimestamp] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);
  const hasTriggeredInitialEndReached = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollOffsetRef = useRef(0);

  // Attachment sheet
  const [attachSheetVisible, setAttachSheetVisible] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    uri: string; name: string; mime_type: string; size?: number;
  } | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [imageViewerUri, setImageViewerUri] = useState<string | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);

  const inputRef = useRef<any>(null);
  const channelRef = useRef<any>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // ── Attachment handlers ────────────────────────────────────
  // Gallery picker
  // Audio playback
  const handlePlayAudio = async (uri: string) => {
    try {
      if (playingUri === uri) {
        await sound?.stopAsync();
        await sound?.unloadAsync();
        setSound(null);
        setPlayingUri(null);
        return;
      }
      if (sound) {
        await sound.stopAsync();
        await sound.unloadAsync();
        setSound(null);
        setPlayingUri(null);
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound: newSound } = await Audio.Sound.createAsync({ uri });
      setSound(newSound);
      setPlayingUri(uri);
      await newSound.playAsync();
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          newSound.unloadAsync();
          setSound(null);
          setPlayingUri(null);
        }
      });
    } catch (e) {
      console.error("Audio playback error:", e);
      Alert.alert("Error", "Could not play audio.");
    }
  };

  const handlePickGallery = async () => {
    setAttachSheetVisible(false);
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.8,
      });
      if (result.canceled) return;
      if (!result.assets || !result.assets[0]) {
        Alert.alert('Error', 'Could not process selection.');
        return;
      }
      const asset = result.assets[0];
      setAttachmentPreview({
        uri: asset.uri,
        name: asset.fileName || 'image.jpg',
        mime_type: asset.mimeType || 'image/jpeg',
        size: asset.fileSize ?? undefined,
      });
    } catch (e) {
      console.error('Gallery picker error:', e);
      Alert.alert('Error', 'Could not open photo library.');
    }
  };

  // Camera picker
  const handleOpenCamera = async () => {
    setAttachSheetVisible(false);
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow camera access.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: false,
        quality: 0.8,
      });
      if (result.canceled) return;
      if (!result.assets || !result.assets[0]) {
        Alert.alert('Error', 'Could not process photo.');
        return;
      }
      const asset = result.assets[0];
      setAttachmentPreview({
        uri: asset.uri,
        name: asset.fileName || 'photo.jpg',
        mime_type: asset.mimeType || 'image/jpeg',
        size: asset.fileSize ?? undefined,
      });
    } catch (e) {
      console.error('Camera error:', e);
      Alert.alert('Error', 'Could not open camera.');
    }
  };

  // Document picker
  const handlePickDocument = async () => {
    setAttachSheetVisible(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      if (!result.assets || !result.assets[0]) {
        Alert.alert('Error', 'Could not process document.');
        return;
      }
      const asset = result.assets[0];
      setAttachmentPreview({
        uri: asset.uri,
        name: asset.name,
        mime_type: asset.mimeType || 'application/octet-stream',
        size: asset.size ?? undefined,
      });
    } catch (e) {
      console.error('Document picker error:', e);
      Alert.alert('Error', 'Could not open document picker.');
    }
  };

  // Audio recording — tap to start, tap to stop
  const handleAudioRecording = async () => {
    if (isRecording) {
      // Stop recording — close sheet
      setAttachSheetVisible(false);
      try {
        const rec = recording;
        setRecording(null);
        setIsRecording(false);
        await rec?.stopAndUnloadAsync();
        const uri = rec?.getURI();
        if (uri) {
          setAttachmentPreview({
            uri,
            name: `audio_${Date.now()}.m4a`,
            mime_type: 'audio/*',
          });
        }
      } catch (e) {
        console.error('Stop recording error:', e);
        setIsRecording(false);
        setRecording(null);
      }
    } else {
      // Start recording — do NOT close sheet
      try {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Required', 'Please allow microphone access.');
          return;
        }
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          staysActiveInBackground: false,
        });
        const { recording: newRecording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY
        );
        setRecording(newRecording);
        setIsRecording(true);
      } catch (e) {
        console.error('Start recording error:', e);
        Alert.alert('Error', 'Could not start recording.');
      }
    }
  };

  const debouncedLoadChat = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadChat(false);
    }, 500);
  }, []);

  // ── Auth helper ────────────────────────────────────────────
  const getToken = async () => {
    let token = await authService.getAccessToken();
    if (!token) {
      const refreshed = await authService.refreshSession();
      if (!refreshed) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return null;
      }
      token = await authService.getAccessToken();
      if (!token) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return null;
      }
    }
    return token;
  };

  // ── Load conversation ──────────────────────────────────────
  useEffect(() => { loadChat(); }, [customer_id]);

  // ── Supabase Realtime subscription ─────────────────────────
  useEffect(() => {
    if (!conversationId) return;

    const setupRealtime = async () => {
      const orgId = await authService.getOrganisationId();
      if (!orgId) return;

      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }

      channelRef.current = supabase
        .channel(`org-${orgId}`)
        .on('broadcast', { event: 'message_created' }, (payload) => {
          const targetConvId = payload?.payload?.conversation_id;
          if (!targetConvId || targetConvId === conversationId) {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(async () => {
              const token = await getToken();
              if (!token || !customer_id) return;
              const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
              const res = await fetch(`${backendUrl}/api/chat/${customer_id}?mark_read=false`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (!res.ok) return;
              const data = await res.json();
              const incoming = data.messages || [];
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id));
                const newOnly = incoming.filter((m: any) => !existingIds.has(m.id));
                const deduped = newOnly.filter((m: any) => !existingIds.has(m.id));
                // Backend currently returns ASC (oldest→newest).
                // Reverse so newest is at index 0 for inverted list.
                // If backend order changes in future, this line must be revisited.
                return deduped.length > 0 ? [...deduped.reverse(), ...prev] : prev;
              });
            }, 500);
          }
        })
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `organisation_id=eq.${orgId}` },
          () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(async () => {
              const token = await getToken();
              if (!token || !customer_id) return;
              const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
              const res = await fetch(`${backendUrl}/api/chat/${customer_id}?mark_read=false`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (!res.ok) return;
              const data = await res.json();
              const incoming = data.messages || [];
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id));
                const newOnly = incoming.filter((m: any) => !existingIds.has(m.id));
                const deduped = newOnly.filter((m: any) => !existingIds.has(m.id));
                // Backend currently returns ASC (oldest→newest).
                // Reverse so newest is at index 0 for inverted list.
                // If backend order changes in future, this line must be revisited.
                return deduped.length > 0 ? [...deduped.reverse(), ...prev] : prev;
              });
            }, 500);
          }
        )
        .subscribe();
    };

    setupRealtime();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [conversationId]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);
  useEffect(() => {
    return () => {
      if (sound) { sound.unloadAsync(); }
    };
  }, [sound]);


  const loadChat = async (markRead: boolean = true) => {
    try {
      const token = await getToken();
      if (!token || !customer_id) return;

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const markReadParam = markRead ? '' : '?mark_read=false';
      const res = await fetch(`${backendUrl}/api/chat/${customer_id}${markReadParam}`, {
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
      setMessages([...(data.messages || [])].reverse());
      setHasMore(data.has_more || false);
      if (data.messages?.length > 0) {
        setOldestTimestamp(data.messages[0].created_at);
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('Load chat error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadOlderMessages = async () => {
    if (!hasMore || loadingOlderRef.current || !oldestTimestamp) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const token = await getToken();
      if (!token || !customer_id) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(
        `${backendUrl}/api/chat/${customer_id}?mark_read=false&before=${encodeURIComponent(oldestTimestamp)}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const older = data.messages || [];
      if (older.length > 0) {
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const uniqueOlder = older.filter((m: any) => !existingIds.has(m.id));
          // Backend currently returns ASC (oldest→newest).
          // Reverse so oldest appear at bottom of inverted list.
          // If backend order changes in future, this line must be revisited.
          return [...prev, ...uniqueOlder.reverse()];
        });
        setOldestTimestamp(older[0].created_at);
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

  // ── Send message ───────────────────────────────────────────
  const handleSend = async () => {
    const text = inputText.trim();
    const attachment = attachmentPreview;
    if ((!text && !attachmentPreview) || sending || !conversationId) return;
    inputRef.current?.focus();
    setInputText('');

    const tempId = `temp-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId, role: 'assistant', content: text,
      created_at: new Date().toISOString(), sender_type: 'owner',
      visibility: 'both', message_type: 'text', card_type: null,
      card_data: {}, preview_text: text.substring(0, 50),
      delivery_status: 'sent',
      metadata: {
        ...(attachmentPreview ? {
          message_type: attachmentPreview.mime_type?.startsWith?.('image') ? 'image' :
                        attachmentPreview.mime_type?.startsWith?.('audio') ? 'audio' : 'file',
          attachment: {
            uri: attachmentPreview.uri,
            name: attachmentPreview.name,
            mime_type: attachmentPreview.mime_type,
            size: attachmentPreview.size,
          }
        } : {})
      },
    };
    setMessages(prev => [optimistic, ...prev]);
    setSending(true);
    // moved: attachment cleared after send

    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/message`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text || attachment?.name || 'Attachment',
          conversation_id: conversationId,
          metadata: optimistic.metadata || {}
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        setMessages(prev => prev.map(m =>
          m.id === tempId ? { ...m, id: data.message_id, created_at: data.created_at, delivery_status: 'delivered' } : m
        ));
        setAttachmentPreview(null);
      } else {
        setMessages(prev => prev.filter(m => m.id !== tempId));
      setAttachmentPreview(null);
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

    // BUG FIX 1: Clear all previous spark state before making new API call
    setPreviewDraftId(null);
    setPreviewActions([]);
    setPreviewInsight(null);
    setCheckedActions(new Set());
    setPreviewVisible(false);

    // Do NOT add instruction to messages — it is NOT a chat message to the customer.
    // The sparkProcessing indicator shows the owner that AI is working.

    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      // ALWAYS make fresh POST to /api/chat/:customer_id/spark
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

      // Step 1: validate and insert unresolved products
      for (const action of previewActions) {
        if (action.action_type !== 'create_invoice' && action.action_type !== 'create_quote') continue;
        const items = action.items || [];
        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const itemKey = `${action.action_id}-${idx}`;
          if (item.product_id !== null) continue;
          if (removedItems.has(itemKey)) continue;
          const price = parseFloat(unresolvedPrices[itemKey] || '0') || 0;
          if (price <= 0) {
            Alert.alert('Missing Price', `Enter a selling price for "${item.product_name}" or remove it.`);
            setConfirming(false);
            return;
          }
          const gstPct = parseFloat(unresolvedGst[itemKey] || '0') || 0;
          const prodRes = await fetch(`${backendUrl}/api/products`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: item.product_name, selling_price: price, tax_rate: gstPct }),
          });
          if (!prodRes.ok) {
            Alert.alert('Error', `Could not add "${item.product_name}" to catalog. Try again.`);
            setConfirming(false);
            return;
          }
          const newProduct = await prodRes.json();
          const updatedItems = [...items];
          updatedItems[idx] = { ...item, product_id: newProduct.id, unit_price: price, tax_rate: gstPct, line_total: price * item.quantity };
          await fetch(`${backendUrl}/api/chat/${customer_id}/spark/action/${action.action_id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ parameters: { items: updatedItems } }),
          });
        }
      }

      // Step 2: confirm all selected actions
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
      setPreviewInsight(null);
      setCheckedActions(new Set());
      setUnresolvedPrices({});
      setUnresolvedGst({});
      setRemovedItems(new Set());

      if (data.executed?.length > 0) {
        await loadChat();
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
      // BUG FIX 2: Call DELETE endpoint on cancel
      await fetch(`${backendUrl}/api/chat/${customer_id}/spark/${previewDraftId}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch {}
    // BUG FIX 2: Clear draft state immediately on Cancel
    setPreviewVisible(false);
    setPreviewDraftId(null);
    setPreviewActions([]);
    setPreviewInsight(null);
    setCheckedActions(new Set());
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
    setMessages(prev => [queryMsg, ...prev]);

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
        setMessages(prev => [respMsg, ...prev]);
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
          {msg.delivery_status === 'sent' && (
            <Ionicons name="checkmark" size={20} color="#8696A0" style={{ marginLeft: 4 }} />
          )}
          {msg.delivery_status === 'delivered' && (
            <Ionicons name="checkmark-done" size={20} color="#8696A0" style={{ marginLeft: 4 }} />
          )}
          {(msg.delivery_status === 'read' || !msg.delivery_status) && (
            <Ionicons name="checkmark-done" size={20} color="#53BDEB" style={{ marginLeft: 4 }} />
          )}
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
          <Text style={{ fontSize: 11, color: '#999', marginTop: 4, textAlign: 'right' }}>{formatTime(msg.created_at)}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            {cd.pdf_url && (
              <TouchableOpacity onPress={() => Linking.openURL(cd.pdf_url).catch(() => Alert.alert('Error', 'Could not open PDF'))} style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#F0F0F0', borderRadius: 8 }}>
                  <Ionicons name="document" size={16} color="#075E54" />
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#075E54' }}>View PDF</Text>
                </View>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => {
              const rawPhone = customer?.phone?.replace(/[^0-9]/g, '') || '';
              const phone = rawPhone.startsWith('91') ? rawPhone : rawPhone ? '91' + rawPhone : '';
              const isQuote = cd.is_quote || false;
              const docType = isQuote ? 'Quote' : 'Invoice';
              const dueText = cd.due_date ? '\nDue Date: ' + new Date(cd.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
              const pdfText = cd.pdf_url ? '\n\nDownload ' + docType + ': ' + cd.pdf_url : '';
              const confirmText = isQuote ? '\n\nPlease reply to confirm your acceptance of this quote.' : '';
              const footer = '\n\n--\nGenerated in seconds by voice using AssistMe - India\'s fastest business assistant for traders. Try free: https://assistme.app';
              const msg = 'Dear ' + (customer?.name || 'Customer') + ',\n\nPlease find your ' + docType + ' #' + cd.invoice_number + '.\n\nAmount: ' + formatCurrency(cd.total_amount || 0) + dueText + pdfText + confirmText + footer;
              const waUrl = phone ? 'https://wa.me/' + phone + '?text=' + encodeURIComponent(msg) : 'https://wa.me/?text=' + encodeURIComponent(msg);
              Linking.openURL(waUrl).catch(() => {});
            }} style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#E8F5E9', borderRadius: 8 }}>
                <Ionicons name="logo-whatsapp" size={16} color="#25D366" />
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#25D366' }}>WhatsApp</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  // ── Date divider logic ─────────────────────────────────────
  const shouldShowDateDivider = (index: number, data: ChatMessage[]) => {
    if (index === data.length - 1) return true;
    const curr = new Date(data[index].created_at);
    const next = new Date(data[index + 1].created_at);
    return curr.toDateString() !== next.toDateString();
  };

  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const divider = shouldShowDateDivider(index, filtered) ? (
      <View style={styles.dateDividerContainer}>
        <View style={styles.dateDividerPill}>
          <Text style={styles.dateDividerText}>{formatDateDivider(item.created_at)}</Text>
        </View>
      </View>
    ) : null;

    let content = null;
    
    // Attachment messages
    {(() => {
      const msgType = item.metadata?.message_type || item.message_type;
      if (msgType === 'image' && item.metadata?.attachment) {
        content = (
          <View style={styles.outgoingContainer}>
            <View style={styles.outgoingBubble}>
              <View style={styles.attachMsgCard}>
              <TouchableOpacity onPress={() => { setImageViewerUri(item.metadata.attachment?.uri || null); setImageViewerVisible(true); }}>
              <Image source={{ uri: item.metadata.attachment?.uri }} style={{ width: 200, height: 160, borderRadius: 8, marginBottom: 4 }} resizeMode="cover" />
              </TouchableOpacity>
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachMsgName} numberOfLines={1}>{item.metadata.attachment?.name}</Text>
                  <Text style={styles.attachMsgMeta}>Image</Text>
                </View>
              </View>
              <Text style={styles.outgoingTime}>{formatTime(item.created_at)}</Text>
            </View>
          </View>
        );
        return;
      }
      if (msgType === 'file' && item.metadata?.attachment) {
        content = (
          <View style={styles.outgoingContainer}>
            <View style={styles.outgoingBubble}>
              <View style={styles.attachMsgCard}>
                <Ionicons name="document-outline" size={32} color="#075E54" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachMsgName} numberOfLines={1}>{item.metadata.attachment?.name}</Text>
                  <Text style={styles.attachMsgMeta}>Document</Text>
                </View>
              </View>
              <Text style={styles.outgoingTime}>{formatTime(item.created_at)}</Text>
            </View>
          </View>
        );
        return;
      }
      if (msgType === 'audio' && item.metadata?.attachment) {
        const uri = item.metadata.attachment.uri;
        const isPlaying = playingUri === uri;
        content = (
          <View style={styles.outgoingContainer}>
            <View style={styles.outgoingBubble}>
              <TouchableOpacity onPress={() => handlePlayAudio(uri)} style={styles.attachMsgCard}>
                <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={36} color='#075E54' />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachMsgName} numberOfLines={1}>{item.metadata.attachment?.name}</Text>
                  <Text style={styles.attachMsgMeta}>{isPlaying ? 'Playing...' : 'Audio'}</Text>
                </View>
              </TouchableOpacity>
              <Text style={styles.outgoingTime}>{formatTime(item.created_at)}</Text>
            </View>
          </View>
        );
        return;
      }
    })()}

    if (content) return <>{divider}{content}</>;
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

  // ── Filter messages based on active tab ───────────────────
  const filtered = messages.filter(m => {
    if (activeTab === 'direct') {
      // Direct: customer-facing messages + invoice cards + system alerts (pink strips)
      return m.visibility === 'both' || m.message_type === 'invoice_card' || m.message_type === 'system_alert' || m.message_type === 'spark_clarify';
    } else {
      // AI: owner-only messages (pink strips, AI queries, AI responses)
      return m.visibility === 'owner_only' || m.message_type === 'ai_query' || m.message_type === 'ai_response' || m.message_type === 'system_alert' || m.message_type === 'spark_clarify';
    }
  });

  // ── Main render ────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.flex1}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
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
        ) : filtered.length === 0 ? (
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
            showsVerticalScrollIndicator={false}
            onScroll={(e) => {
              const offset = e.nativeEvent.contentOffset.y;
              scrollOffsetRef.current = offset;
              setShowScrollDown(offset > 150);
            }}
            scrollEventThrottle={16}
            refreshing={refreshing}
            onRefresh={loadChat}
            inverted={true}
            onEndReached={() => {
              if (hasMore && !loadingOlderRef.current) {
                loadOlderMessages();
              }
            }}
            onEndReachedThreshold={0.5}
            ListFooterComponent={loadingOlder ? (
              <ActivityIndicator size="small" color="#075E54" style={{ marginVertical: 8 }} />
            ) : null}
          />
        )}
        {showScrollDown && (
          <TouchableOpacity
            onPress={() => {
              flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            }}
            style={styles.scrollDownFab}
          >
            <Ionicons name="chevron-down" size={20} color="#FFF" />
          </TouchableOpacity>
        )}
      </View>

      {/* Input bar — different for each tab */}
      {activeTab === 'broadcast' ? null : activeTab === 'ai' ? (
        /* AI Messages input */
        <View style={[styles.inputBarWrapper, { paddingBottom: insets.bottom }]}>
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
        <>
          <View style={[styles.inputBarWrapper, { paddingBottom: insets.bottom }]}>
          {attachmentPreview && (
            <View style={styles.attachPreviewStrip}>
              <Ionicons
                name={
                  attachmentPreview.mime_type?.startsWith?.('image') ? 'image-outline' :
                  attachmentPreview.mime_type?.startsWith?.('audio') ? 'musical-notes-outline' :
                  'document-outline'
                }
                size={28} color="#075E54"
              />
              <Text style={styles.attachPreviewName} numberOfLines={1}>
                {attachmentPreview.name}
              </Text>
              <TouchableOpacity
                onPress={() => setAttachmentPreview(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={20} color="#999" />
              </TouchableOpacity>
            </View>
          )}
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
                ref={inputRef}
                blurOnSubmit={false}
                placeholder={sparkMode ? 'What would you like to do?' : 'Message or voice...'}
                placeholderTextColor={sparkMode ? '#075E54' : '#999'}
                value={inputText}
                onChangeText={setInputText}
                multiline
                maxLength={2000}
              />
              {!sparkMode && (
                <>
                  <TouchableOpacity style={styles.inputIconBtn} onPress={() => setAttachSheetVisible(true)}>
                    <Ionicons name="attach" size={22} color="#667781" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.inputIconBtn} onPress={handleOpenCamera}>
                    <Ionicons name="camera-outline" size={22} color="#667781" />
                  </TouchableOpacity>
                </>
              )}
            </View>
            {sparkMode ? (
              <TouchableOpacity style={[styles.sendBtn, styles.sparkSendBtn]} onPress={handleSpark} disabled={sparkProcessing || inputText.trim().length === 0}>
                {sparkProcessing ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="send" size={20} color="#FFF" />}
              </TouchableOpacity>
            ) : (inputText.trim().length > 0 || !!attachmentPreview) ? (
              <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={sending}>
                {sending ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="send" size={20} color="#FFF" />}
              </TouchableOpacity>
            ) : (
              <View style={{ position: 'relative' }}>
                <TouchableOpacity style={styles.sparkFab} onPress={() => setSparkMode(true)}>
                  <Ionicons name="sparkles" size={22} color="#FFF" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.micBtn}>
                  <Ionicons name="mic" size={22} color="#FFF" />
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
        </>
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
          <View style={[styles.sheetContainer, { paddingBottom: insets.bottom }]}>
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
                     action.action_type === 'create_quote' ? 'Create Quote' :
                     action.action_type === 'schedule_delivery' ? 'Delivery' :
                     action.action_type === 'set_reminder' ? 'Payment Reminder' :
                     action.action_type === 'record_payment' ? 'Record Payment' :
                     action.action_type}
                  </Text>

                  {/* Rich invoice items rendering */}
                  {(action.action_type === 'create_invoice' || action.action_type === 'create_quote') && action.items?.length > 0 ? (
                    <View>
                      {action.items.map((item: any, idx: number) => {
                        const itemKey = `${action.action_id}-${idx}`;
                        const isUnresolved = item.product_id === null;
                        const isRemoved = removedItems.has(itemKey);
                        const unresolvedPrice = unresolvedPrices[itemKey] || '';
                        const unresolvedGstVal = unresolvedGst[itemKey] || '';
                        if (isRemoved) return null;
                        return (
                          <View key={idx} style={[styles.invoiceItemRow, isUnresolved && {
                            backgroundColor: '#FFFDE7',
                            borderLeftWidth: 3,
                            borderLeftColor: '#F9A825',
                            paddingLeft: 8,
                            borderRadius: 6,
                            marginBottom: 8,
                          }]}>
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <Text style={styles.invoiceItemName}>
                                  {item.quantity} × {item.product_name}
                                </Text>
                                {isUnresolved && (
                                  <TouchableOpacity onPress={() => setRemovedItems(prev => new Set([...prev, itemKey]))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                    <Text style={{ fontSize: 18, color: '#F9A825', fontWeight: '700', paddingHorizontal: 6 }}>×</Text>
                                  </TouchableOpacity>
                                )}
                              </View>
                              {isUnresolved && (
                                <Text style={{ fontSize: 11, color: '#F9A825', marginTop: 2 }}>
                                  New · Add to catalog
                                </Text>
                              )}
                              {!isUnresolved && item.unit_price != null && (
                                <Text style={styles.invoiceItemPrice}>
                                  @ ₹{item.unit_price.toLocaleString('en-IN')} = ₹{(item.line_total || item.unit_price * item.quantity).toLocaleString('en-IN')}
                                  {item.tax_rate > 0 ? <Text style={{ fontSize: 11, color: '#888' }}> (GST {item.tax_rate}%)</Text> : null}
                                </Text>
                              )}
                              {isUnresolved && (
                                <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                                  <TextInput
                                    style={{ borderWidth: 1, borderColor: '#F9A825', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, width: 110, fontSize: 14, color: '#333' }}
                                    placeholder="₹ Price"
                                    placeholderTextColor="#999"
                                    keyboardType="numeric"
                                    value={unresolvedPrice}
                                    onChangeText={(text) => setUnresolvedPrices(prev => ({ ...prev, [itemKey]: text }))}
                                  />
                                  <TextInput
                                    style={{ borderWidth: 1, borderColor: '#F9A825', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, width: 70, fontSize: 14, color: '#333' }}
                                    placeholder="GST %"
                                    placeholderTextColor="#999"
                                    keyboardType="numeric"
                                    value={unresolvedGstVal}
                                    onChangeText={(text) => setUnresolvedGst(prev => ({ ...prev, [itemKey]: text }))}
                                  />
                                </View>
                              )}
                            </View>
                            {!isUnresolved && item.alternatives?.length > 1 && (
                              <View style={styles.altRow}>
                                <Text style={styles.altLabel}>Also found:</Text>
                                {item.alternatives.filter((a: any) => a.id !== item.product_id).slice(0, 3).map((alt: any) => (
                                  <TouchableOpacity key={alt.id} style={styles.altChip} onPress={async () => {
                                    try {
                                      const token = await getToken();
                                      if (!token) return;
                                      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
                                      const replacementItem = {
                                        product_id: alt.id,
                                        product_name: alt.name,
                                        unit_price: alt.selling_price,
                                        quantity: item.quantity,
                                        line_total: alt.selling_price * item.quantity,
                                        alternatives: item.alternatives,
                                      };
                                      await fetch(`${backendUrl}/api/chat/${customer_id}/spark/action/${action.action_id}`, {
                                        method: 'PATCH',
                                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ parameters: { items: [replacementItem] } }),
                                      });
                                      const updated = previewActions.map((pa: any) => {
                                        if (pa.action_id !== action.action_id) return pa;
                                        const newItems = [...pa.items];
                                        newItems[idx] = replacementItem;
                                        const newTotal = newItems.reduce((s: number, i: any) => s + (i.line_total || 0), 0);
                                        return { ...pa, items: newItems, parameters: { ...pa.parameters, items: newItems, amount: newTotal } };
                                      });
                                      setPreviewActions(updated);
                                    } catch (error) {
                                      console.error('Swap product error:', error);
                                      Alert.alert('Error', 'Could not swap product');
                                    }
                                  }}>
                                    <Text style={styles.altChipText}>{alt.name} (₹{alt.selling_price})</Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                            )}
                          </View>
                        );
                      })}
                      {(() => {
                        const freight = action.parameters?.freight || 0;
                        const freightTaxable = action.parameters?.freight_taxable || false;
                        let resolvedSubtotal = 0;
                        let resolvedGst = 0;
                        let maxTaxRate = 0;
                        (action.items || []).forEach((item: any, idx: number) => {
                          const itemKey = `${action.action_id}-${idx}`;
                          if (removedItems.has(itemKey)) return;
                          if (item.product_id !== null && item.line_total) {
                            const sub = item.unit_price * item.quantity;
                            resolvedSubtotal += sub;
                            const gst = sub * (item.tax_rate || 0) / 100;
                            resolvedGst += gst;
                            if ((item.tax_rate || 0) > maxTaxRate) maxTaxRate = item.tax_rate || 0;
                          }
                        });
                        let unresolvedSubtotal = 0;
                        let unresolvedGstTotal = 0;
                        (action.items || []).forEach((item: any, idx: number) => {
                          const itemKey = `${action.action_id}-${idx}`;
                          if (removedItems.has(itemKey)) return;
                          if (item.product_id === null) {
                            const price = parseFloat(unresolvedPrices[itemKey] || '0') || 0;
                            const gstPct = parseFloat(unresolvedGst[itemKey] || '0') || 0;
                            const lineAmt = price * item.quantity;
                            unresolvedSubtotal += lineAmt;
                            unresolvedGstTotal += lineAmt * gstPct / 100;
                            if (gstPct > maxTaxRate) maxTaxRate = gstPct;
                          }
                        });
                        const freightGst = freightTaxable ? freight * maxTaxRate / 100 : 0;
                        const totalGst = resolvedGst + unresolvedGstTotal + freightGst;
                        const grandTotal = resolvedSubtotal + unresolvedSubtotal + totalGst + freight;
                        if (grandTotal <= 0) return null;
                        return (
                          <View>
                            {freight > 0 && (
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderTopWidth: 1, borderTopColor: '#E0E0E0', marginTop: 4 }}>
                                <Text style={{ fontSize: 13, color: '#666' }}>Freight</Text>
                                <Text style={{ fontSize: 13, color: '#666' }}>₹{freight.toLocaleString('en-IN')}</Text>
                              </View>
                            )}
                            {totalGst > 0 && (
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
                                <Text style={{ fontSize: 12, color: '#888' }}>GST{freightTaxable && freight > 0 ? ` (max ${maxTaxRate}%)` : ''}</Text>
                                <Text style={{ fontSize: 12, color: '#888' }}>₹{Math.round(totalGst).toLocaleString('en-IN')}</Text>
                              </View>
                            )}
                            <View style={{ borderTopWidth: 1, borderTopColor: '#E0E0E0', marginTop: 4, paddingTop: 6 }}>
                              <Text style={styles.invoiceTotalText}>Total: ₹{Math.round(grandTotal).toLocaleString('en-IN')}</Text>
                            </View>
                            {action.parameters?.due_date && (
                              <TouchableOpacity onPress={() => {
                                setDateEditAction(action);
                                setDateEditValue(action.parameters.due_date ? new Date(action.parameters.due_date + 'T00:00:00') : new Date());
                                setDateEditDesc('');
                                setShowDatePicker(Platform.OS === 'ios');
                                setDateEditVisible(true);
                              }}>
                                <Text style={[styles.invoiceDueText, { textDecorationLine: 'underline' }]}>Due: {action.parameters.due_date} (tap to change)</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        );
                      })()}
                    </View>
                  ) : (
                    <Text style={styles.actionDetails}>{action.details}</Text>
                  )}
                </View>
                <TouchableOpacity style={styles.actionEditBtn} onPress={() => {
                  if (action.action_type === 'create_invoice' || action.action_type === 'create_quote') {
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
              {dateEditAction?.action_type === 'schedule_delivery' ? 'Edit Delivery' : dateEditAction?.action_type === 'create_invoice' || dateEditAction?.action_type === 'create_quote' ? 'Edit Due Date' : 'Edit Payment Reminder'}
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
                    details: pa.action_type === 'schedule_delivery' ? `Schedule: ${dateStr}` : pa.action_type === 'create_invoice' || pa.action_type === 'create_quote' ? `Due: ${dateStr}` : `Send on: ${dateStr}`,
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

      {/* Attachment Sheet */}
      <Modal
        visible={attachSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setAttachSheetVisible(false)}
      >
        <Pressable style={styles.attachSheetOverlay} onPress={() => setAttachSheetVisible(false)}>
          <Pressable onPress={() => {}}>
            <View style={styles.attachSheetContainer}>
              <View style={styles.attachSheetHandle} />
              <View style={styles.attachGrid}>
                {[
                  { icon: 'images-outline', label: 'Gallery', color: '#1E88E5', handler: handlePickGallery },
                  { icon: 'camera-outline', label: 'Camera', color: '#E53935', handler: handleOpenCamera },
                  { icon: 'document-outline', label: 'Document', color: '#FB8C00', handler: handlePickDocument },
                  {
                    icon: isRecording ? 'stop-circle-outline' : 'mic-outline',
                    label: isRecording ? 'Stop' : 'Audio',
                    color: isRecording ? '#E53935' : '#8E24AA',
                    handler: handleAudioRecording,
                  },
                  { icon: 'qr-code-outline', label: 'Share QR', color: '#00897B', handler: null },
                  { icon: 'grid-outline', label: 'Catalog', color: '#F57C00', handler: null },
                ].map((item) => (
                  <TouchableOpacity
                    key={item.label}
                    style={styles.attachGridItem}
                    onPress={() => {
                      if (item.handler) {
                        item.handler();
                      } else {
                        setAttachSheetVisible(false);
                        Alert.alert(item.label, 'Coming soon');
                      }
                    }}
                  >
                    <View style={[styles.attachGridIcon, { backgroundColor: item.color + '20' }]}>
                      <Ionicons name={item.icon as any} size={28} color={item.color} />
                    </View>
                    <Text style={styles.attachGridLabel}>{item.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      {/* Image Viewer */}
      <Modal visible={imageViewerVisible} transparent animationType="fade" onRequestClose={() => setImageViewerVisible(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.95)", justifyContent: "center", alignItems: "center" }}>
          <TouchableOpacity onPress={() => setImageViewerVisible(false)} style={{ position: "absolute", top: 48, right: 20, zIndex: 10, padding: 8 }}>
            <Ionicons name="close" size={28} color="#FFF" />
          </TouchableOpacity>
          {imageViewerUri && (
            <Image source={{ uri: imageViewerUri }} style={{ width: "100%", height: "80%" }} resizeMode="contain" />
          )}
        </View>
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
  scrollDownFab: {
    position: 'absolute',
    bottom: 28,
    alignSelf: 'center',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#075E54',
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.75,
    elevation: 4,
    zIndex: 5,
  },
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
  inputBarWrapper: { backgroundColor: '#ECE5DD' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingVertical: 4, paddingHorizontal: 6, gap: 6, backgroundColor: '#ECE5DD' },
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
  sparkFabRow: {
    alignItems: 'flex-end',
    paddingRight: 16,
    paddingBottom: 0,
    backgroundColor: 'transparent',
  },
  sparkFab: {
    position: 'absolute',
    bottom: '100%',
    marginBottom: 8,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#075E54',
    opacity: 0.65,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
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
  // Attachment sheet
  attachSheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  attachSheetContainer: {
    backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingBottom: 32, paddingTop: 8,
  },
  attachSheetHandle: { width: 40, height: 4, backgroundColor: '#DDD', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  attachGridItem: { width: '33%', alignItems: 'center', marginBottom: 20 },
  attachGridIcon: { width: 56, height: 56, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  attachGridLabel: { fontSize: 12, color: '#333', fontWeight: '500', textAlign: 'center' },
  // Attachment preview strip
  attachPreviewStrip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0FAF8',
    paddingVertical: 8, paddingHorizontal: 14,
    borderTopWidth: 1, borderTopColor: '#E0E0E0',
  },
  attachPreviewName: { flex: 1, fontSize: 13, color: '#333', fontWeight: '500', marginHorizontal: 10 },
  // Attachment message cards
  attachMsgCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5',
    borderRadius: 10, padding: 10, marginTop: 4, minWidth: 180,
  },
  attachMsgName: { fontSize: 13, color: '#333', fontWeight: '500' },
  attachMsgMeta: { fontSize: 11, color: '#999', marginTop: 2 },
});
