import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  Platform, ActivityIndicator, Alert, Modal, FlatList, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import { authService } from '../lib/auth';
import { uploadFile } from '../lib/upload';

// Batch C.10 -- the calendar-event-style detail/creation screen. Three
// entry points share this one screen: tap-to-expand on an existing card,
// the C.9 FAB's "create new" flow, and full editing beyond what the
// card's row-2 inline quick-edit covers. Fields mapped deliberately
// against Google Calendar's event screen (timezone, video conferencing,
// multiple calendars, color picker all intentionally NOT carried over --
// not relevant to a business reminder). Snooze/Archive/Delete are
// deliberately NOT duplicated here -- those already live as card-level
// actions; this screen covers editable content only.

interface Customer { id: string; name: string; company?: string | null; phone?: string | null; city?: string | null; }
interface Attachment { id: string; file_name: string; file_size?: number | null; mime_type?: string | null; public_url?: string | null; }

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];
const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const REPEAT_OPTIONS: { value: string | null; label: string }[] = [
  { value: null, label: 'Never' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export default function TaskDetailScreen() {
  const router = useRouter();
  // draft_* params come from Voice Reminder's "Edit" path -- only ever
  // applied when task_id is absent (create mode). Full envelope parsed
  // now even though only title/description/due_date/repeat_pattern are
  // used yet -- avoids a second route-contract migration once the
  // confirmation sheet wants to pass customer_name/confidence/transcript
  // into Edit too.
  const {
    task_id, draft_title, draft_due_date, draft_repeat_pattern, draft_description,
    draft_customer_name, draft_customer_id, draft_confidence, draft_transcript,
  } = useLocalSearchParams<{
    task_id?: string; draft_title?: string; draft_due_date?: string; draft_repeat_pattern?: string; draft_description?: string;
    draft_customer_name?: string; draft_customer_id?: string; draft_confidence?: string; draft_transcript?: string;
  }>();
  const isEditMode = !!task_id;
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  // dueTime: null means no specific time set (due_at stays null).
  // When set, combined with dueDate to produce a full due_at timestamp.
  const [dueTime, setDueTime] = useState<Date | null>(null);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [priority, setPriority] = useState('medium');
  const [status, setStatus] = useState('pending');
  const [repeatPattern, setRepeatPattern] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);

  // Applies draft values via effect, not lazy useState init -- stays
  // correct if Expo Router ever reuses this screen instance with
  // different params, instead of only running once on first mount.
  useEffect(() => {
    if (isEditMode) return;
    if (draft_title) setTitle(String(draft_title));
    if (draft_description) setDescription(String(draft_description));
    if (draft_due_date) setDueDate(new Date(`${draft_due_date}T00:00:00`));
    setRepeatPattern(typeof draft_repeat_pattern === 'string' ? draft_repeat_pattern : null);
  }, [isEditMode, draft_title, draft_description, draft_due_date, draft_repeat_pattern]);

  const [pickerVisible, setPickerVisible] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  useEffect(() => {
    if (isEditMode) { loadTask(); loadAttachments(); }
  }, [task_id]);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { Alert.alert('Error', 'Authentication required'); router.back(); return null; }
    return token;
  };

  const loadTask = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${backendUrl}/api/tasks/${task_id}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const t = data.task;
      setTitle(t.title || '');
      setDescription(t.description || '');
      if (t.due_date) setDueDate(new Date(t.due_date + 'T00:00:00'));
      if (t.due_at) setDueTime(new Date(t.due_at));
      setPriority(t.priority || 'medium');
      setStatus(t.status || 'pending');
      setRepeatPattern(t.repeat_pattern || null);
      if (t.customer) setCustomer(t.customer);
    } catch (err) {
      console.error('Load task error:', err);
      Alert.alert('Error', 'Failed to load reminder');
    } finally {
      setLoading(false);
    }
  };

  // Batch C.18 -- attachments only make sense in edit mode, since a new,
  // unsaved task has no id yet for the attachment to point at.
  const loadAttachments = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${backendUrl}/api/tasks/${task_id}/attachments`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      setAttachments(data.attachments || []);
    } catch {}
  };

  const handleAddAttachment = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      setUploadingAttachment(true);
      const token = await getToken();
      if (!token) return;
      // uploadFile() returns { url, name, size, ... } -- mapped here to
      // public_url/file_name/file_size, which match the attachments
      // table's own column names, not the upload utility's response shape.
      const uploaded = await uploadFile(file.uri, file.name, file.mimeType || 'application/octet-stream');
      if (!uploaded) { Alert.alert('Error', 'Upload failed. Please try again.'); return; }
      const res = await fetch(`${backendUrl}/api/tasks/${task_id}/attachments`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_url: uploaded.url,
          storage_path: uploaded.storage_path,
          file_name: uploaded.name || file.name,
          file_size: uploaded.size || file.size,
          mime_type: uploaded.mime_type || file.mimeType,
        }),
      });
      if (!res.ok) { Alert.alert('Error', 'File uploaded but could not be saved. Please try again.'); return; }
      await loadAttachments();
    } catch (err) {
      console.error('Attach file error:', err);
      Alert.alert('Error', 'Failed to attach file');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    Alert.alert('Remove attachment?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          const token = await getToken();
          if (!token) return;
          await fetch(`${backendUrl}/api/attachments/${attachmentId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleted_at: new Date().toISOString() }),
          });
          await loadAttachments();
        }
      },
    ]);
  };

  const openCustomerPicker = async () => {
    setPickerVisible(true);
    if (allCustomers.length === 0) {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch(`${backendUrl}/api/customers`, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        setAllCustomers(data.customers || []);
      } catch {}
    }
  };

  // Searches both name and company -- an MSME customer is often
  // remembered by either their personal/trade name or their registered
  // business name, and different owners enter data under different
  // conventions for the same kind of relationship.
  const filteredCustomers = allCustomers.filter(c => {
    if (!customerSearch.trim()) return true;
    const q = customerSearch.toLowerCase();
    return c.name?.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q);
  });

  const handleSave = async () => {
    if (!title.trim()) { Alert.alert('Missing Title', 'Please enter a title'); return; }
    setSaving(true);
    try {
      const token = await getToken();
      if (!token) return;
      const body: any = {
        title: title.trim(),
        description: description.trim() || null,
        due_date: dueDate.toISOString().split('T')[0],
        due_at: dueTime ? (() => {
          const combined = new Date(dueDate);
          combined.setHours(dueTime.getHours(), dueTime.getMinutes(), 0, 0);
          return combined.toISOString();
        })() : null,
        priority,
        repeat_pattern: repeatPattern,
        customer_id: customer?.id || null,
      };
      if (isEditMode) body.status = status;
      const res = await fetch(
        isEditMode ? `${backendUrl}/api/tasks/${task_id}` : `${backendUrl}/api/tasks`,
        {
          method: isEditMode ? 'PATCH' : 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) throw new Error('Save failed');
      router.back();
    } catch (err) {
      console.error('Save task error:', err);
      Alert.alert('Error', 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={s.container} edges={['top', 'bottom']}>
        <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <Ionicons name="close" size={26} color="#1A1A1A" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.saveBtnText}>Save</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView style={s.scroll} keyboardShouldPersistTaps="handled">
        <TextInput
          style={s.titleInput}
          placeholder="Add title"
          placeholderTextColor="#999"
          value={title}
          onChangeText={setTitle}
        />

        {/* Customer (optional) */}
        <TouchableOpacity style={s.row} onPress={openCustomerPicker}>
          <Ionicons name="person-outline" size={20} color="#667781" style={s.rowIcon} />
          <View style={{ flex: 1 }}>
            {customer ? (
              <>
                <Text style={s.rowValue}>{customer.name}{customer.company && customer.company !== customer.name ? ` — ${customer.company}` : ''}</Text>
                {!!customer.city && <Text style={s.rowSubvalue}>{customer.city}</Text>}
              </>
            ) : (
              <Text style={s.rowPlaceholder}>No customer linked</Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={18} color="#CCC" />
        </TouchableOpacity>

        {/* Due date */}
        <TouchableOpacity style={s.row} onPress={() => setShowDatePicker(true)}>
          <Ionicons name="calendar-outline" size={20} color="#667781" style={s.rowIcon} />
          <Text style={s.rowValue}>{dueDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</Text>
        </TouchableOpacity>
        {showDatePicker && (
          <DateTimePicker
            value={dueDate}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(event: any, date?: Date) => {
              if (Platform.OS === 'android') setShowDatePicker(false);
              if (date) setDueDate(date);
            }}
          />
        )}

        {/* Optional reminder time -- when set, owner gets a push at this
            exact time via jobTaskReminders cron. When cleared, due_at=null
            and the task behaves as a date-only reminder. */}
        <TouchableOpacity style={s.row} onPress={() => setShowTimePicker(true)}>
          <Ionicons name="alarm-outline" size={20} color="#667781" style={s.rowIcon} />
          <Text style={[s.rowValue, !dueTime && { color: '#CCC' }]}>
            {dueTime
              ? dueTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
              : 'Set reminder time (optional)'}
          </Text>
          {dueTime && (
            <TouchableOpacity onPress={() => setDueTime(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color="#CCC" />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
        {showTimePicker && (
          <DateTimePicker
            value={dueTime || new Date()}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(event: any, date?: Date) => {
              if (Platform.OS === 'android') setShowTimePicker(false);
              if (date) setDueTime(date);
            }}
          />
        )}

        {/* Repeat */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Repeat</Text>
          <View style={s.chipRow}>
            {REPEAT_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.label}
                style={[s.chip, repeatPattern === opt.value && s.chipActive]}
                onPress={() => setRepeatPattern(opt.value)}
              >
                <Text style={[s.chipText, repeatPattern === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Priority */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Priority</Text>
          <View style={s.chipRow}>
            {PRIORITY_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[s.chip, priority === opt.value && s.chipActive]}
                onPress={() => setPriority(opt.value)}
              >
                <Text style={[s.chipText, priority === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Status -- edit mode only, a new task is always Pending by definition */}
        {isEditMode && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>Status</Text>
            <View style={s.chipRow}>
              {STATUS_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[s.chip, status === opt.value && s.chipActive]}
                  onPress={() => setStatus(opt.value)}
                >
                  <Text style={[s.chipText, status === opt.value && s.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Description / Notes */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Notes</Text>
          <TextInput
            style={s.notesInput}
            placeholder="Add description"
            placeholderTextColor="#999"
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
          />
        </View>

        {/* Attachments -- edit mode only (Batch C.18) */}
        {isEditMode && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>Attachments</Text>
            {attachments.map(att => (
              <View key={att.id} style={s.attachmentRow}>
                <Ionicons name="document-attach-outline" size={20} color="#667781" style={s.rowIcon} />
                <TouchableOpacity
                  style={{ flex: 1 }}
                  onPress={() => att.public_url && Linking.openURL(att.public_url).catch(() => {})}
                >
                  <Text style={s.attachmentName} numberOfLines={1}>{att.file_name}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleRemoveAttachment(att.id)} style={{ padding: 4 }}>
                  <Ionicons name="trash-outline" size={18} color="#D32F2F" />
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={s.addAttachmentBtn} onPress={handleAddAttachment} disabled={uploadingAttachment}>
              {uploadingAttachment ? (
                <ActivityIndicator size="small" color="#075E54" />
              ) : (
                <>
                  <Ionicons name="add-circle-outline" size={20} color="#075E54" />
                  <Text style={s.addAttachmentText}>Add Attachment</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Customer picker */}
      <Modal visible={pickerVisible} animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        <SafeAreaView style={s.container} edges={['top', 'bottom']}>
          <View style={s.header}>
            <TouchableOpacity onPress={() => setPickerVisible(false)} style={s.headerBtn}>
              <Ionicons name="arrow-back" size={24} color="#1A1A1A" />
            </TouchableOpacity>
            <Text style={s.pickerTitle}>Link a customer</Text>
          </View>
          <View style={s.searchContainer}>
            <Ionicons name="search" size={20} color="#999" style={{ marginRight: 8 }} />
            <TextInput
              style={s.searchInput}
              placeholder="Search by name or business name..."
              placeholderTextColor="#999"
              value={customerSearch}
              onChangeText={setCustomerSearch}
            />
            {customerSearch.length > 0 && (
              <TouchableOpacity onPress={() => setCustomerSearch('')}>
                <Ionicons name="close-circle" size={20} color="#999" />
              </TouchableOpacity>
            )}
          </View>
          <FlatList
            data={filteredCustomers}
            keyExtractor={item => item.id}
            ListHeaderComponent={customer ? (
              <TouchableOpacity
                style={s.pickerItem}
                onPress={() => { setCustomer(null); setPickerVisible(false); }}
              >
                <Ionicons name="close-circle-outline" size={20} color="#D32F2F" />
                <Text style={[s.pickerItemText, { color: '#D32F2F', marginLeft: 12 }]}>Remove customer link</Text>
              </TouchableOpacity>
            ) : null}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={s.pickerItem}
                onPress={() => { setCustomer(item); setPickerVisible(false); setCustomerSearch(''); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.pickerItemText}>{item.name}{item.company && item.company !== item.name ? ` — ${item.company}` : ''}</Text>
                  {!!item.city && <Text style={s.rowSubvalue}>{item.city}</Text>}
                </View>
                {customer?.id === item.id && <Ionicons name="checkmark" size={22} color="#075E54" />}
              </TouchableOpacity>
            )}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  headerBtn: { padding: 4 },
  saveBtn: { backgroundColor: '#075E54', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
  saveBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  scroll: { flex: 1 },
  titleInput: { fontSize: 22, fontWeight: '600', color: '#1A1A1A', paddingHorizontal: 16, paddingVertical: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#F5F5F5' },
  rowIcon: { marginRight: 16 },
  rowValue: { fontSize: 16, color: '#1A1A1A' },
  rowSubvalue: { fontSize: 12, color: '#999', marginTop: 2 },
  rowPlaceholder: { fontSize: 16, color: '#999' },
  section: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4 },
  sectionLabel: { fontSize: 13, fontWeight: '600', color: '#667781', marginBottom: 10, textTransform: 'uppercase' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: '#F5F5F5', borderWidth: 1, borderColor: '#E5E5E5' },
  chipActive: { backgroundColor: '#075E54', borderColor: '#075E54' },
  chipText: { fontSize: 14, color: '#333' },
  chipTextActive: { color: '#FFF', fontWeight: '600' },
  notesInput: { fontSize: 15, color: '#1A1A1A', minHeight: 100, backgroundColor: '#FAFAFA', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#F0F0F0' },
  pickerTitle: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginLeft: 8 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginVertical: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E5E5E5' },
  searchInput: { flex: 1, fontSize: 16, color: '#1A1A1A', paddingVertical: 4 },
  pickerItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  pickerItemText: { fontSize: 16, color: '#1A1A1A' },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  attachmentName: { flex: 1, fontSize: 14, color: '#1A1A1A' },
  addAttachmentBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 8 },
  addAttachmentText: { fontSize: 15, color: '#075E54', fontWeight: '600' },
});
