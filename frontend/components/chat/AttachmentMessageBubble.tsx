/**
 * AssistMe — AttachmentMessageBubble.tsx
 * Reusable attachment message card — renders inner content only.
 *
 * Source: Extracted from chat/[customer_id].tsx lines 1633-1720 (proven in production).
 * Styles: attachMsgCard, attachMsgName, attachMsgMeta copied verbatim from lines 3329-3334.
 *
 * BOUNDARY: Renders INNER card only. Surface wraps in its own bubble container.
 * msgType derived internally from item — exact pattern from source line 1636.
 *
 * Consumers (Phase 1): app/ai.tsx (Org AI only)
 * Future consumers: app/chat/[customer_id].tsx (post-v1)
 * Customer chat untouched in this phase.
 *
 * Modifies existing production surface: NO
 */
import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface AttachmentBubbleItem {
  message_type?: string;
  metadata?: {
    message_type?: string;
    attachment?: {
      url?: string;
      uri?: string;
      mime_type?: string;
      name?: string;
    };
  };
  content?: string;
  created_at: string;
}

export interface AttachmentMessageBubbleProps {
  item: AttachmentBubbleItem;
  isPlaying?: boolean;
  onImagePress?: () => void;
  onAudioPress?: () => void;
  captionStyle?: object;
  timeStyle?: object;
  formatTime: (ts: string) => string;
}

export function AttachmentMessageBubble({
  item,
  isPlaying = false,
  onImagePress,
  onAudioPress,
  captionStyle,
  timeStyle,
  formatTime,
}: AttachmentMessageBubbleProps) {
  const msgType = item.metadata?.message_type || item.message_type;
  const attachment = item.metadata?.attachment;
  const attachUri = attachment?.url || attachment?.uri;
  const hasCaption = item.content &&
    item.content !== attachment?.name &&
    item.content !== 'Attachment';

  if (msgType === 'image' && attachment) {
    return (
      <TouchableOpacity onPress={onImagePress} activeOpacity={0.85}>
        <View style={styles.attachMsgCard}>
          <Image source={{ uri: attachUri }} style={{ width: 200, height: 160, borderRadius: 8, marginBottom: 4 }} resizeMode="cover" />
          <View style={{ flex: 1 }}>
            <Text style={styles.attachMsgName} numberOfLines={1}>🖼 Image</Text>
            <Text style={styles.attachMsgMeta}>Image</Text>
          </View>
        </View>
        {hasCaption && <Text style={captionStyle}>{item.content}</Text>}
        <Text style={timeStyle}>{formatTime(item.created_at)}</Text>
      </TouchableOpacity>
    );
  }

  if (msgType === 'audio' && attachment) {
    return (
      <TouchableOpacity onPress={onAudioPress} activeOpacity={0.85}>
        <View style={styles.attachMsgCard}>
          <Ionicons name={isPlaying ? 'pause-circle' : 'play-circle'} size={36} color="#075E54" />
          <View style={{ flex: 1 }}>
            <Text style={styles.attachMsgName} numberOfLines={1}>{attachment.name}</Text>
            <Text style={styles.attachMsgMeta}>{isPlaying ? 'Playing...' : 'Audio'}</Text>
          </View>
        </View>
        {hasCaption && <Text style={captionStyle}>{item.content}</Text>}
        <Text style={timeStyle}>{formatTime(item.created_at)}</Text>
      </TouchableOpacity>
    );
  }

  if (msgType === 'file' && attachment) {
    return (
      <View>
        <View style={styles.attachMsgCard}>
          <Ionicons name="document-outline" size={32} color="#075E54" />
          <View style={{ flex: 1 }}>
            <Text style={styles.attachMsgName} numberOfLines={1}>📄 Document</Text>
            <Text style={styles.attachMsgMeta}>Document</Text>
          </View>
        </View>
        {hasCaption && <Text style={captionStyle}>{item.content}</Text>}
        <Text style={timeStyle}>{formatTime(item.created_at)}</Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  attachMsgCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5',
    borderRadius: 10, padding: 10, marginTop: 4, minWidth: 180,
  },
  attachMsgName: { fontSize: 13, color: '#333', fontWeight: '500' },
  attachMsgMeta: { fontSize: 11, color: '#999', marginTop: 2 },
});
