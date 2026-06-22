import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { authService } from '../lib/auth';
import { uploadFile } from '../lib/upload';

// Voice Reminder, Phase 2 steps 5-6+8 -- recording UI, AI processing
// state, and the confirmation sheet (Edit/Cancel/Confirm). Recording
// mechanics mirror ai.tsx's proven Audio.Recording pattern exactly, not
// a new implementation. Visually matches Spark's "I've prepared this:"
// confirmation language (the established UX pattern in this app), but is
// new, purpose-built code -- that confirmation sheet is inline in a
// large, mature screen and was deliberately not refactored to share.
//
// Confirm uses router.back(), matching task-detail.tsx's own handleSave
// exactly (verified against the real file, same already-tested pattern)
// -- not a redirect to Activity Center, which would be a deviation from
// established, working precedent rather than a fix.
//
// Edit hands off to task-detail.tsx as a full manual-editing flow with no
// return path back to this draft sheet -- intentional, not an omission:
// once editing starts, the owner is reviewing/adjusting a normal
// reminder, not continuing the voice-specific flow.

type ScreenState = 'recording' | 'processing' | 'draft' | 'error';

interface Draft {
  transcript: string;
  title: string;
  description: string | null;
  due_date: string | null;
  repeat_pattern: string | null;
  customer_id: string | null;
  customer_name: string | null;
  confidence: number;
}

const REPEAT_LABELS: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

export default function VoiceReminderScreen() {
  const router = useRouter();
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

  const [state, setState] = useState<ScreenState>('recording');
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    startRecording();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      // Covers the case where the user navigates away unexpectedly while
      // still recording -- without this, the audio session could remain
      // active after the screen unmounts.
      resetAudioMode();
    };
  }, []);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { router.back(); return null; }
    return token;
  };

  const startRecording = async () => {
    // Defensive clear before creating a new interval -- without this, a
    // failed flow followed by a retry could accumulate multiple timers.
    if (timerRef.current) clearInterval(timerRef.current);
    // Explicitly clear any stale recording instance before a retry --
    // ensures retry initialization starts from a fully clean state.
    setRecording(null);
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow microphone access.');
        router.back();
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecording(rec);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch (e) {
      console.error('Voice reminder recording start error:', e);
      Alert.alert('Error', 'Could not start recording.');
      router.back();
    }
  };

  // Resets the audio session after recording -- ai.tsx's own mic flow
  // doesn't do this (checked directly, no reset exists there either),
  // so this is a deliberate improvement beyond established precedent,
  // not a correction to match it. Avoids odd audio-session behavior
  // (e.g. silent-mode playback) persisting after this screen closes.
  const resetAudioMode = async () => {
    try { await Audio.setAudioModeAsync({ allowsRecordingIOS: false }); } catch {}
  };

  const handleCancel = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recording) {
      try { await recording.stopAndUnloadAsync(); } catch {}
    }
    await resetAudioMode();
    router.back();
  };

  const handleStop = async () => {
    if (!recording) return;
    if (timerRef.current) clearInterval(timerRef.current);
    setState('processing');
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      await resetAudioMode();
      if (!uri) throw new Error('No recording URI');

      const token = await getToken();
      if (!token) return;

      const fileName = `voice_reminder_${Date.now()}.m4a`;
      const uploaded = await uploadFile(uri, fileName, 'audio/x-m4a');
      if (!uploaded) throw new Error('Upload failed');

      const res = await fetch(`${backendUrl}/api/voice-reminder/draft`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: uploaded.url,
          file_name: uploaded.name || fileName,
          mime_type: uploaded.mime_type || 'audio/x-m4a',
        }),
      });
      const data = await res.json();
      if (!data.success || !data.draft) {
        setErrorMsg(data.error === 'invalid_audio' || data.error === 'empty_transcript'
          ? 'Voice not clear. Please try again.'
          : 'Could not process recording. Please try again.');
        setState('error');
        return;
      }
      setDraft(data.draft);
      setState('draft');
    } catch (e) {
      console.error('Voice reminder processing error:', e);
      setErrorMsg('Something went wrong. Please try again.');
      setState('error');
    }
  };

  const handleConfirm = async () => {
    if (!draft) return;
    if (!draft.title?.trim()) {
      Alert.alert('Missing Title', 'Could not determine a title for this reminder. Please use Edit instead.');
      return;
    }
    setConfirming(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${backendUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          description: draft.description,
          due_date: draft.due_date || new Date().toISOString().split('T')[0],
          repeat_pattern: draft.repeat_pattern,
          customer_id: draft.customer_id,
        }),
      });
      if (!res.ok) throw new Error('Create failed');
      router.back();
    } catch (e) {
      console.error('Voice reminder confirm error:', e);
      Alert.alert('Error', 'Failed to create reminder. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  const handleEdit = () => {
    if (!draft) return;
    // router.replace, not router.push -- Edit hands off completely (no
    // return path to this draft sheet, per the original design intent).
    // push() was leaving this screen in the navigation stack, so
    // task-detail.tsx's own router.back() (on X or Save) was incorrectly
    // landing back on this draft sheet instead of wherever Voice
    // Reminder was originally opened from.
    router.replace({
      pathname: '/task-detail',
      params: {
        draft_title: draft.title,
        draft_description: draft.description || '',
        draft_due_date: draft.due_date || '',
        draft_repeat_pattern: draft.repeat_pattern || '',
        draft_customer_name: draft.customer_name || '',
        draft_customer_id: draft.customer_id || '',
        draft_confidence: String(draft.confidence),
        draft_transcript: draft.transcript,
      },
    });
  };

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date set';

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      {state === 'recording' && (
        <View style={s.center}>
          <View style={s.micCircle}>
            <Ionicons name="mic" size={48} color="#FFF" />
          </View>
          <Text style={s.listeningText}>Listening...</Text>
          <Text style={s.timerText}>{fmtTime(seconds)}</Text>
          <View style={s.recordingActions}>
            <TouchableOpacity style={s.cancelBtn} onPress={handleCancel}>
              <Text style={s.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.stopBtn} onPress={handleStop}>
              <Ionicons name="stop" size={28} color="#FFF" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {state === 'processing' && (
        <View style={s.center}>
          <ActivityIndicator size="large" color="#075E54" />
          <Text style={s.processingText}>Understanding reminder...</Text>
        </View>
      )}

      {state === 'error' && (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={48} color="#D32F2F" />
          <Text style={s.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => { setState('recording'); startRecording(); }}>
            <Text style={s.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={s.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {state === 'draft' && draft && (
        <View style={s.draftSheet}>
          <Text style={s.sheetHeading}>AI Drafted Reminder</Text>

          <View style={s.heardBox}>
            <Text style={s.heardLabel}>I heard:</Text>
            <Text style={s.heardText}>"{draft.transcript}"</Text>
          </View>

          <View style={s.draftField}>
            <Text style={s.draftFieldLabel}>Title</Text>
            <Text style={s.draftFieldValue}>{draft.title}</Text>
          </View>
          <View style={s.draftField}>
            <Text style={s.draftFieldLabel}>Due Date</Text>
            <Text style={s.draftFieldValue}>{fmtDate(draft.due_date)}</Text>
          </View>
          {draft.repeat_pattern && (
            <View style={s.draftField}>
              <Text style={s.draftFieldLabel}>Repeat</Text>
              <Text style={s.draftFieldValue}>{REPEAT_LABELS[draft.repeat_pattern]}</Text>
            </View>
          )}
          {draft.customer_name && (
            <View style={s.draftField}>
              <Text style={s.draftFieldLabel}>Mentioned customer (not linked yet)</Text>
              <Text style={s.draftFieldValue}>{draft.customer_name}</Text>
            </View>
          )}

          <View style={s.draftActions}>
            <TouchableOpacity style={s.editBtn} onPress={handleEdit}>
              <Text style={s.editBtnText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.confirmBtn} onPress={handleConfirm} disabled={confirming}>
              {confirming ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.confirmBtnText}>Confirm</Text>}
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={s.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16, padding: 24 },
  micCircle: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: '#075E54',
    justifyContent: 'center', alignItems: 'center',
  },
  listeningText: { fontSize: 20, fontWeight: '600', color: '#1A1A1A', marginTop: 8 },
  timerText: { fontSize: 32, fontWeight: '300', color: '#667781' },
  recordingActions: { flexDirection: 'row', alignItems: 'center', gap: 24, marginTop: 24 },
  cancelBtn: { paddingHorizontal: 24, paddingVertical: 14 },
  cancelBtnText: { fontSize: 16, color: '#667781', fontWeight: '600' },
  stopBtn: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: '#D32F2F',
    justifyContent: 'center', alignItems: 'center',
  },
  processingText: { fontSize: 17, color: '#667781', marginTop: 8 },
  errorText: { fontSize: 16, color: '#1A1A1A', textAlign: 'center' },
  retryBtn: { backgroundColor: '#075E54', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24, marginTop: 8 },
  retryBtnText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  cancelLinkText: { fontSize: 15, color: '#667781', marginTop: 8 },
  draftSheet: { flex: 1, padding: 20, justifyContent: 'center' },
  sheetHeading: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 16 },
  heardBox: { backgroundColor: '#F5F5F5', borderRadius: 10, padding: 14, marginBottom: 16 },
  heardLabel: { fontSize: 12, color: '#667781', fontWeight: '600', marginBottom: 4 },
  heardText: { fontSize: 14, color: '#333', fontStyle: 'italic' },
  draftField: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  draftFieldLabel: { fontSize: 14, color: '#667781' },
  draftFieldValue: { fontSize: 15, color: '#1A1A1A', fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  draftActions: { flexDirection: 'row', gap: 12, marginTop: 24 },
  editBtn: { flex: 1, paddingVertical: 14, borderRadius: 24, borderWidth: 1, borderColor: '#075E54', alignItems: 'center' },
  editBtnText: { color: '#075E54', fontSize: 16, fontWeight: '600' },
  confirmBtn: { flex: 1, paddingVertical: 14, borderRadius: 24, backgroundColor: '#075E54', alignItems: 'center' },
  confirmBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
});
