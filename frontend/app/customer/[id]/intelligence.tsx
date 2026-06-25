/**
 * AssistMe — Customer Intelligence Screen
 * Location: /frontend/app/customer/[id]/intelligence.tsx
 * Session 4A: read-only report from AsyncStorage (24 Jun 2026)
 * Session 4B: inline edit, per-card delete, Save to Memory (24 Jun 2026)
 *
 * DATA FLOW:
 *   AsyncStorage `import_report_${id}` → read on mount → delete after read
 *   Editable UI built from rawCandidates directly (not report.byCategory).
 *   report.summary used for stats card only.
 *   Screen state (ScreenFact[] per source array) is the source of truth.
 *   On confirm: screen facts mapped back to candidates by _id (stable, not key).
 *   POST candidates to /api/memory/import-whatsapp/confirm.
 *
 * KEY SAFETY:
 *   GPT can produce duplicate keys across chunks or arrays.
 *   All edit/delete operations use _id (local counter) not business key.
 *   Reconstruction maps by _id within each source array.
 *
 * FUTURE SECTIONS (wired when available):
 *   memoryFacts       — entity_memory reads (Session 5+)
 *   interactionProfile reads — customers.custom_fields (Session 5+)
 *
 * BOTTOM SPACING:
 *   SafeAreaView edges={['bottom']} wrapping bottom bar.
 *   Prevents Android nav bar from hiding buttons. Pattern from report.tsx.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authService } from '../../../lib/auth';

// ── Types ─────────────────────────────────────────────────────────────────────

type FactSource = 'cf_store' | 'cf_review' | 'op_store' | 'op_review';

interface RawFact {
  key: string;
  value: string;
  class: string;
  confidence: number;
  evidenceSummary?: string;
  evidenceCount?: number;
  source?: string;
  importJobId?: string;
}

interface ScreenFact extends RawFact {
  _id: string;          // stable local id — never use key for edit/delete
  _source: FactSource;  // which rawCandidates array this came from
  _edited: boolean;     // true if owner changed value
  _deleted: boolean;    // soft-delete flag
}

interface ReportSummary {
  customerName: string;
  messagesAnalyzed: number;
  mediaShared: number;
  dateFrom: string | null;
  dateTo: string | null;
  relationshipAge: string | null;
}

interface RawCandidates {
  customerFacts?: { toStore: RawFact[]; needsReview: RawFact[] };
  ownerPersonaSignals?: { toStore: RawFact[]; needsReview: RawFact[] };
  interactionProfile?: Record<string, any>;
  counts?: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLASS_LABELS: Record<string, string> = {
  historical_fact:    'Historical',
  relationship_fact:  'Relationship',
  preference:         'Preference',
  behavioral_pattern: 'Behavior',
  opportunity:        'Opportunity',
  temporary_signal:   'Current',
};

const SOURCE_LABELS: Record<FactSource, string> = {
  cf_store:  'Customer — Confident',
  cf_review: 'Customer — Review',
  op_store:  'Your Style — Confident',
  op_review: 'Your Style — Review',
};

const SOURCE_ICONS: Record<FactSource, string> = {
  cf_store:  'person-outline',
  cf_review: 'alert-circle-outline',
  op_store:  'person-circle-outline',
  op_review: 'alert-circle-outline',
};

let _counter = 0;
function makeScreenFacts(facts: RawFact[], source: FactSource): ScreenFact[] {
  return (facts || []).map(f => ({
    ...f,
    _id:      String(++_counter),
    _source:  source,
    _edited:  false,
    _deleted: false,
  }));
}

// ── Editable Fact Card ────────────────────────────────────────────────────────

interface FactCardProps {
  fact: ScreenFact;
  onDelete: (id: string) => void;
  onEdit:   (id: string, newValue: string) => void;
}

function FactCard({ fact, onDelete, onEdit }: FactCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(fact.value);
  const dotColor = fact.confidence >= 0.85 ? '#25D366' : fact.confidence >= 0.70 ? '#FFA500' : '#999';

  const commitEdit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== fact.value) onEdit(fact._id, trimmed);
    else setDraft(fact.value);
  };

  return (
    <View style={[s.factCard, fact._edited && s.factCardEdited]}>
      <View style={s.factRow}>
        <View style={[s.dot, { backgroundColor: dotColor }]} />
        <Text style={s.factKey} numberOfLines={1}>{fact.key.replace(/_/g, ' ')}</Text>
        <Text style={s.factClass}>{CLASS_LABELS[fact.class] || fact.class}</Text>
        <TouchableOpacity
          onPress={() => { setEditing(true); setDraft(fact.value); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
        >
          <Ionicons name="pencil-outline" size={15} color={fact._edited ? '#075E54' : '#AAAAAA'} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onDelete(fact._id)}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
        >
          <Ionicons name="trash-outline" size={15} color="#E53935" />
        </TouchableOpacity>
      </View>

      {editing ? (
        <TextInput
          style={s.factInput}
          value={draft}
          onChangeText={setDraft}
          onBlur={commitEdit}
          onSubmitEditing={commitEdit}
          autoFocus
          multiline
          returnKeyType="done"
          blurOnSubmit
        />
      ) : (
        <Text style={s.factValue}>{fact.value}</Text>
      )}

      {fact._edited && <Text style={s.editedTag}>✎ Edited</Text>}
      {!editing && fact.evidenceSummary
        ? <Text style={s.factEvidence}>{fact.evidenceSummary}</Text>
        : null}
    </View>
  );
}

// ── Source Section ────────────────────────────────────────────────────────────

interface SourceSectionProps {
  source: FactSource;
  facts:  ScreenFact[];
  onDelete: (id: string) => void;
  onEdit:   (id: string, value: string) => void;
}

function SourceSection({ source, facts, onDelete, onEdit }: SourceSectionProps) {
  const visible = facts.filter(f => !f._deleted);
  if (visible.length === 0) return null;
  return (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Ionicons name={SOURCE_ICONS[source] as any} size={15} color="#075E54" />
        <Text style={s.sectionTitle}>{SOURCE_LABELS[source]}</Text>
        <Text style={s.sectionCount}>{visible.length}</Text>
      </View>
      {visible.map(f => (
        <FactCard key={f._id} fact={f} onDelete={onDelete} onEdit={onEdit} />
      ))}
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function CustomerIntelligenceScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [summary, setSummary]       = useState<ReportSummary | null>(null);
  const [rawCandidates, setRawCandidates] = useState<RawCandidates | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [facts, setFacts]           = useState<ScreenFact[]>([]);
  const [totalOriginal, setTotalOriginal] = useState(0);
  const [dbFacts, setDbFacts]           = useState<RawFact[]>([]);
  const [dbProfile, setDbProfile]       = useState<Record<string, any> | null>(null);

  useEffect(() => { loadIntelligence(); }, [id]);

  const loadIntelligence = async () => {
    setLoading(true);
    try {
      const key = `import_report_${id}`;
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        await AsyncStorage.removeItem(key); // delete-on-read doctrine
        const parsed = JSON.parse(raw);

        // Stats from report summary only
        if (parsed.report?.summary) setSummary(parsed.report.summary);

        // Editable facts built from rawCandidates directly
        const rc: RawCandidates = parsed.rawCandidates || {};
        setRawCandidates(rc);
        setImportJobId(parsed.importJobId || null);

        const allFacts: ScreenFact[] = [
          ...makeScreenFacts(rc.customerFacts?.toStore     || [], 'cf_store'),
          ...makeScreenFacts(rc.customerFacts?.needsReview || [], 'cf_review'),
          ...makeScreenFacts(rc.ownerPersonaSignals?.toStore     || [], 'op_store'),
          ...makeScreenFacts(rc.ownerPersonaSignals?.needsReview || [], 'op_review'),
        ];
        setFacts(allFacts);
        setTotalOriginal(allFacts.length);
      }
      // Fetch persisted memory from backend (always, regardless of import)
      try {
        const token = await authService.getAccessToken();
        if (token) {
          const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
          const res = await fetch(`${backendUrl}/api/customer/${id}/intelligence`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success) {
              setDbFacts(data.intelligence?.memoryFacts || []);
              setDbProfile(data.intelligence?.interactionProfile || null);
            }
          }
        }
      } catch (dbErr) {
        console.error('[CustomerIntelligence] db fetch error:', dbErr);
      }
    } catch (err) {
      console.error('[CustomerIntelligence] load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = useCallback((factId: string) => {
    setFacts(prev => prev.map(f => f._id === factId ? { ...f, _deleted: true } : f));
  }, []);

  const handleEdit = useCallback((factId: string, newValue: string) => {
    setFacts(prev => prev.map(f =>
      f._id === factId ? { ...f, value: newValue, _edited: true } : f
    ));
  }, []);

  const handleSave = async () => {
    if (!rawCandidates) return;
    setSaving(true);
    try {
      const token = await authService.getAccessToken();
      if (!token) { Alert.alert('Session expired', 'Please log in again.'); return; }

      // Build confirmed candidates from screen state by _source + _id
      // Screen state is source of truth — no key-based lookup
      const surviving = facts.filter(f => !f._deleted);

      const pick = (src: FactSource): RawFact[] =>
        surviving
          .filter(f => f._source === src)
          .map(({ _id, _source, _edited, _deleted, ...rest }) => rest);

      const confirmedCandidates: RawCandidates = {
        customerFacts: {
          toStore:     pick('cf_store'),
          needsReview: pick('cf_review'),
        },
        ownerPersonaSignals: {
          toStore:     pick('op_store'),
          needsReview: pick('op_review'),
        },
        interactionProfile: rawCandidates.interactionProfile || {},
      };

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/memory/import-whatsapp/confirm`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id:   id,
          import_job_id: importJobId,
          candidates:    confirmedCandidates,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        Alert.alert('Save Failed', data.message || 'Please try again.');
        return;
      }

      const msg = [
        `${data.memory_written} ${data.memory_written === 1 ? 'memory' : 'memories'} saved.`,
        data.memory_skipped > 0 ? `${data.memory_skipped} skipped (already known).` : null,
        data.profile_error ? 'Interaction style couldn\'t be updated this time.' : null,
      ].filter(Boolean).join('\n');

      Alert.alert('Saved to Memory', msg, [{ text: 'OK', onPress: () => router.back() }]);

    } catch (err: any) {
      console.error('[CustomerIntelligence] save error:', err);
      Alert.alert('Error', 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscardAll = () => {
    Alert.alert(
      'Discard Import',
      'Nothing will be saved to memory. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => router.back() },
      ]
    );
  };

  const hasFacts    = facts.some(f => !f._deleted);
  const totalVisible = facts.filter(f => !f._deleted).length;
  const hasReport   = !!summary;
  const hasDbFacts  = dbFacts.length > 0 || !!dbProfile;

  if (loading) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Customer Intelligence</Text>
        </View>
        <View style={s.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Customer Intelligence</Text>
        {hasFacts && (
          <View style={s.headerBadge}>
            <Text style={s.headerBadgeText}>{totalVisible}/{totalOriginal}</Text>
          </View>
        )}
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

          {/* Summary stats card */}
          {summary && (
            <View style={s.summaryCard}>
              <Text style={s.summaryName}>{summary.customerName}</Text>
              {summary.relationshipAge
                ? <Text style={s.summaryAge}>Relationship: {summary.relationshipAge}</Text>
                : null}
              <View style={s.summaryStats}>
                <View style={s.statItem}>
                  <Text style={s.statNumber}>{summary.messagesAnalyzed}</Text>
                  <Text style={s.statLabel}>Messages</Text>
                </View>
                <View style={s.statItem}>
                  <Text style={s.statNumber}>{totalOriginal}</Text>
                  <Text style={s.statLabel}>Facts found</Text>
                </View>
                {(summary.mediaShared || 0) > 0 && (
                  <View style={s.statItem}>
                    <Text style={s.statNumber}>{summary.mediaShared}</Text>
                    <Text style={s.statLabel}>Media</Text>
                  </View>
                )}
              </View>
              {summary.dateFrom && (
                <Text style={s.summaryDate}>{summary.dateFrom} — {summary.dateTo || 'present'}</Text>
              )}
              <View style={s.sourceTag}>
                <Ionicons name="logo-whatsapp" size={12} color="#25D366" />
                <Text style={s.sourceTagText}>WhatsApp import · edit ✏️ or remove 🗑️ before saving</Text>
              </View>
            </View>
          )}

          {/* Editable fact sections — built from rawCandidates */}
          {(['cf_store', 'cf_review', 'op_store', 'op_review'] as FactSource[]).map(src => (
            <SourceSection
              key={src}
              source={src}
              facts={facts.filter(f => f._source === src)}
              onDelete={handleDelete}
              onEdit={handleEdit}
            />
          ))}

          {/* Persisted memory facts from DB — read only */}
          {hasDbFacts && (
            <View style={s.section}>
              <View style={s.sectionHeader}>
                <Ionicons name="sparkles-outline" size={15} color="#075E54" />
                <Text style={s.sectionTitle}>Saved Memory</Text>
                <Text style={s.sectionCount}>{dbFacts.length}</Text>
              </View>
              {dbFacts.map((fact, i) => (
                <View key={i} style={s.factCard}>
                  <View style={s.factRow}>
                    <View style={[s.dot, { backgroundColor: fact.confidence >= 0.85 ? '#25D366' : fact.confidence >= 0.70 ? '#FFA500' : '#999' }]} />
                    <Text style={s.factKey} numberOfLines={1}>{fact.key.replace(/_/g, ' ')}</Text>
                    <Text style={s.factClass}>{CLASS_LABELS[fact.class] || fact.class}</Text>
                  </View>
                  <Text style={s.factValue}>{fact.value}</Text>
                </View>
              ))}
              {dbProfile && Object.keys(dbProfile).filter(k => dbProfile[k]).length > 0 && (
                <View style={{ marginTop: 10 }}>
                  <Text style={[s.factKey, { marginBottom: 6, textTransform: 'none' }]}>Interaction Style</Text>
                  {Object.entries(dbProfile).filter(([, v]) => v).map(([k, v]) => (
                    <View key={k} style={[s.factCard, { marginBottom: 6 }]}>
                      <Text style={s.factKey}>{k.replace(/_/g, ' ')}</Text>
                      <Text style={s.factValue}>{String(v)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Empty state */}
          {!hasReport && !hasDbFacts && (
            <View style={s.emptyState}>
              <Ionicons name="sparkles-outline" size={48} color="#CCC" />
              <Text style={s.emptyTitle}>No intelligence yet</Text>
              <Text style={s.emptyBody}>
                AssistMe builds customer intelligence over time through conversations
                and WhatsApp history. Import a chat or keep chatting to get started.
              </Text>
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>

      {/* Bottom bar — SafeAreaView edges bottom for Android nav bar */}
      <SafeAreaView style={s.bottomBarSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          {hasFacts ? (
            <>
              <TouchableOpacity style={s.discardBtn} onPress={handleDiscardAll} disabled={saving}>
                <Text style={s.discardBtnText}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={handleSave} disabled={saving}>
                {saving
                  ? <ActivityIndicator size="small" color="#FFF" />
                  : <Text style={s.saveBtnText}>Save to Memory</Text>}
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={s.closeBtn} onPress={() => router.back()}>
              <Text style={s.closeBtnText}>Close</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe:             { flex: 1, backgroundColor: '#F5F5F5' },
  header:           { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingHorizontal: 12, paddingVertical: 14, gap: 12 },
  backBtn:          { padding: 4 },
  headerTitle:      { fontSize: 18, fontWeight: '700', color: '#FFF', flex: 1 },
  headerBadge:      { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  headerBadgeText:  { fontSize: 12, color: '#FFF', fontWeight: '600' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll:           { flex: 1 },
  scrollContent:    { padding: 16, paddingBottom: 32 },

  summaryCard:   { backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginBottom: 16, elevation: 1 },
  summaryName:   { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 4 },
  summaryAge:    { fontSize: 13, color: '#666', marginBottom: 12 },
  summaryStats:  { flexDirection: 'row', gap: 24, marginBottom: 8 },
  statItem:      { alignItems: 'center' },
  statNumber:    { fontSize: 20, fontWeight: '700', color: '#075E54' },
  statLabel:     { fontSize: 11, color: '#999', marginTop: 2 },
  summaryDate:   { fontSize: 12, color: '#999', marginTop: 4 },
  sourceTag:     { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, backgroundColor: '#F0FAF0', borderRadius: 20, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3 },
  sourceTagText: { fontSize: 11, color: '#25D366', fontWeight: '600' },

  section:       { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 12, elevation: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle:  { fontSize: 14, fontWeight: '700', color: '#1A1A1A', flex: 1 },
  sectionCount:  { fontSize: 12, color: '#999', backgroundColor: '#F0F0F0', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },

  factCard:       { borderLeftWidth: 3, borderLeftColor: '#E8E8E8', paddingLeft: 10, marginBottom: 12 },
  factCardEdited: { borderLeftColor: '#075E54' },
  factRow:        { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  dot:            { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  factKey:        { fontSize: 12, fontWeight: '600', color: '#555', flex: 1, textTransform: 'capitalize' },
  factClass:      { fontSize: 10, color: '#999', backgroundColor: '#F5F5F5', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  factValue:      { fontSize: 14, color: '#1A1A1A', lineHeight: 20 },
  factInput:      { fontSize: 14, color: '#1A1A1A', lineHeight: 20, borderBottomWidth: 1.5, borderBottomColor: '#075E54', paddingVertical: 3, marginBottom: 4 },
  editedTag:      { fontSize: 10, color: '#075E54', marginTop: 2, fontStyle: 'italic' },
  factEvidence:   { fontSize: 11, color: '#AAA', marginTop: 3, fontStyle: 'italic' },

  emptyState:  { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle:  { fontSize: 18, fontWeight: '700', color: '#999', marginTop: 16, marginBottom: 8 },
  emptyBody:   { fontSize: 14, color: '#BBB', textAlign: 'center', lineHeight: 20 },

  bottomBarSafe:  { backgroundColor: '#FFF' },
  bottomBar:      { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 16, gap: 10, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  closeBtn:       { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, backgroundColor: '#F0F0F0' },
  closeBtnText:   { fontSize: 15, fontWeight: '600', color: '#555' },
  discardBtn:     { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, backgroundColor: '#F0F0F0' },
  discardBtnText: { fontSize: 15, fontWeight: '600', color: '#888' },
  saveBtn:        { flex: 2, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, backgroundColor: '#075E54' },
  saveBtnText:    { fontSize: 15, fontWeight: '700', color: '#FFF' },
});
