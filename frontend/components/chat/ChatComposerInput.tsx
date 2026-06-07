/**
 * AssistMe — ChatComposerInput.tsx
 * Created: Phase 2, Jun 2026
 *
 * Presentational composer component. Owns zero business logic.
 * All state, uploads, permissions, recording remain in parent.
 *
 * Consumers (v1): app/ai.tsx (Org AI tab)
 * Future consumers: app/chat/[customer_id].tsx, broadcast, group chat
 * Extraction target: COMPOSER-EXTRACT-01
 *
 * Props in. Callbacks out. Nothing else.
 * No useState for business data. No fetch. No permissions. No upload.
 */
import React, { useState, useEffect } from 'react';
import {
  View, TextInput, TouchableOpacity, Text,
  Image, StyleSheet, Platform, Keyboard, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { AiAttachment } from '../../types/chat';

export interface ChatComposerInputProps {
  inputText: string;
  onChangeText: (text: string) => void;
  attachment: AiAttachment | null;
  onClearAttachment: () => void;
  onSend: () => void;
  onMicPress: () => void;
  onPickGallery: () => void;
  onOpenCamera: () => void;
  isRecording: boolean;
  disabled: boolean;
  placeholder?: string;
  accentColor?: string;
  leadingIcon?: React.ReactNode;
}

export function ChatComposerInput({
  inputText,
  onChangeText,
  attachment,
  onClearAttachment,
  onSend,
  onMicPress,
  onPickGallery,
  onOpenCamera,
  isRecording,
  disabled,
  placeholder = 'Type a message...',
  accentColor = '#075E54',
  leadingIcon,
}: ChatComposerInputProps) {
  const insets = useSafeAreaInsets();

  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s1 = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const s2 = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  const hasContent = inputText.trim().length > 0 || attachment !== null;
  const bottomPad = keyboardVisible ? 4 : insets.bottom + 4;

  return (
    <View style={{ backgroundColor: '#ECE5DD' }}>
      {attachment && (
        <View style={styles.previewStrip}>
          <Image source={{ uri: attachment.url }} style={styles.previewImg} resizeMode="cover" />
          <Text style={styles.previewName} numberOfLines={1}>{attachment.name}</Text>
          <TouchableOpacity onPress={onClearAttachment} style={styles.previewClear}>
            <Ionicons name="close-circle" size={20} color="#666666" />
          </TouchableOpacity>
        </View>
      )}

      <View style={[styles.composerRow, { paddingBottom: bottomPad }]}>
        <View style={[styles.inputPill, { borderColor: accentColor }]}>
          {leadingIcon && (
            <View style={styles.iconBtn}>{leadingIcon}</View>
          )}
          <TextInput
            style={styles.textInput}
            placeholder={placeholder}
            placeholderTextColor="#AAA"
            value={inputText}
            onChangeText={onChangeText}
            multiline
            maxLength={2000}
            editable={!disabled}
          />
          <TouchableOpacity style={styles.iconBtn} onPress={onPickGallery} disabled={disabled}>
            <Ionicons name="attach" size={22} color={disabled ? '#CCC' : accentColor} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={onOpenCamera} disabled={disabled}>
            <Ionicons name="camera-outline" size={22} color={disabled ? '#CCC' : accentColor} />
          </TouchableOpacity>
        </View>

        {hasContent ? (
          <TouchableOpacity
            style={[styles.roundBtn, { backgroundColor: accentColor }]}
            onPress={onSend}
            disabled={disabled}
          >
            {disabled
              ? <ActivityIndicator size="small" color="#FFF" />
              : <Ionicons name="send" size={20} color="#FFF" />
            }
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.roundBtn, { backgroundColor: isRecording ? '#e53935' : accentColor }]}
            onPress={onMicPress}
          >
            <Ionicons name={isRecording ? 'stop' : 'mic'} size={22} color="#FFF" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  previewStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: '#F8F8F8',
    borderTopWidth: 1, borderTopColor: '#E0E0E0',
  },
  previewImg: { width: 48, height: 48, borderRadius: 6, backgroundColor: '#E0E0E0' },
  previewName: { flex: 1, fontSize: 13, color: '#333333' },
  previewClear: { padding: 4 },
  composerRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 6, paddingTop: 4, gap: 6,
  },
  inputPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#FFFFFF', borderRadius: 24,
    paddingHorizontal: 8, minHeight: 44,
    borderWidth: 1.5,
  },
  textInput: {
    flex: 1, fontSize: 15, color: '#333333',
    maxHeight: 100, paddingVertical: 6,
  },
  iconBtn: { padding: 6 },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
  },
});
