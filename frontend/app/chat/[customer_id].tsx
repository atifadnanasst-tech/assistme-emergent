import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
  Keyboard, Modal, Pressable, ScrollView, InteractionManager, LayoutAnimation,
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
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Customer AI Pills ────────────────────────────────────────
const CUSTOMER_AI_PILLS_ROW1 = [
  { id: 'summary', icon: '🧠', label: 'Summary', query: 'Give me a complete summary of this customer — purchases, payments, behavior, relationship health, and current outstanding.' },
  { id: 'outstanding', icon: '💰', label: 'Outstanding', query: 'What is the current outstanding balance? Show all unpaid and partially paid invoices with amounts and how many days overdue.' },
  { id: 'payments', icon: '💳', label: 'Payment Pattern', query: 'How does this customer pay? On time, delayed, or irregular? Show average days to pay and any pattern I should know.' },
  { id: 'reminder', icon: '💬', label: 'Send Reminder', query: 'Draft a payment reminder message for this customer in their preferred language and tone. Make it polite, firm, and natural.' },
  { id: 'beforecall', icon: '📞', label: 'Before I Call', query: 'I am about to call this customer. Give me a 5-point brief — outstanding amount, last order, payment reliability, last discussion topic, and one thing I should bring up.' },
];

const CUSTOMER_AI_PILLS_ROW2 = [
  { id: 'reorder', icon: '🔁', label: 'Reorder Due?', query: 'Is this customer due for a reorder based on their purchase rhythm? What do they usually buy, how often, and when did they last order?' },
  { id: 'risk', icon: '⚠️', label: 'Risk Check', query: 'Any payment risk or relationship risk with this customer? Any silence anomalies, declining orders, or warning signs I should act on?' },
  { id: 'purchases', icon: '🛍️', label: 'Purchase History', query: 'What has this customer bought over time? Show full product breakdown, quantities, totals, and any purchase trends.' },
  { id: 'tone', icon: '🗣️', label: 'Tone Profile', query: 'How does this customer communicate? What tone, language, and style do they prefer? What approach works best with them?' },
  { id: 'lastchat', icon: '📖', label: 'Last Chat', query: 'Summarize the last meaningful interaction with this customer. What was discussed, what was decided, and what is still pending?' },
];

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
  input_modality?: string;
  metadata?: Record<string, any>;
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
  const [aiMessages, setAiMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);
  const [activeTab, setActiveTab] = useState('direct');
  const [sentReminders, setSentReminders] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  type SparkWorkflowState =
    | 'idle'
    | 'attaching_file'
    | 'recording_audio'
    | 'uploading'
    | 'upload_failed'
    | 'attachment_ready'
    | 'processing'
    | 'previewing'
    | 'error';

  const [sparkWorkflowState, setSparkWorkflowState] = useState<SparkWorkflowState>('idle');
  const [sparkMode, setSparkMode] = useState(false);
  const [sparkProcessing, setSparkProcessing] = useState(false);
  const [sparkInput, setSparkInput] = useState('');
  const [forwardedAttachment, setForwardedAttachment] = useState<{
    type: 'text' | 'image' | 'audio' | 'file';
    text?: string;
    url?: string;
    mime_type?: string;
    name?: string;
    caption?: string;
    created_at?: string;
  } | null>(null);
  const [currentTipIndex, setCurrentTipIndex] = useState(0);
  const sparkTips = [
    'Invoice banao...',
    'Payment record karo...',
    'Delivery schedule karo...',
    'Photo se invoice banao...',
    'Reminder bhejo...',
    'Quote banao...',
    'Delivery complete karo...',
    'Payment received...',
  ];
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
  const [unresolvedNames, setUnresolvedNames] = useState<Record<string, string>>({});
  const [editableQuantities, setEditableQuantities] = useState<Record<string, string>>({});
  // Date edit sheet
  const [dateEditVisible, setDateEditVisible] = useState(false);
  const [dateEditAction, setDateEditAction] = useState<any>(null);
  const [dateEditValue, setDateEditValue] = useState(new Date());
  const [dateEditDesc, setDateEditDesc] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(Platform.OS === 'ios');
  // AI query
  const [aiQueryText, setAiQueryText] = useState('');
  const [aiQuerying, setAiQuerying] = useState(false);
  const [aiAttachment, setAiAttachment] = useState<{
    type: 'audio' | 'image' | 'file';
    url: string;
    mime_type: string;
    name: string;
  } | null>(null);
  const [capsuleExpanded, setCapsuleExpanded] = useState(false);
  // AI conversation context switcher
  const [activeAiConvId, setActiveAiConvId] = useState<string | null>(null);
  const [aiConversations, setAiConversations] = useState<Array<{
    id: string;
    title: string;
    is_archived: boolean;
    created_at: string;
  }>>([]);
  const [showConvDropdown, setShowConvDropdown] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
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
    uri: string;
    name: string;
    mime_type: string;
    size?: number;
    url?: string;
    storage_path?: string;
    upload_status: 'uploading' | 'ready' | 'failed';
    upload_id: string;
  } | null>(null);

  const applyUploadState = (
    origin: 'dm' | 'ai' | 'spark',
    modality: 'image' | 'audio' | 'document' | 'video',
    uploadId: string,
    phase: 'uploading' | 'ready' | 'failed',
    payload?: { url?: string; storage_path?: string; uri?: string; name?: string; mime_type?: string; size?: number }
  ) => {
    // Upload pipeline determines ownership at upload start.
    // UI tab state is NOT authoritative after upload begins.
    if (origin === 'dm' || origin === 'spark') {
      if (phase === 'uploading') {
        setAttachmentPreview({ uri: payload!.uri!, name: payload!.name!, mime_type: payload!.mime_type!, size: payload?.size, upload_status: 'uploading', upload_id: uploadId });
      } else if (phase === 'ready') {
        // Stale callback protection: only update if uploadId matches
        setAttachmentPreview(prev => prev?.upload_id === uploadId ? { ...prev, url: payload!.url!, storage_path: payload!.storage_path!, upload_status: 'ready' } : prev);
      } else {
        setAttachmentPreview(prev => prev?.upload_id === uploadId ? { ...prev, upload_status: 'failed' } : prev);
      }
    }
    if (origin === 'ai' && phase === 'ready' && payload?.url) {
      setAiAttachment({ type: modality === 'image' ? 'image' : modality === 'audio' ? 'audio' : 'file', url: payload.url, mime_type: payload.mime_type || '', name: payload.name || '' });
    }
    if (origin === 'spark' && phase === 'ready' && payload?.url && payload?.storage_path) {
      attachUploadToSpark({ url: payload.url, storage_path: payload.storage_path }, payload.name || '', payload.mime_type || '');
      setSparkWorkflowState('attachment_ready');
    }
    if (origin === 'spark' && phase === 'failed') {
      setSparkWorkflowState('upload_failed');
    }
  };

  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  // Context menu
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [messageMenuVisible, setMessageMenuVisible] = useState(false);

  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [imageViewerUri, setImageViewerUri] = useState<string | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);

  const inputRef = useRef<any>(null);
  const channelRef = useRef<any>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const initAiConvRef = useRef(false);
  const aiMsgRequestRef = useRef(0);

  const mountedRef = useRef(true);
  const aiExecutionRef = useRef(0);
  const activeAiConvIdRef = useRef<string | null>(null);
  const customerIdRef = useRef<string | null>(null);

  // ── Runtime authority mirrors ──────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { activeAiConvIdRef.current = activeAiConvId; }, [activeAiConvId]);
  useEffect(() => { customerIdRef.current = customer_id ?? null; }, [customer_id]);

  const isExecutionValid = (execId: number, custId: string | null, convId: string | null) =>
    mountedRef.current &&
    aiExecutionRef.current === execId &&
    customerIdRef.current === custId &&
    activeAiConvIdRef.current === convId;

  // ── Attachment upload ──────────────────────────────────────
  const uploadAttachment = async (localUri: string, name: string, mimeType: string, uploadId: string) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
      const token = await getToken();
      if (!token) throw new Error('No token');
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      const formData = new FormData();
      formData.append('file', {
        uri: localUri,
        name,
        type: mimeType,
      } as any);

      const res = await fetch(`${backendUrl}/api/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      return { url: data.url, storage_path: data.storage_path };
    } catch (e) {
      console.error('uploadAttachment error:', e);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleRetryUpload = async () => {
    const prev = attachmentPreview;
    if (!prev) return;
    const newUploadId = Date.now().toString();
    if (sparkMode) setSparkWorkflowState('uploading');
    setAttachmentPreview({ ...prev, upload_status: 'uploading', upload_id: newUploadId });
    const uploaded = await uploadAttachment(prev.uri, prev.name, prev.mime_type, newUploadId);
    if (uploaded) {
      setAttachmentPreview(p => p?.upload_id === newUploadId ? { ...p, url: uploaded.url, storage_path: uploaded.storage_path, upload_status: 'ready' } : p);
      if (sparkMode) setSparkWorkflowState('attachment_ready');
    } else {
      setAttachmentPreview(p => p?.upload_id === newUploadId ? { ...p, upload_status: 'failed' } : p);
      if (sparkMode) setSparkWorkflowState('upload_failed');
    }
  };

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
    if (sparkMode) setSparkWorkflowState('attaching_file');
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.8,
      });
      if (result.canceled) {
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      if (!result.assets || !result.assets[0]) {
        Alert.alert('Error', 'Could not process selection.');
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      const asset = result.assets[0];
      const uploadOrigin = sparkMode ? 'spark' : activeTab === 'ai' ? 'ai' : 'dm';
      const uploadId = Date.now().toString();
      
      if (uploadOrigin !== 'ai') {
        applyUploadState(uploadOrigin, 'image', uploadId, 'uploading', {
          uri: asset.uri,
          name: asset.fileName || 'image.jpg',
          mime_type: asset.mimeType || 'image/jpeg',
          size: asset.fileSize ?? undefined,
        });
      }
      if (sparkMode) setSparkWorkflowState('uploading');

      const uploaded = await uploadAttachment(asset.uri, asset.fileName || 'image.jpg', asset.mimeType || 'image/jpeg', uploadId);
      if (uploaded) {
        applyUploadState(uploadOrigin, 'image', uploadId, 'ready', {
          url: uploaded.url,
          storage_path: uploaded.storage_path,
          name: asset.fileName || 'image.jpg',
          mime_type: asset.mimeType || 'image/jpeg',
        });
      } else {
        applyUploadState(uploadOrigin, 'image', uploadId, 'failed');
      }
    } catch (e) {
      console.error('Gallery picker error:', e);
      Alert.alert('Error', 'Could not open photo library.');
      if (sparkMode) setSparkWorkflowState('error');
    }
  };

  // Camera picker
  const handleOpenCamera = async () => {
    setAttachSheetVisible(false);
    if (sparkMode) setSparkWorkflowState('attaching_file');
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow camera access.');
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        quality: 0.8,
      });
      if (result.canceled) {
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      if (!result.assets || !result.assets[0]) {
        Alert.alert('Error', 'Could not process photo.');
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      const asset = result.assets[0];
      const uploadOrigin = sparkMode ? 'spark' : activeTab === 'ai' ? 'ai' : 'dm';
      const uploadId = Date.now().toString();
      
      if (uploadOrigin !== 'ai') {
        applyUploadState(uploadOrigin, 'image', uploadId, 'uploading', {
          uri: asset.uri,
          name: asset.fileName || 'photo.jpg',
          mime_type: asset.mimeType || 'image/jpeg',
          size: asset.fileSize ?? undefined,
        });
      }
      if (sparkMode) setSparkWorkflowState('uploading');

      const uploaded = await uploadAttachment(asset.uri, asset.fileName || 'photo.jpg', asset.mimeType || 'image/jpeg', uploadId);
      if (uploaded) {
        applyUploadState(uploadOrigin, 'image', uploadId, 'ready', {
          url: uploaded.url,
          storage_path: uploaded.storage_path,
          name: asset.fileName || 'photo.jpg',
          mime_type: asset.mimeType || 'image/jpeg',
        });
      } else {
        applyUploadState(uploadOrigin, 'image', uploadId, 'failed');
      }
    } catch (e) {
      console.error('Camera error:', e);
      Alert.alert('Error', 'Could not open camera.');
      if (sparkMode) setSparkWorkflowState('error');
    }
  };

  // Document picker
  const handlePickDocument = async () => {
    setAttachSheetVisible(false);
    if (sparkMode) setSparkWorkflowState('attaching_file');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) {
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      if (!result.assets || !result.assets[0]) {
        Alert.alert('Error', 'Could not process document.');
        if (sparkMode) setSparkWorkflowState('idle');
        return;
      }
      const asset = result.assets[0];
      const uploadOrigin = sparkMode ? 'spark' : activeTab === 'ai' ? 'ai' : 'dm';
      const uploadId = Date.now().toString();
      
      if (uploadOrigin !== 'ai') {
        applyUploadState(uploadOrigin, 'document', uploadId, 'uploading', {
          uri: asset.uri,
          name: asset.name,
          mime_type: asset.mimeType || 'application/octet-stream',
          size: asset.size ?? undefined,
        });
      }
      if (sparkMode) setSparkWorkflowState('uploading');

      const uploaded = await uploadAttachment(asset.uri, asset.name, asset.mimeType || 'application/octet-stream', uploadId);
      if (uploaded) {
        applyUploadState(uploadOrigin, 'document', uploadId, 'ready', {
          url: uploaded.url,
          storage_path: uploaded.storage_path,
          name: asset.name,
          mime_type: asset.mimeType || 'application/octet-stream',
        });
      } else {
        applyUploadState(uploadOrigin, 'document', uploadId, 'failed');
      }
    } catch (e) {
      console.error('Document picker error:', e);
      Alert.alert('Error', 'Could not open document picker.');
      if (sparkMode) setSparkWorkflowState('error');
    }
  };

  // Audio recording — tap to start, tap to stop
  const handleAudioRecording = async () => {
    if (isRecording) {
      // Stop recording — close sheet
      setAttachSheetVisible(false);
      const uploadOrigin = sparkMode ? 'spark' : activeTab === 'ai' ? 'ai' : 'dm';
      const uploadId = Date.now().toString();
      if (sparkMode) setSparkWorkflowState('uploading');
      try {
        const rec = recording;
        setRecording(null);
        setIsRecording(false);
        await rec?.stopAndUnloadAsync();
        const uri = rec?.getURI();
        if (uri) {
          const fileName = `audio_${Date.now()}.m4a`;
          
          if (uploadOrigin !== 'ai') {
            applyUploadState(uploadOrigin, 'audio', uploadId, 'uploading', {
              uri,
              name: fileName,
              mime_type: 'audio/x-m4a',
            });
          }

          const uploaded = await uploadAttachment(uri, fileName, 'audio/x-m4a', uploadId);
          if (uploaded) {
            applyUploadState(uploadOrigin, 'audio', uploadId, 'ready', {
              url: uploaded.url,
              storage_path: uploaded.storage_path,
              name: fileName,
              mime_type: 'audio/x-m4a',
            });
          } else {
            applyUploadState(uploadOrigin, 'audio', uploadId, 'failed');
          }
        }
      } catch (e) {
        console.error('Stop recording error:', e);
        setIsRecording(false);
        setRecording(null);
        if (sparkMode) setSparkWorkflowState('error');
      }
    } else {
      // Start recording — do NOT close sheet
      if (sparkMode) setSparkWorkflowState('recording_audio');
      try {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Required', 'Please allow microphone access.');
          if (sparkMode) setSparkWorkflowState('idle');
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

  // Spark tip rotation
  useEffect(() => {
    if (!sparkMode) { setCurrentTipIndex(0); return; }
    const interval = setInterval(() => {
      setCurrentTipIndex(prev => (prev + 1) % sparkTips.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [sparkMode]);


  const loadChat = async (markRead: boolean = true) => {
    setLoading(true);
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

  const normalizeAiMessage = (m: any): ChatMessage => ({
    id: m.id || String(Date.now() + Math.random()),
    role: m.role || "assistant",
    content: typeof m.content === "string" ? m.content : "",
    created_at: m.created_at || new Date().toISOString(),
    sender_type: m.sender_type || null,
    visibility: m.visibility || "owner_only",
    message_type: m.message_type || m.metadata?.message_type || "ai_response",
    card_type: m.card_type || null,
    card_data: m.card_data && typeof m.card_data === "object" ? m.card_data : {},
    preview_text: m.preview_text || null,
    input_modality: m.input_modality || m.metadata?.input_modality || "text",
    metadata: m.metadata && typeof m.metadata === "object" ? m.metadata : {},
  });

  const loadAiMessages = async (convId: string | null) => {
    if (!convId || !customer_id) {
      setAiMessages([]);
      return;
    }
    const requestId = ++aiMsgRequestRef.current;
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(
        `${backendUrl}/api/chat/${customer_id}/ai-messages?ai_conversation_id=${convId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (requestId !== aiMsgRequestRef.current) return;
      if (res.ok) {
        const data = await res.json();
        const msgs = data.messages || [];
        if (requestId !== aiMsgRequestRef.current) return;
        setAiMessages(msgs.map(normalizeAiMessage));
        console.log('[AI-MESSAGES] Loaded', msgs.length, 'messages for conv', convId);
      } else {
        console.error('[AI-MESSAGES] Fetch error:', res.status);
        if (requestId !== aiMsgRequestRef.current) return;
        setAiMessages([]);
      }
    } catch (err) {
      console.error('[AI-MESSAGES] loadAiMessages error:', err);
      if (requestId !== aiMsgRequestRef.current) return;
      setAiMessages([]);
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
    if ((!text && !attachment) || sending || !conversationId) return;
    inputRef.current?.focus();
    setInputText('');

    const tempId = `temp-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId, role: 'assistant', content: text || attachment?.name || 'Attachment',
      created_at: new Date().toISOString(), sender_type: 'owner',
      visibility: 'both', message_type: 'text', card_type: null,
      card_data: {}, preview_text: text.substring(0, 50),
      delivery_status: 'sent',
      metadata: {
        ...(attachment ? {
          message_type: attachment.mime_type?.startsWith?.('image') ? 'image' :
                        attachment.mime_type?.startsWith?.('audio') ? 'audio' : 'file',
          attachment: {
            uri: attachment.uri,
            url: attachment.url,
            name: attachment.name,
            mime_type: attachment.mime_type,
            size: attachment.size,
            storage_path: attachment.storage_path,
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
          m.id === tempId ? { ...m, id: data.message_id, created_at: data.created_at, delivery_status: 'delivered', content: data.content || m.content, metadata: data.metadata || m.metadata || {} } : m
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

  const handleForwardToSpark = (message: ChatMessage) => {
    const msgType = message.metadata?.message_type || message.message_type || 'text';
    let payload: {
      type: 'text' | 'image' | 'audio' | 'file';
      text?: string;
      url?: string;
      mime_type?: string;
      name?: string;
      caption?: string;
      created_at?: string;
    };

    if (msgType === 'image') {
      payload = {
        type: 'image',
        url: message.metadata?.attachment?.url || message.metadata?.attachment?.uri,
        mime_type: message.metadata?.attachment?.mime_type || 'image/jpeg',
        name: message.metadata?.attachment?.name,
        caption: message.content !== message.metadata?.attachment?.name ? message.content : undefined,
        created_at: message.created_at,
      };
    } else if (msgType === 'audio') {
      payload = {
        type: 'audio',
        url: message.metadata?.attachment?.url || message.metadata?.attachment?.uri,
        mime_type: message.metadata?.attachment?.mime_type || 'audio/m4a',
        name: message.metadata?.attachment?.name,
        caption: message.content !== message.metadata?.attachment?.name ? message.content : undefined,
        created_at: message.created_at,
      };
    } else if (msgType === 'file') {
      payload = {
        type: 'file',
        url: message.metadata?.attachment?.url || message.metadata?.attachment?.uri,
        mime_type: message.metadata?.attachment?.mime_type || 'application/octet-stream',
        name: message.metadata?.attachment?.name,
        caption: message.content !== message.metadata?.attachment?.name ? message.content : undefined,
        created_at: message.created_at,
      };
    } else {
      payload = {
        type: 'text',
        text: message.content,
        created_at: message.created_at,
      };
    }

    setForwardedAttachment(payload);
    setSparkMode(true);
    setMessageMenuVisible(false);
  };

  const resetSparkState = useCallback(() => {
    setSparkMode(false);
    setSparkInput('');
    setForwardedAttachment(null);
    setAttachmentPreview(null);
    setSparkProcessing(false);
    setSparkWorkflowState('idle');
    setPreviewVisible(false);
    setPreviewDraftId(null);
    setPreviewActions([]);
    setCheckedActions(new Set());
  }, []);

  const attachUploadToSpark = (uploadResult: { url: string; storage_path: string }, name: string, mimeType: string) => {
    const type = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'file';
    setForwardedAttachment({
      type,
      url: uploadResult.url,
      mime_type: mimeType,
      name,
    });
  };

  // ── AI Spark handler ───────────────────────────────────────
  const handleSpark = async () => {
    const text = sparkInput.trim() || inputText.trim();
    if (sparkWorkflowState !== 'attachment_ready' && !(sparkWorkflowState === 'idle' && text)) return;
    if (!conversationId) return;
    Keyboard.dismiss();
    setSparkInput('');
    setInputText('');
    setSparkMode(false);
    const capturedAttachment = forwardedAttachment;
    setForwardedAttachment(null);
    setSparkProcessing(true);
    setSparkWorkflowState('processing');

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
        body: JSON.stringify({
          query: text,
          conversation_id: conversationId,
          forwarded_attachment: capturedAttachment || null,
        }),
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
        setSparkWorkflowState('idle');
        await loadChat();
      } else if (data.routing === 'preview') {
        // Show Action Preview Sheet
        setPreviewDraftId(data.draft_id);
        setPreviewActions(data.actions || []);
        setPreviewInsight(data.ai_insight);
        setCheckedActions(new Set((data.actions || []).map((a: any) => a.action_id)));
        setSparkWorkflowState('previewing');
        // Pre-populate unresolvedPrices from OCR unit_price for unresolved items
        const prefillPrices: Record<string, string> = {};
        for (const action of (data.actions || [])) {
          if (action.action_type !== 'create_invoice' && action.action_type !== 'create_quote') continue;
          const items = action.items || [];
          items.forEach((item: any, idx: number) => {
            if (item.product_id === null && item.unit_price != null) {
              prefillPrices[`${action.action_id}-${idx}`] = String(item.unit_price);
            }
          });
        }
        if (Object.keys(prefillPrices).length > 0) setUnresolvedPrices(prefillPrices);
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
        setSparkWorkflowState('idle');
        await loadChat();
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        Alert.alert('Spark Error', 'Could not process your request. Try again.');
      }
      setSparkWorkflowState('error');
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
          const price = parseFloat(unresolvedPrices[itemKey] ?? (item.unit_price != null ? String(item.unit_price) : '0')) || 0;
          if (price <= 0) {
            Alert.alert('Missing Price', `Enter a selling price for "${item.product_name}" or remove it.`);
            setConfirming(false);
            return;
          }
          const gstPct = parseFloat(unresolvedGst[itemKey] || '0') || 0;
          const editedName = unresolvedNames[itemKey] ?? item.product_name;
          const editedQty = parseFloat(editableQuantities[itemKey] ?? String(item.quantity)) || item.quantity;
          // Check if owner typed an existing product name before creating new
          // Backend handles alias learning at confirm time using raw_product_name
          const findRes = await fetch(
            `${backendUrl}/api/products/find?name=${encodeURIComponent(editedName)}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
          );
          const existingProduct = findRes.ok ? await findRes.json() : null;
          let resolvedProductId: string;
          let resolvedPrice: number;
          let resolvedTaxRate: number;
          if (existingProduct?.id) {
            // Owner typed name of existing product — reuse it, no duplicate created
            resolvedProductId = existingProduct.id;
            resolvedPrice = existingProduct.selling_price ?? price;
            resolvedTaxRate = existingProduct.tax_rate ?? gstPct;
          } else {
            // Genuinely new product — create it
            const prodRes = await fetch(`${backendUrl}/api/products`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: editedName, selling_price: price, tax_rate: gstPct }),
            });
            if (!prodRes.ok) {
              Alert.alert('Error', `Could not add "${editedName}" to catalog. Try again.`);
              setConfirming(false);
              return;
            }
            const newProduct = await prodRes.json();
            resolvedProductId = newProduct.id;
            resolvedPrice = price;
            resolvedTaxRate = gstPct;
          }
          const updatedItems = [...items];
          updatedItems[idx] = { ...item, product_id: resolvedProductId, product_name: editedName, quantity: editedQty, unit_price: resolvedPrice, tax_rate: resolvedTaxRate, line_total: resolvedPrice * editedQty };
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

      resetSparkState();
      setUnresolvedPrices({});
      setUnresolvedGst({});
      setRemovedItems(new Set());
      setUnresolvedNames({});
      setEditableQuantities({});

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
    resetSparkState();
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
  const handleAiQuery = async (directQuery?: string) => {
    const rawText = directQuery !== undefined ? directQuery : aiQueryText.trim();
    if ((!rawText && !aiAttachment) || aiQuerying || !conversationId) return;

    // Fetch token BEFORE spinner — prevents permanent spinner on token failure
    const token = await getToken();
    if (!token) return;

    // Capture execution authority
    const execId = ++aiExecutionRef.current;
    const capturedCustomerId = customerIdRef.current;
    const capturedConvId = activeAiConvIdRef.current;
    console.log("[QUERY] execId:", execId, "capturedConvId:", capturedConvId, "activeAiConvId:", activeAiConvId);

    Keyboard.dismiss();
    setAiQueryText('');
    setAiQuerying(true);

    // Build query text
    let text = rawText;
    if (!text && aiAttachment) {
      text = aiAttachment.type === 'audio'
        ? 'Analyze this voice note in the context of this customer.'
        : aiAttachment.type === 'image'
        ? 'Analyze this image in the context of this customer.'
        : 'Analyze this document in the context of this customer.';
    }
    if (rawText && aiAttachment) {
      text = rawText + '\n\n[Customer attachment: ' + aiAttachment.name + ']';
    }

    // Optimistic: add owner's query locally
    const tempQId = `aiq-${Date.now()}`;
    const queryMsg: ChatMessage = {
      id: tempQId, role: 'user', content: text,
      created_at: new Date().toISOString(), sender_type: 'owner',
      visibility: 'owner_only', message_type: 'ai_query', card_type: null,
      card_data: {}, preview_text: text.substring(0, 50),
      input_modality: 'text', metadata: {},
    };
    // setAiMessages(prev => [queryMsg, ...prev]); // TEMP DISABLED

    const capturedAttachment = aiAttachment;
    setAiAttachment(null);

    try {
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const payload = { query: text, conversation_id: conversationId, ai_conversation_id: activeAiConvId || null, attachment: capturedAttachment || null };
      console.log("[QUERY PAYLOAD]", JSON.stringify(payload));
      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/ai-query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!isExecutionValid(execId, capturedCustomerId, capturedConvId)) return;

      if (res.ok) {
        const data = await res.json();
        if (!isExecutionValid(execId, capturedCustomerId, capturedConvId)) return;
        const respMsg: ChatMessage = {
          id: data.message_id || `air-${Date.now()}`, role: 'assistant', content: data.response || '',
          created_at: new Date().toISOString(), sender_type: 'ai',
          visibility: 'owner_only', message_type: data.message_type || 'ai_response',
          card_type: data.card_type || null,
          card_data: { shareable: data.shareable || false },
          preview_text: data.response?.substring(0, 50) || null,
          input_modality: 'text', metadata: {},
        };
        if (!isExecutionValid(execId, capturedCustomerId, capturedConvId)) return;
        setAiMessages(prev => [respMsg, ...prev]);
      } else {
        if (!isExecutionValid(execId, capturedCustomerId, capturedConvId)) return;
        Alert.alert('Error', 'Could not get AI response. Try again.');
      }
    } catch (e) {
      console.log("[QUERY ERROR]", String(e));
      if (!isExecutionValid(execId, capturedCustomerId, capturedConvId)) return;
      Alert.alert('Error', 'AI query failed.');
    } finally {
      if (mountedRef.current) setAiQuerying(false);
    }
  };

  const sendCapsuleQuery = (query: string) => {
    if (aiQuerying || !conversationId) return;
    setCapsuleExpanded(false);
    handleAiQuery(query);
  };

  const toggleCapsuleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCapsuleExpanded(prev => !prev);
  };

  // ── AI Conversation Context Switcher ──────────────────────────
  const initAiConversation = async () => {
    console.log('[AI INIT] START customer_id:', customer_id, 'loading:', loading);
    if (!customer_id || loading) { console.log("[AI INIT] GUARD BLOCKED"); return; }
    try {
      console.log('[AI INIT] before getToken');
      const token = await getToken();
      console.log('[AI INIT] token:', token ? 'ok' : 'null');
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      
      console.log('[AI INIT] before fetch conversations');
      const listRes = await fetch(`${backendUrl}/api/chat/${customer_id}/ai-conversations`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      console.log('[AI INIT] fetch status:', listRes.status);
      if (listRes.ok) {
        const data = await listRes.json();
        const convList = data.conversations || [];
        console.log('[AI INIT] convList length:', convList.length);
        setAiConversations(convList);
        if (convList.length > 0) {
          console.log('[AI INIT] setting activeAiConvId:', convList[0].id);
          setActiveAiConvId(convList[0].id);
          console.log('[AI INIT] before loadAiMessages');
          await loadAiMessages(convList[0].id);
          console.log('[AI INIT] after loadAiMessages DONE');
        } else {
          console.log('[AI INIT] no convs, creating new');
          const createRes = await fetch(`${backendUrl}/api/chat/${customer_id}/ai-conversations`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'New Chat' }),
          });
          if (createRes.ok) {
            const createData = await createRes.json();
            const newConv = createData.conversation;
            setAiConversations([newConv]);
            setActiveAiConvId(newConv.id);
            await loadAiMessages(newConv.id);
            console.log('[AI INIT] new conv created DONE');
          }
        }
      }
    } catch (err) {
      console.error('[AI INIT CRASH]', err);
    }
  };

  const fetchAiConversations = async () => {
    if (!customer_id || loadingConversations) return;
    setLoadingConversations(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/ai-conversations`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAiConversations(data.conversations || []);
      }
    } catch (err) {
      console.error('fetchAiConversations error:', err);
    } finally {
      setLoadingConversations(false);
    }
  };

  const createNewAiConversation = async () => {
    if (!customer_id || loadingConversations) return;
    aiExecutionRef.current++; // invalidate stale async on new conversation
    setLoadingConversations(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/chat/${customer_id}/ai-conversations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Chat' }),
      });
      if (res.ok) {
        const data = await res.json();
        const newConv = data.conversation;
        setAiConversations(prev => [newConv, ...prev]);
        setActiveAiConvId(newConv.id);
        setShowConvDropdown(false);
        // Clear current AI messages from view
        setAiMessages([]);
      }
    } catch (err) {
      console.error('createNewAiConversation error:', err);
    } finally {
      setLoadingConversations(false);
    }
  };

  const switchAiConversation = async (convId: string) => {
    if (convId === activeAiConvId) {
      setShowConvDropdown(false);
      return;
    }
    setActiveAiConvId(convId);
    setShowConvDropdown(false);
    aiExecutionRef.current++; // invalidate stale async before state clear
    setAiMessages([]); // clear immediately before fetch
    await loadAiMessages(convId); // Stage 1.5: verify fetch works via console logs before FlatList switch
  };

  // Reset AI state when customer changes
  useEffect(() => {
    console.log('[EFFECT RESET]', customer_id);
    initAiConvRef.current = false;
    setActiveAiConvId(null);
    setAiMessages([]);
    setAiConversations([]);
  }, [customer_id]);

  // Initialize AI conversation on mount or when AI tab is activated
  useEffect(() => {
    console.log('[EFFECT INIT]', { customer_id, loading, init: initAiConvRef.current });
    if (customer_id && !loading && !initAiConvRef.current) {
      initAiConvRef.current = true;
      initAiConversation();
    }
  }, [customer_id, loading]);

  // Auto-brief on AI tab open (once per day)
  useEffect(() => {
    if (activeTab === 'ai' && customer_id && conversationId) {
      // checkAndSendAutoBrief(); // disabled during stabilization
    }
  }, [activeTab, customer_id, conversationId]);

  const checkAndSendAutoBrief = async () => {
    if (!customer_id || !conversationId) return;
    try {
      const today = new Date().toISOString().split('T')[0];
      const storageKey = `ai_brief_${customer_id}_${today}`;
      
      // Check AsyncStorage
      const briefSent = await AsyncStorage.getItem(storageKey);
      if (briefSent) return; // Already sent today
      
      // Check message count in AI thread today
      const aiMsgs = aiMessages.filter(m => m.message_type === 'ai_query' || m.message_type === 'ai_response');
      if (aiMsgs.length >= 2) return; // Thread already active
      
      // Send auto-brief directly — avoid setState+setTimeout race condition
      await AsyncStorage.setItem(storageKey, '1');
      const briefText = 'Give me a quick brief on this customer before I start. Key facts only — outstanding balance, last order date, payment reliability, and one thing I should act on today.';
      handleAiQuery(briefText);
    } catch (err) {
      console.error('Auto-brief error:', err);
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
            <Text style={styles.invoiceNumber}>{cd.is_quote ? 'Quote' : 'Invoice'} #{cd.invoice_number || '---'}</Text>
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
    const divider = shouldShowDateDivider(index, displayMessages) ? (
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
        const isIncoming = item.role === 'user';
        content = (
          <View style={isIncoming ? styles.incomingContainer : styles.outgoingContainer}>
            <Pressable
              style={isIncoming ? styles.incomingBubble : styles.outgoingBubble}
              onPress={() => {
                setImageViewerUri(item.metadata.attachment?.url || item.metadata.attachment?.uri || null);
                setImageViewerVisible(true);
              }}
              onLongPress={() => {
                setSelectedMessage(item);
                setMessageMenuVisible(true);
              }}
              delayLongPress={300}
              android_disableSound
            >
              <View style={styles.attachMsgCard}>
                <Image source={{ uri: item.metadata.attachment?.url || item.metadata.attachment?.uri }} style={{ width: 200, height: 160, borderRadius: 8, marginBottom: 4 }} resizeMode="cover" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachMsgName} numberOfLines={1}>🖼 Image</Text>
                  <Text style={styles.attachMsgMeta}>Image</Text>
                </View>
              </View>
              {item.content && item.content !== item.metadata?.attachment?.name && item.content !== 'Attachment' && (
                <Text style={isIncoming ? styles.incomingText : styles.outgoingText}>{item.content}</Text>
              )}
              <Text style={isIncoming ? styles.incomingTime : styles.outgoingTime}>{formatTime(item.created_at)}</Text>
            </Pressable>
          </View>
        );
      }
      if (msgType === 'file' && item.metadata?.attachment) {
        const isIncoming = item.role === 'user';
        content = (
          <View style={isIncoming ? styles.incomingContainer : styles.outgoingContainer}>
            <View style={isIncoming ? styles.incomingBubble : styles.outgoingBubble}>
              <View style={styles.attachMsgCard}>
                <Ionicons name="document-outline" size={32} color="#075E54" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachMsgName} numberOfLines={1}>📄 Document</Text>
                  <Text style={styles.attachMsgMeta}>Document</Text>
                </View>
              </View>
              {item.content && item.content !== item.metadata?.attachment?.name && item.content !== 'Attachment' && (
                <Text style={isIncoming ? styles.incomingText : styles.outgoingText}>{item.content}</Text>
              )}
              <Text style={isIncoming ? styles.incomingTime : styles.outgoingTime}>{formatTime(item.created_at)}</Text>
            </View>
          </View>
        );
      }
      if (msgType === 'audio' && item.metadata?.attachment) {
        const uri = item.metadata.attachment?.url || item.metadata.attachment?.uri;
        const isPlaying = playingUri === uri;
        const isIncoming = item.role === 'user';
        content = (
          <View style={isIncoming ? styles.incomingContainer : styles.outgoingContainer}>
            <Pressable
              style={isIncoming ? styles.incomingBubble : styles.outgoingBubble}
              onPress={() => handlePlayAudio(uri)}
              onLongPress={() => {
                setSelectedMessage(item);
                setMessageMenuVisible(true);
              }}
              delayLongPress={300}
              android_disableSound
            >
              <View style={styles.attachMsgCard}>
                <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={36} color='#075E54' />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attachMsgName} numberOfLines={1}>{item.metadata.attachment?.name}</Text>
                  <Text style={styles.attachMsgMeta}>{isPlaying ? 'Playing...' : 'Audio'}</Text>
                </View>
              </View>
              {item.content && item.content !== item.metadata?.attachment?.name && item.content !== 'Attachment' && (
                <Text style={isIncoming ? styles.incomingText : styles.outgoingText}>{item.content}</Text>
              )}
              <Text style={isIncoming ? styles.incomingTime : styles.outgoingTime}>{formatTime(item.created_at)}</Text>
            </Pressable>
          </View>
        );
      }
    })()}

    if (!content) {
    if (item.message_type === 'invoice_card' || item.card_type === 'invoice_card') {
      content = renderInvoiceCard(item);
    } else if (item.message_type === 'ai_query') {
      // Owner's AI query — right-aligned teal bubble
      const aiQueryModality = item.input_modality || 'text';
      const aiQueryAttachUrl = item.metadata?.attachment?.url || null;
      const isAiQueryAudio = aiQueryModality === 'audio' && !!aiQueryAttachUrl;
      const isAiQueryImage = aiQueryModality === 'image' && !!aiQueryAttachUrl;
      const aiQueryDisplayText = (item.content && item.content !== '🎤 Voice note') ? item.content : null;
      content = (
        <View style={styles.outgoingContainer}>
          <View style={[styles.outgoingBubble, { backgroundColor: '#E0F2F1' }]}>
            {isAiQueryAudio ? (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}
                onPress={() => handlePlayAudio(aiQueryAttachUrl!)}
              >
                <Ionicons name={playingUri === aiQueryAttachUrl ? 'pause-circle' : 'play-circle'} size={32} color="#00695C" />
                <Text style={[styles.outgoingText, { color: '#00695C' }]}>🎤 Voice note</Text>
              </TouchableOpacity>
            ) : isAiQueryImage ? (
              <Image source={{ uri: aiQueryAttachUrl! }} style={{ width: 180, height: 180, borderRadius: 8, marginBottom: 4 }} resizeMode="cover" />
            ) : null}
            {!isAiQueryAudio && aiQueryDisplayText ? (
              <Text style={[styles.outgoingText, { color: '#00695C' }]}>{aiQueryDisplayText}</Text>
            ) : null}
            <Text style={styles.outgoingTime}>{formatTime(item.created_at)}</Text>
          </View>
        </View>
      );
    } else if (item.message_type === 'ai_response' || item.message_type === 'action_card') {
      // AI response — left-aligned with AI icon
      const isActionCard = item.message_type === 'action_card' || item.card_data?.shareable === true || item.metadata?.shareable === true;
      content = (
        <View style={styles.incomingContainer}>
          <View style={[styles.incomingBubble, { backgroundColor: isActionCard ? '#FFF8F0' : '#F0FAF8', borderLeftWidth: 3, borderLeftColor: isActionCard ? '#E91E63' : '#075E54' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Ionicons name="sparkles" size={14} color={isActionCard ? '#E91E63' : '#075E54'} />
              <Text style={{ fontSize: 11, fontWeight: '700', color: isActionCard ? '#E91E63' : '#075E54' }}>{isActionCard ? 'AI Draft' : 'AI'}</Text>
            </View>
            <Text style={styles.incomingText}>{(item.content || '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')}</Text>
            <Text style={styles.incomingTime}>{formatTime(item.created_at)}</Text>
          </View>
          {isActionCard && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, marginLeft: 4, marginBottom: 4 }}>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#075E54', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}
                onPress={() => {
                  setInputText(item.content);
                  setActiveTab('direct');
                }}
              >
                <Ionicons name="chatbubble-outline" size={12} color="#075E54" />
                <Text style={{ fontSize: 11, color: '#075E54', marginLeft: 4 }}>Use in Chat</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#25D366', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}
                onPress={() => {
                  const rawPhone = customer?.phone?.replace(/[^0-9]/g, '') || '';
                  const phone = rawPhone.startsWith('91') ? rawPhone : '91' + rawPhone;
                  const waUrl = phone
                    ? 'https://wa.me/' + phone + '?text=' + encodeURIComponent(item.content)
                    : 'https://wa.me/?text=' + encodeURIComponent(item.content);
                  Linking.openURL(waUrl).catch(() => {});
                }}
              >
                <Ionicons name="logo-whatsapp" size={12} color="#25D366" />
                <Text style={{ fontSize: 11, color: '#25D366', marginLeft: 4 }}>WhatsApp</Text>
              </TouchableOpacity>
            </View>
          )}
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
    }

    const canLongPress =
      item.role !== 'system' &&
      item.message_type !== 'system_alert' &&
      item.message_type !== 'spark_clarify' &&
      item.message_type !== 'ai_response' &&
      item.message_type !== 'action_card' &&
      item.message_type !== 'ai_query' &&
      (item.metadata?.message_type || item.message_type) !== 'image' &&
      (item.metadata?.message_type || item.message_type) !== 'audio';

    const wrappedContent = canLongPress ? (
      <Pressable
        android_disableSound
        onLongPress={() => {
          setSelectedMessage(item);
          setMessageMenuVisible(true);
        }}
        delayLongPress={300}
        delayPressIn={0}
      >
        {content}
      </Pressable>
    ) : content;

    return (
      <>
        {divider}
        {wrappedContent}
      </>
    );
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
      return m.visibility === 'owner_only' || m.message_type === 'ai_query' || m.message_type === 'ai_response' || m.message_type === 'action_card' || m.message_type === 'system_alert' || m.message_type === 'spark_clarify';
    }
  });

  const displayMessages = activeTab === 'ai' ? aiMessages : filtered;
  // ── Main render ────────────────────────────────────────────
  const canSend = !sparkMode && (attachmentPreview
    ? attachmentPreview.upload_status === 'ready'
    : inputText.trim().length > 0);

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
            style={[styles.tab, activeTab === 'ai' && styles.tabActive, activeTab === 'ai' && { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }]}
            onPress={() => {
              if (activeTab === 'ai') {
                setShowConvDropdown(prev => !prev);
              } else {
                setActiveTab('ai');
                setShowConvDropdown(false);
              }
            }}
          >
            <Text style={[styles.tabText, activeTab === 'ai' && styles.tabTextActive]}>AI Messages</Text>
            {activeTab === 'ai' && (
              <Ionicons
                name={showConvDropdown ? 'chevron-up' : 'chevron-down'}
                size={12}
                color="#FFFFFF"
                style={{ marginLeft: 3 }}
              />
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* AI Conversation Dropdown - floating overlay */}
      {activeTab === 'ai' && showConvDropdown && (
        <Pressable
          style={styles.convDropdownOverlay}
          onPress={() => setShowConvDropdown(false)}
        >
          <Pressable style={styles.convDropdownContainer} onPress={() => {}}>
            <TouchableOpacity
              style={styles.convDropdownNewBtn}
              onPress={createNewAiConversation}
              disabled={loadingConversations}
            >
              <Ionicons name="create-outline" size={16} color="#075E54" />
              <Text style={styles.convDropdownNewBtnText}>New Chat</Text>
            </TouchableOpacity>
            <View style={styles.convDropdownDivider} />
            <ScrollView style={styles.convDropdownList} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {aiConversations.map((conv) => (
                <TouchableOpacity
                  key={conv.id}
                  style={[styles.convDropdownItem, conv.id === activeAiConvId && styles.convDropdownItemActive]}
                  onPress={() => switchAiConversation(conv.id)}
                >
                  <Text style={[styles.convDropdownItemTitle, conv.id === activeAiConvId && styles.convDropdownItemTitleActive]} numberOfLines={1} ellipsizeMode="tail">
                    {conv.title || new Date(conv.created_at).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      )}

      {/* Chat area — filtered by active tab */}
      <View style={styles.chatArea}>
        {activeTab === 'broadcast' ? (
          <View style={styles.emptyState}>
            <Ionicons name="megaphone-outline" size={48} color="#CCC" />
            <Text style={styles.emptyText}>Broadcast Messages</Text>
            <Text style={[styles.emptyText, { fontSize: 13, marginTop: 4 }]}>Coming soon</Text>
          </View>
        ) : displayMessages.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name={activeTab === 'ai' ? 'sparkles-outline' : 'chatbubbles-outline'} size={48} color="#CCC" />
            <Text style={styles.emptyText}>
              {activeTab === 'ai' ? `Ask AI anything about ${customer?.name || 'this customer'}` : 'No messages yet'}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={displayMessages}
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
        <View style={{ flex: 0 }}>
          {/* PILLS — above input bar, outside inputBarWrapper */}
          <View style={{ backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#E5E5E5', paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 3, gap: 6 }}>
              {CUSTOMER_AI_PILLS_ROW1.map(pill => (
                <TouchableOpacity key={pill.id} onPress={() => sendCapsuleQuery(pill.query)} style={styles.capsulePill} activeOpacity={0.7}>
                  <Text style={{ fontSize: 11 }}>{pill.icon} {pill.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={toggleCapsuleExpand} style={[styles.capsulePill, { paddingHorizontal: 10 }]}>
                <Ionicons name={capsuleExpanded ? 'chevron-up' : 'chevron-down'} size={14} color="#075E54" />
              </TouchableOpacity>
            </ScrollView>
            {capsuleExpanded && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 3, gap: 6 }}>
                {CUSTOMER_AI_PILLS_ROW2.map(pill => (
                  <TouchableOpacity key={pill.id} onPress={() => sendCapsuleQuery(pill.query)} style={styles.capsulePill} activeOpacity={0.7}>
                    <Text style={{ fontSize: 11 }}>{pill.icon} {pill.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
          {/* INPUT BAR — same shell as Direct Messages */}
          <View style={[styles.inputBarWrapper, { paddingBottom: insets.bottom }]}>
            {aiQuerying && (
              <View style={styles.sparkProcessingBar}>
                <ActivityIndicator size="small" color="#075E54" />
                <Text style={styles.sparkProcessingText}>AI is thinking...</Text>
              </View>
            )}
            {aiAttachment && (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 4, backgroundColor: '#F0F0F0' }}>
                {aiAttachment.type === 'image' && aiAttachment.url ? (
                  <Image source={{ uri: aiAttachment.url }} style={{ width: 36, height: 36, borderRadius: 4, marginRight: 6 }} />
                ) : (
                  <Ionicons name={aiAttachment.type === 'audio' ? 'mic' : 'document'} size={16} color="#075E54" style={{ marginRight: 6 }} />
                )}
                <Text style={{ fontSize: 12, color: '#333', flex: 1 }} numberOfLines={1}>{aiAttachment.type === 'audio' ? '🎤 Voice note' : aiAttachment.type === 'image' ? '🖼 Image' : '📄 Document'}</Text>
                <TouchableOpacity onPress={() => setAiAttachment(null)}>
                  <Ionicons name="close-circle" size={18} color="#999" />
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.inputRow}>
              <View style={[styles.inputPill, styles.aiInputPill]}>
                <TouchableOpacity style={styles.inputIconBtn}>
                  <Ionicons name="sparkles" size={22} color="#075E54" />
                </TouchableOpacity>
                <TextInput
                  style={styles.textInput}
                  placeholder={`Ask about ${customer?.name || 'this customer'}...`}
                  placeholderTextColor="#AAA"
                  value={aiQueryText}
                  onChangeText={setAiQueryText}
                  multiline
                  maxLength={2000}
                />
                <TouchableOpacity style={styles.inputIconBtn} onPress={() => setAttachSheetVisible(true)}>
                  <Ionicons name="attach" size={22} color="#E91E63" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.inputIconBtn} onPress={handleOpenCamera}>
                  <Ionicons name="camera-outline" size={22} color="#E91E63" />
                </TouchableOpacity>
              </View>
              {(aiQueryText.trim().length > 0 || aiAttachment) ? (
                <TouchableOpacity
                  style={[styles.sendBtn, { backgroundColor: '#E91E63' }]}
                  onPress={handleAiQuery}
                  disabled={aiQuerying}
                >
                  {aiQuerying ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="send" size={20} color="#FFF" />}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.micBtn, { backgroundColor: '#E91E63' }]}
                  onPress={handleAudioRecording}
                >
                  <Ionicons name={isRecording ? 'stop' : 'mic'} size={22} color="#FFF" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      ) : (
        /* Direct Messages input */
        <>
          <View style={[styles.inputBarWrapper, { paddingBottom: insets.bottom }]}>
          {attachmentPreview && !sparkMode && (
            <View style={styles.attachPreviewStrip}>
              {attachmentPreview.mime_type?.startsWith?.('image') && attachmentPreview.uri ? (
                <Image source={{ uri: attachmentPreview.uri }} style={{ width: 40, height: 40, borderRadius: 4, marginRight: 4 }} />
              ) : (
                <Ionicons
                  name={
                    attachmentPreview.mime_type?.startsWith?.('audio') ? 'musical-notes-outline' :
                    'document-outline'
                  }
                  size={28} color="#075E54"
                />
              )}
              <Text style={styles.attachPreviewName} numberOfLines={1}>
                {attachmentPreview.mime_type?.startsWith('image') ? 'Image' :
                 attachmentPreview.mime_type?.startsWith('audio') ? 'Audio' : 'Document'}
              </Text>
              {attachmentPreview.upload_status === 'uploading' && (
                <ActivityIndicator size="small" color="#075E54" style={{ marginRight: 4 }} />
              )}
              {attachmentPreview.upload_status === 'failed' && (
                <TouchableOpacity onPress={handleRetryUpload}>
                  <Ionicons name="refresh-circle" size={22} color="#D32F2F" style={{ marginRight: 4 }} />
                </TouchableOpacity>
              )}
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
            <>
          {sparkMode && forwardedAttachment && (
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: '#E8F5E9', borderRadius: 8,
              marginHorizontal: 8, marginBottom: 4,
              paddingHorizontal: 10, paddingVertical: 6,
              borderLeftWidth: 3, borderLeftColor: '#075E54',
            }}>
              {forwardedAttachment.type === 'image' && forwardedAttachment.url ? (
                <Image
                  source={{ uri: forwardedAttachment.url }}
                  style={{ width: 40, height: 40, borderRadius: 4, marginRight: 8 }}
                  resizeMode="cover"
                />
              ) : (
                <Ionicons
                  name={
                    forwardedAttachment.type === 'audio' ? 'musical-notes-outline' :
                    forwardedAttachment.type === 'file' ? 'document-outline' :
                    'chatbubble-outline'
                  }
                  size={20} color="#075E54" style={{ marginRight: 8 }}
                />
              )}
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: '#075E54' }}>
                {forwardedAttachment.type === 'text'
                  ? forwardedAttachment.text
                  : forwardedAttachment.type === 'audio' ? 'Audio'
                  : forwardedAttachment.type === 'image' ? 'Image'
                  : forwardedAttachment.type === 'file' ? 'Document'
                  : forwardedAttachment.name || forwardedAttachment.type}
              </Text>
              <TouchableOpacity onPress={() => resetSparkState()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={18} color="#075E54" />
              </TouchableOpacity>
            </View>
          )}
          </>
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
                placeholder={sparkMode ? sparkTips[currentTipIndex] : 'Message or voice...'}
                placeholderTextColor={sparkMode ? '#AAAAAA' : '#999'}
                value={inputText}
                onChangeText={setInputText}
                multiline
                maxLength={2000}
              />
              <>
                <TouchableOpacity style={styles.inputIconBtn} onPress={() => setAttachSheetVisible(true)}>
                  <Ionicons name="attach" size={22} color={sparkMode ? '#E91E63' : '#667781'} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.inputIconBtn} onPress={handleOpenCamera}>
                  <Ionicons name="camera-outline" size={22} color={sparkMode ? '#E91E63' : '#667781'} />
                </TouchableOpacity>
              </>
              {sparkMode && !forwardedAttachment && (
                <TouchableOpacity onPress={() => resetSparkState()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.inputIconBtn}>
                  <Ionicons name="close-circle" size={20} color="#999" />
                </TouchableOpacity>
              )}
            </View>
            {sparkMode ? (
              sparkWorkflowState === 'uploading' ? (
                <View style={[styles.micBtn, { backgroundColor: '#E91E63', justifyContent: 'center', alignItems: 'center' }]}>
                  <ActivityIndicator size="small" color="#FFF" />
                </View>
              ) : sparkWorkflowState === 'upload_failed' ? (
                <TouchableOpacity style={[styles.micBtn, { backgroundColor: '#B00020' }]} onPress={handleRetryUpload}>
                  <Ionicons name="refresh" size={22} color="#FFF" />
                </TouchableOpacity>
              ) : sparkWorkflowState === 'processing' ? (
                <View style={[styles.sendBtn, styles.sparkSendBtn, { justifyContent: 'center', alignItems: 'center' }]}>
                  <ActivityIndicator size="small" color="#FFF" />
                </View>
              ) : sparkWorkflowState === 'attachment_ready' || (sparkWorkflowState === 'idle' && inputText.trim().length > 0) ? (
                <TouchableOpacity style={[styles.sendBtn, styles.sparkSendBtn]} onPress={handleSpark}>
                  <Ionicons name="send" size={20} color="#FFF" />
                </TouchableOpacity>
              ) : sparkWorkflowState === 'recording_audio' ? (
                <TouchableOpacity style={[styles.micBtn, { backgroundColor: '#E91E63' }]} onPress={handleAudioRecording}>
                  <Ionicons name="stop" size={22} color="#FFF" />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={[styles.micBtn, { backgroundColor: '#E91E63' }]} onPress={handleAudioRecording}>
                  <Ionicons name="mic" size={22} color="#FFF" />
                </TouchableOpacity>
              )
            ) : canSend ? (
              <TouchableOpacity style={styles.sendBtn} onPress={handleSend} disabled={sending}>
                {sending ? <ActivityIndicator size="small" color="#FFF" /> : <Ionicons name="send" size={20} color="#FFF" />}
              </TouchableOpacity>
            ) : (
              <View style={{ position: 'relative' }}>
                <TouchableOpacity style={styles.sparkFab} onPress={() => { setSparkMode(true); setSparkWorkflowState('idle'); }}>
                  <Ionicons name="sparkles" size={22} color="#FFF" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.micBtn} onPress={handleAudioRecording}>
                  <Ionicons name={isRecording ? 'stop' : 'mic'} size={22} color="#FFF" />
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
                        const unresolvedPrice = unresolvedPrices[itemKey] ?? (item.unit_price != null ? String(item.unit_price) : '');
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
                                {isUnresolved ? (
                                  <View style={styles.editableRow}>
                                    <TextInput
                                      style={styles.editableQtyInput}
                                      placeholder="Qty"
                                      placeholderTextColor="#999"
                                      keyboardType="numeric"
                                      value={editableQuantities[itemKey] ?? String(item.quantity || '')}
                                      onChangeText={(text) => setEditableQuantities(prev => ({ ...prev, [itemKey]: text.replace(/[^0-9.]/g, '') }))}
                                    />
                                    <Text style={{ fontSize: 14, color: '#333' }}>×</Text>
                                    <TextInput
                                      style={styles.editableNameInput}
                                      placeholder="Product name"
                                      placeholderTextColor="#999"
                                      value={unresolvedNames[itemKey] ?? item.product_name}
                                      onChangeText={(text) => setUnresolvedNames(prev => ({ ...prev, [itemKey]: text }))}
                                      onEndEditing={async (e) => {
                                        const typedName = (e.nativeEvent.text || '').trim();
                                        const currentName = (item.product_name || '').trim().toLowerCase();
                                        const lookupName = typedName.toLowerCase();
                                        if (!lookupName || lookupName === currentName) return;
                                        try {
                                          const token = await getToken();
                                          const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
                                          const findRes = await fetch(
                                            `${backendUrl}/api/products/find?name=${encodeURIComponent(typedName)}`,
                                            { headers: { 'Authorization': `Bearer ${token}` } }
                                          );
                                          const existing = findRes.ok ? await findRes.json() : null;
                                          if (existing?.id) {
                                            setUnresolvedPrices(prev => ({ ...prev, [itemKey]: String(existing.selling_price ?? '') }));
                                            setUnresolvedGst(prev => ({ ...prev, [itemKey]: String(existing.tax_rate ?? '0') }));
                                          }
                                        } catch {}
                                      }}
                                    />
                                  </View>
                                ) : (
                                  <Text style={styles.invoiceItemName}>
                                    {item.quantity} × {item.product_name}
                                  </Text>
                                )}
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
                            {!isUnresolved && item.alternatives?.length > 0 && (
                              <View style={styles.altRow}>
                                <Text style={styles.altLabel}>Also found:</Text>
                                {item.alternatives.filter((a: any) => a.id !== item.product_id).slice(0, 3).map((alt: any) => (
                                  <TouchableOpacity key={alt.id} style={styles.altChip} onPress={async () => {
                                    try {
                                      const token = await getToken();
                                      if (!token) return;
                                      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
                                      // Rebuild alternatives reciprocally — previous main product becomes chip
                                      const prevProduct = {
                                        id: item.product_id,
                                        name: item.product_name,
                                        selling_price: item.unit_price,
                                        tax_rate: item.tax_rate,
                                      };
                                      const newAlternatives = [
                                        prevProduct,
                                        ...item.alternatives.filter((a: any) => a.id !== alt.id && a.id !== item.product_id)
                                      ].slice(0, 2);
                                      const replacementItem = {
                                        raw_product_name: item.raw_product_name || item.product_name,
                                        product_id: alt.id,
                                        product_name: alt.name,
                                        unit_price: alt.selling_price,
                                        tax_rate: alt.tax_rate ?? item.tax_rate,
                                        quantity: item.quantity,
                                        line_total: alt.selling_price * item.quantity,
                                        alternatives: newAlternatives,
                                        source_type: 'chip_override',
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

      {/* Context Menu Modal */}
      <Modal
        visible={messageMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setMessageMenuVisible(false);
          setSelectedMessage(null);
        }}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}
          onPress={() => {
            setMessageMenuVisible(false);
            setSelectedMessage(null);
          }}
        >
          <Pressable onPress={() => {}}>
            <View style={{
              backgroundColor: '#FFF',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingBottom: 36,
              paddingTop: 12,
            }}>

              {/* Handle bar */}
              <View style={{
                width: 40, height: 4, backgroundColor: '#DDD',
                borderRadius: 2, alignSelf: 'center', marginBottom: 20
              }} />

              {/* Forward to AI Spark — ACTIVE */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center',
                  paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0'
                }}
                onPress={() => {
                  if (selectedMessage) handleForwardToSpark(selectedMessage);
                }}
              >
                <Ionicons name="sparkles" size={22} color="#075E54" style={{ marginRight: 16 }} />
                <Text style={{ fontSize: 16, color: '#075E54', fontWeight: '600' }}>Forward to AI Spark</Text>
              </TouchableOpacity>
              {/* Copy — GREYED, requires native build */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center',
                  paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0', opacity: 0.4
                }}
                disabled
              >
                <Ionicons name="copy-outline" size={22} color="#333" style={{ marginRight: 16 }} />
                <Text style={{ fontSize: 16, color: '#333' }}>Copy</Text>
                <Text style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>Coming soon</Text>
              </TouchableOpacity>

              {/* Save Media — GREYED, only shown for image or audio messages */}
              {((selectedMessage?.metadata?.message_type || selectedMessage?.message_type) === 'image' ||
                (selectedMessage?.metadata?.message_type || selectedMessage?.message_type) === 'audio') && (
                <TouchableOpacity
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0', opacity: 0.4
                  }}
                  disabled
                >
                  <Ionicons name="download-outline" size={22} color="#333" style={{ marginRight: 16 }} />
                  <Text style={{ fontSize: 16, color: '#333' }}>Save Media</Text>
                  <Text style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>Coming soon</Text>
                </TouchableOpacity>
              )}

              {/* Delete — GREYED, coming soon */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center',
                  paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0', opacity: 0.4
                }}
                disabled
              >
                <Ionicons name="trash-outline" size={22} color="#D32F2F" style={{ marginRight: 16 }} />
                <Text style={{ fontSize: 16, color: '#D32F2F' }}>Delete</Text>
                <Text style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>Coming soon</Text>
              </TouchableOpacity>

              {/* Reply — GREYED, coming soon */}
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center',
                  paddingVertical: 14, opacity: 0.4
                }}
                disabled
              >
                <Ionicons name="return-down-back-outline" size={22} color="#333" style={{ marginRight: 16 }} />
                <Text style={{ fontSize: 16, color: '#333' }}>Reply</Text>
                <Text style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>Coming soon</Text>
              </TouchableOpacity>

            </View>
          </Pressable>
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
  capsulePill: {
    backgroundColor: '#F0FAF8',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#B3E5DB',
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
    backgroundColor: '#E91E63',
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
  editableQtyInput: {
    borderWidth: 1, borderColor: '#F9A825', borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 4,
    width: 50, fontSize: 14, color: '#333', textAlign: 'center',
  },
  editableNameInput: {
    borderWidth: 1, borderColor: '#F9A825', borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 4,
    flex: 1, fontSize: 14, color: '#333',
  },
  editableRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4,
  },
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

  // AI Conversation Dropdown
  convDropdownOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 1000,
    elevation: 20,
  },
  convDropdownContainer: {
    position: 'absolute',
    top: 140,
    right: 8,
    width: 240,
    backgroundColor: '#FFF',
    borderRadius: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    paddingVertical: 4,
    zIndex: 1001,
  },
  convDropdownNewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  convDropdownNewBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#075E54',
    marginLeft: 8,
  },
  convDropdownDivider: {
    height: 1,
    backgroundColor: '#EEEEEE',
    marginHorizontal: 12,
  },
  convDropdownList: {
    maxHeight: 220,
  },
  convDropdownItem: {
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  convDropdownItemActive: {
    backgroundColor: '#E8F5E9',
  },
  convDropdownItemTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#333',
  },
  convDropdownItemTitleActive: {
    color: '#075E54',
    fontWeight: '600',
  },
});
