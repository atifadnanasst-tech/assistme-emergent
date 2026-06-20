import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Linking, Alert, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../../lib/auth';

export interface ActivityCardItem {
  id: string;
  type?: string;
  content?: string;
  alert_date?: string | null;
  task_id?: string | null;
  is_silenced?: boolean;
  title?: string;
  status?: string;
  priority?: string;
  due_date?: string | null;
  snoozed_until?: string | null;
  archived_at?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
}

interface SharedActivityCardProps {
  item: ActivityCardItem;
  source: 'watchlist' | 'mytasks';
  onRefresh: () => void;
  onTapCard?: (item: ActivityCardItem) => void;
  onLongPress?: (item: ActivityCardItem) => void;
  onAssign?: (item: ActivityCardItem) => void;
  onAddNotes?: (item: ActivityCardItem) => void;
}

const getAlertIcon = (type?: string) => {
  switch (type) {
    case 'delivery_due': return '🚚';
    case 'reminder_due': return '💰';
    case 'overdue_invoice': return '⚠️';
    case 'bank_reconciliation': return '🏦';
    default: return '🔔';
  }
};

const getPriorityColor = (p?: string) => {
  switch (p) {
    case 'urgent': return '#D32F2F';
    case 'high': return '#F57C00';
    case 'medium': return '#FBC02D';
    default: return '#4CAF50';
  }
};

const fmtDate = (d?: string | null) => {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const SNOOZE_OPTIONS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
];

export default function SharedActivityCard({ item, source, onRefresh, onTapCard, onLongPress, onAssign, onAddNotes }: SharedActivityCardProps) {
  const router = useRouter();
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
  const [menuVisible, setMenuVisible] = useState(false);
  const [snoozeVisible, setSnoozeVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  const taskId = source === 'mytasks' ? item.id : (item.task_id || null);

  const title = source === 'mytasks' ? item.title : item.content;
  const dueDate = source === 'mytasks' ? item.due_date : item.alert_date;
  const isCompleted = item.status === 'completed';
  const isArchived = !!item.archived_at;
  // Only relevant inside the future Snoozed view -- a snoozed item never
  // appears in the default Watchlist/My Tasks lists (C.4/C.14 filter them
  // out), so this can only ever be true there.
  const isSnoozed = !!item.snoozed_until && new Date(item.snoozed_until).getTime() > Date.now();
  const hasCustomer = !!item.customer_id;
  const hasMenuItems = !!(taskId) || !!onAssign || !!onAddNotes;

  const patchTask = async (body: Record<string, any>) => {
    if (!taskId) return;
    setBusy(true);
    try {
      const token = await authService.getAccessToken();
      await fetch(`${backendUrl}/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onRefresh();
    } catch {
      Alert.alert('Error', 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleComplete = () => patchTask({ status: isCompleted ? 'pending' : 'completed' });

  const handleSnoozePick = (days: number) => {
    setSnoozeVisible(false);
    const until = new Date();
    until.setDate(until.getDate() + days);
    patchTask({ snoozed_until: until.toISOString() });
  };

  const handleDelete = () => {
    Alert.alert('Delete this?', title || 'This item will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => patchTask({ deleted_at: new Date().toISOString() }) },
    ]);
  };

  const handleArchiveToggle = () => {
    setMenuVisible(false);
    patchTask({ archived_at: isArchived ? null : new Date().toISOString() });
  };

  const handleChat = () => item.customer_id && router.push(`/chat/${item.customer_id}` as any);
  const handleWhatsApp = () => {
    if (!item.customer_phone) return Alert.alert('No Phone', 'No phone number available');
    const clean = item.customer_phone.replace(/[^0-9]/g, '');
    Linking.openURL(`https://wa.me/${clean}`).catch(() => {});
  };
  const handleCall = () => {
    if (!item.customer_phone) return Alert.alert('No Phone', 'No phone number available');
    Linking.openURL(`tel:${item.customer_phone}`).catch(() => {});
  };

  const CardWrapper = onTapCard ? TouchableOpacity : View;
  const cardWrapperProps: any = onTapCard ? { onPress: () => onTapCard(item), activeOpacity: 0.7 } : {};

  return (
    <CardWrapper
      style={[s.card, item.is_silenced && { opacity: 0.5 }]}
      {...cardWrapperProps}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
    >
      {source === 'watchlist' ? (
        <Text style={s.alertIcon}>{getAlertIcon(item.type)}</Text>
      ) : (
        <View style={[s.priorityDot, { backgroundColor: getPriorityColor(item.priority) }]} />
      )}

      <View style={s.cardContent}>
        <Text style={[s.cardText, isCompleted && s.strikethrough]}>{title}</Text>
        <View style={s.cardMeta}>
          {item.customer_name && <Text style={s.metaText}>{item.customer_name}</Text>}
          {dueDate && <Text style={s.metaDate}>{source === 'mytasks' ? `Due ${fmtDate(dueDate)}` : fmtDate(dueDate)}</Text>}
          {source === 'mytasks' && (
            <View style={[s.statusBadge, { backgroundColor: isCompleted ? '#E8F5E9' : item.status === 'cancelled' ? '#FFEBEE' : '#FFF8E1' }]}>
              <Text style={[s.statusText, { color: isCompleted ? '#4CAF50' : item.status === 'cancelled' ? '#D32F2F' : '#F9A825' }]}>{item.status}</Text>
            </View>
          )}
          {isArchived && (
            <View style={s.archivedBadge}><Text style={s.archivedBadgeText}>Archived</Text></View>
          )}
          {isSnoozed && (
            <View style={s.snoozedBadge}><Text style={s.snoozedBadgeText}>Snoozed until {fmtDate(item.snoozed_until)}</Text></View>
          )}
        </View>

        {hasCustomer && (
          <View style={s.actionRow}>
            <TouchableOpacity style={s.iconBtn} onPress={handleChat}>
              <Ionicons name="chatbubble-outline" size={18} color="#075E54" />
            </TouchableOpacity>
            <TouchableOpacity style={s.iconBtn} onPress={handleWhatsApp}>
              <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
            </TouchableOpacity>
            <TouchableOpacity style={s.iconBtn} onPress={handleCall}>
              <Ionicons name="call-outline" size={18} color="#075E54" />
            </TouchableOpacity>
          </View>
        )}

        {taskId && (
          <View style={s.actionRow}>
            {busy ? (
              <ActivityIndicator size="small" color="#075E54" style={{ marginRight: 8 }} />
            ) : (
              <>
                <TouchableOpacity style={s.iconBtn} onPress={handleToggleComplete}>
                  <Ionicons name={isCompleted ? 'refresh-outline' : 'checkmark-circle-outline'} size={18} color="#4CAF50" />
                </TouchableOpacity>
                <TouchableOpacity style={s.iconBtn} onPress={() => isSnoozed ? patchTask({ snoozed_until: null }) : setSnoozeVisible(true)}>
                  <Ionicons name="time-outline" size={18} color="#075E54" />
                </TouchableOpacity>
                <TouchableOpacity style={s.iconBtn} onPress={handleDelete}>
                  <Ionicons name="trash-outline" size={18} color="#D32F2F" />
                </TouchableOpacity>
              </>
            )}
            {hasMenuItems && (
              <TouchableOpacity style={s.iconBtn} onPress={() => setMenuVisible(true)}>
                <Ionicons name="ellipsis-vertical" size={18} color="#666" />
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setMenuVisible(false)}>
          <View style={s.menuBox}>
            <Text style={s.menuTitle} numberOfLines={1}>{title}</Text>
            {taskId && (
              <TouchableOpacity style={s.menuItem} onPress={handleArchiveToggle}>
                <Ionicons name="archive-outline" size={20} color="#075E54" />
                <Text style={s.menuItemText}>{isArchived ? 'Unarchive' : 'Archive'}</Text>
              </TouchableOpacity>
            )}
            {onAssign && (
              <TouchableOpacity style={s.menuItem} onPress={() => { setMenuVisible(false); onAssign(item); }}>
                <Ionicons name="person-add-outline" size={20} color="#075E54" />
                <Text style={s.menuItemText}>Assign</Text>
              </TouchableOpacity>
            )}
            {onAddNotes && (
              <TouchableOpacity style={s.menuItem} onPress={() => { setMenuVisible(false); onAddNotes(item); }}>
                <Ionicons name="document-text-outline" size={20} color="#075E54" />
                <Text style={s.menuItemText}>Add Notes</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={snoozeVisible} transparent animationType="fade" onRequestClose={() => setSnoozeVisible(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setSnoozeVisible(false)}>
          <View style={s.menuBox}>
            <Text style={s.menuTitle}>Snooze until</Text>
            {SNOOZE_OPTIONS.map((opt) => (
              <TouchableOpacity key={opt.days} style={s.menuItem} onPress={() => handleSnoozePick(opt.days)}>
                <Ionicons name="time-outline" size={20} color="#075E54" />
                <Text style={s.menuItemText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </CardWrapper>
  );
}

const s = StyleSheet.create({
  card: { flexDirection: 'row', backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 8, elevation: 1, gap: 10, alignItems: 'flex-start' },
  alertIcon: { fontSize: 20, marginTop: 2 },
  priorityDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  cardContent: { flex: 1 },
  cardText: { fontSize: 14, color: '#1A1A1A', lineHeight: 20 },
  strikethrough: { textDecorationLine: 'line-through', color: '#999' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  metaText: { fontSize: 12, color: '#075E54', fontWeight: '600' },
  metaDate: { fontSize: 12, color: '#999' },
  statusBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  statusText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  archivedBadge: { backgroundColor: '#F0F0F0', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  archivedBadgeText: { fontSize: 11, fontWeight: '600', color: '#667781' },
  snoozedBadge: { backgroundColor: '#FFF3E0', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  snoozedBadgeText: { fontSize: 11, fontWeight: '600', color: '#F57C00' },
  actionRow: { flexDirection: 'row', gap: 4, alignItems: 'center', marginTop: 8 },
  iconBtn: { padding: 6, borderRadius: 6, backgroundColor: '#F5F5F5' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  menuBox: { backgroundColor: '#FFF', borderRadius: 16, paddingVertical: 8, minWidth: 220, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 },
  menuTitle: { fontSize: 14, fontWeight: '600', color: '#666', paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 },
  menuItemText: { fontSize: 15, color: '#333' },
});
