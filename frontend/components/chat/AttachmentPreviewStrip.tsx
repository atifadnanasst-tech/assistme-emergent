/**
 * AssistMe — AttachmentPreviewStrip.tsx
 * Reusable attachment preview strip shown above the composer input.
 *
 * Source: Extracted verbatim from chat/[customer_id].tsx lines 2156-2186 (DM tab, proven in production).
 * Icons: musical-notes-outline (audio), document-outline (file), Image thumbnail.
 * Styles: attachPreviewStrip + attachPreviewName copied exactly from source (lines 3323-3328).
 *
 * Consumers (Phase 1): components/chat/ChatComposerInput.tsx → app/ai.tsx (Org AI only)
 * Future consumers: app/chat/[customer_id].tsx DM tab (post-v1, after Org AI stable)
 * Customer chat untouched in this phase.
 *
 * Modifies existing production surface: NO
 */
import React from 'react';
import {
  View, Text, TouchableOpacity, Image, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type UploadStatus = 'uploading' | 'ready' | 'failed';

export interface AttachmentPreviewProps {
  mime_type: string;
  uri?: string;            // local URI (before upload)
  url?: string;            // remote URL (after upload)
  onClear: () => void;
  upload_status?: UploadStatus;  // optional — DM uses this, Org AI Phase 1 does not
  onRetry?: () => void;          // optional — DM uses this, Org AI Phase 1 does not
}

export function AttachmentPreviewStrip({
  mime_type,
  uri,
  url,
  onClear,
  upload_status,
  onRetry,
}: AttachmentPreviewProps) {
  const displayUri = uri || url;

  return (
    <View style={styles.attachPreviewStrip}>
      {/* Thumbnail or icon — exact from DM lines 2158-2167 */}
      {mime_type?.startsWith?.('image') && displayUri ? (
        <Image
          source={{ uri: displayUri }}
          style={{ width: 40, height: 40, borderRadius: 4, marginRight: 4 }}
        />
      ) : (
        <Ionicons
          name={mime_type?.startsWith?.('audio') ? 'musical-notes-outline' : 'document-outline'}
          size={28}
          color="#075E54"
        />
      )}

      {/* Label — exact from DM lines 2168-2171 */}
      <Text style={styles.attachPreviewName} numberOfLines={1}>
        {mime_type?.startsWith('image') ? 'Image' :
         mime_type?.startsWith('audio') ? 'Audio' : 'Document'}
      </Text>

      {/* Upload status — exact from DM lines 2172-2180, optional props */}
      {upload_status === 'uploading' && (
        <ActivityIndicator size="small" color="#075E54" style={{ marginRight: 4 }} />
      )}
      {upload_status === 'failed' && onRetry && (
        <TouchableOpacity onPress={onRetry}>
          <Ionicons name="refresh-circle" size={22} color="#D32F2F" style={{ marginRight: 4 }} />
        </TouchableOpacity>
      )}

      {/* Clear button — exact from DM lines 2181-2185 */}
      <TouchableOpacity
        onPress={onClear}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="close-circle" size={20} color="#999" />
      </TouchableOpacity>
    </View>
  );
}

// Styles copied verbatim from customer chat lines 3323-3328
const styles = StyleSheet.create({
  attachPreviewStrip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0FAF8',
    paddingVertical: 8, paddingHorizontal: 14,
    borderTopWidth: 1, borderTopColor: '#E0E0E0',
  },
  attachPreviewName: {
    flex: 1, fontSize: 13, color: '#333', fontWeight: '500', marginHorizontal: 10,
  },
});
