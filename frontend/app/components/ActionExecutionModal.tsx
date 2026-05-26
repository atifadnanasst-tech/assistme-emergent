/**
 * ActionExecutionModal — Universal operational action execution surface
 * Location: /frontend/app/components/ActionExecutionModal.tsx
 *
 * Generic props — not invoice-specific, not reminder-specific.
 * Supports: send_reminder, create_quote, follow_up, and future action types.
 *
 * v1: Simulated in-app send + real WhatsApp per-row.
 * Future: wire onConfirm to real sendMessageToCustomer() service.
 *
 * Per-row WhatsApp: one button per customer, owner hops intentionally.
 * No fake "send all WhatsApp" — honest UX constraint respected.
 */

import React, { useState } from 'react';
import {
  View, Text, Modal, ScrollView, TextInput,
  TouchableOpacity, Pressable, Linking, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ActionEntity {
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  invoice_id: string | null;
  invoice_number: string;
  amount: number;
}

export interface ActionData {
  text: string;
  type: string;
  execution_mode: 'single' | 'bulk' | null;
  entities: ActionEntity[];
  prefill: { message: string; language: string } | null;
}

interface Props {
  visible: boolean;
  action: ActionData | null;
  onClose: () => void;
  onSimulatedConfirm: (checkedEntities: ActionEntity[], message: string) => void;
}

export default function ActionExecutionModal({ visible, action, onClose, onSimulatedConfirm }: Props) {
  const insets = useSafeAreaInsets();
  const [editedMessage, setEditedMessage] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  React.useEffect(() => {
    if (visible && action) {
      setEditedMessage(action.prefill?.message || '');
      const allIds = new Set(action.entities.map(e => e.customer_id || e.customer_name));
      setCheckedIds(allIds);
      setSending(false);
    }
  }, [visible, action]);

  if (!action) return null;

  const isBulk = action.execution_mode === 'bulk';
  const checkedEntities = action.entities.filter(e =>
    checkedIds.has(e.customer_id || e.customer_name)
  );

  const handleWhatsApp = (entity: ActionEntity) => {
    const rawPhone = entity.customer_phone || '';
    const normalized = rawPhone.replace(/\D/g, '');
    const phone = normalized.startsWith('91') ? normalized : `91${normalized}`;
    // Clean separation: entities = business data only, communication content from prefill or generated
    // Single: use edited message or prefill.message (owner can customize before sending)
    // Bulk: generate contextual message from entity fields at render time
    const generatedMsg = entity.invoice_number
      ? `${entity.customer_name}, reminder: outstanding balance includes invoice(s) ${entity.invoice_number} totalling ₹${entity.amount?.toLocaleString('en-IN')}. Kindly arrange payment at your earliest.`
      : `${entity.customer_name}, this is a reminder regarding your outstanding balance of ₹${entity.amount?.toLocaleString('en-IN')}. Kindly arrange payment at your earliest convenience.`;
    const msgText = isBulk
      ? generatedMsg
      : (editedMessage || action.prefill?.message || generatedMsg);
    const message = encodeURIComponent(msgText);
    if (!normalized) {
      Linking.openURL(`https://wa.me/?text=${message}`);
    } else {
      Linking.openURL(`https://wa.me/${phone}?text=${message}`);
    }
  };

  const handleSimulatedSend = () => {
    if (checkedEntities.length === 0) return;
    setSending(true);
    setTimeout(() => {
      onSimulatedConfirm(checkedEntities, editedMessage || action.prefill?.message || '');
      setSending(false);
    }, 600);
  };

  const toggleEntity = (key: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const title = isBulk
    ? `Send Reminders to ${action.entities.length} Customer${action.entities.length > 1 ? 's' : ''}`
    : `Send Reminder to ${action.entities[0]?.customer_name}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.dismiss} onPress={onClose} />
        <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          <View style={styles.handle} />
          <Text style={styles.heading}>{title}</Text>

          <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
            {action.entities.map((entity, i) => {
              const key = entity.customer_id || entity.customer_name;
              const checked = checkedIds.has(key);
              const entityMsg = isBulk
                ? (action.prefill?.message || '').replace(/Dear [^,]+/, `Dear ${entity.customer_name}`)
                : editedMessage || action.prefill?.message || '';
              return (
                <View key={i} style={styles.entityRow}>
                  {isBulk && (
                    <TouchableOpacity onPress={() => toggleEntity(key)} style={{ paddingTop: 2 }}>
                      <Ionicons
                        name={checked ? 'checkbox' : 'square-outline'}
                        size={22}
                        color={checked ? '#075E54' : '#CCC'}
                      />
                    </TouchableOpacity>
                  )}
                  <View style={{ flex: 1, marginLeft: isBulk ? 10 : 0 }}>
                    <Text style={styles.entityName}>{entity.customer_name}</Text>
                    <Text style={styles.entityDetail}>
                      {entity.invoice_number} · ₹{entity.amount?.toLocaleString('en-IN')}
                    </Text>
                    <Text style={styles.entityMessage} numberOfLines={2}>{entityMsg}</Text>
                  </View>
                  <TouchableOpacity style={styles.waBtn} onPress={() => handleWhatsApp(entity)}>
                    <Ionicons name="logo-whatsapp" size={20} color="#FFF" />
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>

          {!isBulk && (
            <>
              <Text style={styles.messageLabel}>Message:</Text>
              <TextInput
                style={styles.messageInput}
                value={editedMessage}
                onChangeText={setEditedMessage}
                multiline
                numberOfLines={3}
                placeholder="Type reminder message..."
                placeholderTextColor="#999"
              />
            </>
          )}

          <TouchableOpacity
            style={[styles.confirmBtn, (sending || checkedEntities.length === 0) && { opacity: 0.5 }]}
            onPress={handleSimulatedSend}
            disabled={sending || checkedEntities.length === 0}
          >
            <Text style={styles.confirmBtnText}>
              {sending ? 'Sending...' : isBulk
                ? `\u2713 Send to ${checkedEntities.length} Selected (Simulated)`
                : '\u2713 Send in App (Simulated)'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  dismiss: { flex: 1 },
  container: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, maxHeight: '88%' },
  handle: { width: 40, height: 4, backgroundColor: '#DDD', borderRadius: 2, alignSelf: 'center', marginVertical: 14 },
  heading: { fontSize: 17, fontWeight: '700', color: '#1A1A1A', marginBottom: 14 },
  entityRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  entityName: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  entityDetail: { fontSize: 12, color: '#666', marginTop: 2 },
  entityMessage: { fontSize: 12, color: '#888', marginTop: 4, fontStyle: 'italic' },
  waBtn: { backgroundColor: '#25D366', borderRadius: 8, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginLeft: 8, marginTop: 2 },
  waBtnText: { fontSize: 18 },
  messageLabel: { fontSize: 13, color: '#666', marginTop: 14, marginBottom: 6 },
  messageInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 10, fontSize: 14, color: '#1A1A1A', minHeight: 72, textAlignVertical: 'top', marginBottom: 14 },
  confirmBtn: { backgroundColor: '#075E54', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 14 },
  confirmBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  cancelBtn: { alignItems: 'center', paddingVertical: 14 },
  cancelBtnText: { color: '#999', fontSize: 14 },
});
