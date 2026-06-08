/**
 * AssistMe — AttachmentSheet.tsx
 * Reusable 6-icon attachment sheet modal.
 *
 * Source: Extracted verbatim from chat/[customer_id].tsx lines 2873-2920 (proven in production).
 * Styles: attachSheetOverlay, attachSheetContainer, attachSheetHandle, attachGrid,
 *         attachGridItem, attachGridIcon, attachGridLabel — copied exactly from lines 3312-3321.
 *
 * Consumers (Phase 1): components/chat/ChatComposerInput.tsx → app/ai.tsx (Org AI only)
 * Future consumers: app/chat/[customer_id].tsx (post-v1, after Org AI stable)
 * Customer chat untouched in this phase.
 *
 * Props:
 *   Required: visible, onClose, onPickGallery, onOpenCamera
 *   Optional: onPickDocument, onAudioRecord, isRecording (not yet wired in Org AI Phase 1)
 *   Optional: onShareQR, onCatalog (Coming soon placeholders — exact from source)
 *
 * Modifies existing production surface: NO
 */
import React from 'react';
import {
  View, Text, TouchableOpacity, Modal, Alert, StyleSheet, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface AttachmentSheetProps {
  visible: boolean;
  onClose: () => void;
  onPickGallery: () => void;
  onOpenCamera: () => void;
  onPickDocument?: () => void;       // optional — not wired in Org AI Phase 1
  onAudioRecord?: () => void;        // optional — not wired in Org AI Phase 1
  isRecording?: boolean;             // optional — for audio stop/start toggle
  onShareQR?: () => void;            // optional — Coming soon
  onCatalog?: () => void;            // optional — Coming soon
}

export function AttachmentSheet({
  visible,
  onClose,
  onPickGallery,
  onOpenCamera,
  onPickDocument,
  onAudioRecord,
  isRecording = false,
  onShareQR,
  onCatalog,
}: AttachmentSheetProps) {
  // Icon grid — exact from customer chat lines 2885-2898
  const items = [
    { icon: 'images-outline', label: 'Gallery', color: '#1E88E5', handler: onPickGallery },
    { icon: 'camera-outline', label: 'Camera', color: '#E53935', handler: onOpenCamera },
    { icon: 'document-outline', label: 'Document', color: '#FB8C00', handler: onPickDocument || null },
    {
      icon: isRecording ? 'stop-circle-outline' : 'mic-outline',
      label: isRecording ? 'Stop' : 'Audio',
      color: isRecording ? '#E53935' : '#8E24AA',
      handler: onAudioRecord || null,
    },
    { icon: 'qr-code-outline', label: 'Share QR', color: '#00897B', handler: onShareQR || null },
    { icon: 'grid-outline', label: 'Catalog', color: '#F57C00', handler: onCatalog || null },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* Overlay — exact from customer chat line 2880 */}
      <Pressable style={styles.attachSheetOverlay} onPress={onClose}>
        <Pressable onPress={() => {}}>
          <View style={styles.attachSheetContainer}>
            <View style={styles.attachSheetHandle} />
            <View style={styles.attachGrid}>
              {items.map((item) => (
                <TouchableOpacity
                  key={item.label}
                  style={styles.attachGridItem}
                  onPress={() => {
                    if (item.handler) {
                      item.handler();
                    } else {
                      onClose();
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
  );
}

// Styles copied verbatim from customer chat lines 3312-3321
const styles = StyleSheet.create({
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
});
