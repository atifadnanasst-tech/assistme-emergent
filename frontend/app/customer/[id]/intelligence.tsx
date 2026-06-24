/**
 * AssistMe — Customer Intelligence Screen
 * Location: /frontend/app/customer/[id]/intelligence.tsx
 * Created: 24 Jun 2026 — Session 4A completion
 *
 * PURPOSE:
 *   Permanent home for all AI-derived intelligence about a customer.
 *   Today: shows WhatsApp import report from AsyncStorage (delete-on-read).
 *   Future sessions wire in: entity_memory facts, interaction_profile,
 *   live distillation signals, owner-declared memory.
 *
 * SCREEN CONTRACT (IntelligenceData):
 *   importedReport  — populated today (AsyncStorage, whatsapp import)
 *   memoryFacts     — empty today, populated when distillation writes entity_memory
 *   interactionProfile — empty today, populated when writeInteractionProfile wires in
 *
 * DELETE-ON-READ:
 *   AsyncStorage key `import_report_${id}` is read once then immediately deleted.
 *   This prevents stale import reports from persisting across app sessions.
 *   Session 4B (confirm route) will eventually replace this with DB persistence.
 *
 * BOTTOM SPACING:
 *   Uses SafeAreaView edges={['bottom']} wrapping the bottom bar.
 *   Prevents Android gesture navigation from hiding bottom buttons.
 *   Pattern copied from report.tsx (verified working).
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Fact {
  key: string;
  value: string;
  class: string;
  confidence: number;
  evidenceSummary?: string;
  source?: string;
}

interface ImportedReport {
  summary: {
    customerName: string;
    messagesAnalyzed: number;
    ownerMessages: number;
    customerMessages: number;
    mediaShared: number;
    dateFrom: string | null;
    dateTo: string | null;
    relationshipAge: string | null;
  };
  byCategory: {
    relationship: Fact[];
    products: Fact[];
    commercial: Fact[];
    opportunities: Fact[];
    ownerStyle: Fact[];
    temporary: Fact[];
  };
  needsReview: Fact[];
  counts: {
    toStore: number;
    needsReview: number;
    ignored: number;
    total: number;
  };
}

interface IntelligenceData {
  importedReport?: ImportedReport;
  importJobId?: string;
  cachedAt?: number;
  // Future: memoryFacts, interactionProfile — add here when wired
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

const CATEGORY_LABELS: Record<string, string> = {
  relationship:  'Relationship',
  products:      'Products & Buying',
  commercial:    'Commercial Behavior',
  opportunities: 'Open Opportunities',
  ownerStyle:    'Your Communication Style',
  temporary:     'Current Signals',
};

const CATEGORY_ICONS: Record<string, string> = {
  relationship:  'people-outline',
  products:      'cube-outline',
  commercial:    'trending-up-outline',
  opportunities: 'bulb-outline',
  ownerStyle:    'person-outline',
  temporary:     'time-outline',
};

function ConfidenceDot({ confidence }: { confidence: number }) {
  const color = confidence >= 0.85 ? '#25D366' : confidence >= 0.70 ? '#FFA500' : '#999';
  return <View style={[s.dot, { backgroundColor: color }]} />;
}

function FactCard({ fact }: { fact: Fact }) {
  return (
    <View style={s.factCard}>
      <View style={s.factHeader}>
        <ConfidenceDot confidence={fact.confidence} />
        <Text style={s.factKey}>{fact.key.replace(/_/g, ' ')}</Text>
        <Text style={s.factClass}>{CLASS_LABELS[fact.class] || fact.class}</Text>
      </View>
      <Text style={s.factValue}>{fact.value}</Text>
      {fact.evidenceSummary ? (
        <Text style={s.factEvidence}>{fact.evidenceSummary}</Text>
      ) : null}
    </View>
  );
}

function CategorySection({ category, facts }: { category: string; facts: Fact[] }) {
  if (!facts || facts.length === 0) return null;
  return (
    <View style={s.categorySection}>
      <View style={s.categoryHeader}>
        <Ionicons name={CATEGORY_ICONS[category] as any || 'ellipse-outline'} size={16} color="#075E54" />
        <Text style={s.categoryTitle}>{CATEGORY_LABELS[category] || category}</Text>
        <Text style={s.categoryCount}>{facts.length}</Text>
      </View>
      {facts.map((fact, i) => <FactCard key={i} fact={fact} />)}
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function CustomerIntelligenceScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<IntelligenceData>({});

  useEffect(() => {
    loadIntelligence();
  }, [id]);

  const loadIntelligence = async () => {
    setLoading(true);
    try {
      // Read import report from AsyncStorage (delete-on-read)
      const key = `import_report_${id}`;
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        await AsyncStorage.removeItem(key); // delete-on-read doctrine
        const parsed = JSON.parse(raw);
        setData({
          importedReport: parsed.report,
          importJobId: parsed.importJobId,
          cachedAt: parsed.cachedAt,
        });
      }
      // Future: fetch entity_memory facts from backend here
      // Future: fetch interaction_profile from backend here
    } catch (err) {
      console.error('[CustomerIntelligence] load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const hasImport = !!data.importedReport;
  const hasAnything = hasImport;

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

  const report = data.importedReport;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Customer Intelligence</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>

        {/* Summary card — from import */}
        {report?.summary && (
          <View style={s.summaryCard}>
            <Text style={s.summaryName}>{report.summary.customerName}</Text>
            {report.summary.relationshipAge && (
              <Text style={s.summaryAge}>Relationship: {report.summary.relationshipAge}</Text>
            )}
            <View style={s.summaryStats}>
              <View style={s.statItem}>
                <Text style={s.statNumber}>{report.summary.messagesAnalyzed}</Text>
                <Text style={s.statLabel}>Messages</Text>
              </View>
              <View style={s.statItem}>
                <Text style={s.statNumber}>{report.counts?.toStore || 0}</Text>
                <Text style={s.statLabel}>Facts learned</Text>
              </View>
              {report.summary.mediaShared > 0 && (
                <View style={s.statItem}>
                  <Text style={s.statNumber}>{report.summary.mediaShared}</Text>
                  <Text style={s.statLabel}>Media shared</Text>
                </View>
              )}
            </View>
            {report.summary.dateFrom && (
              <Text style={s.summaryDate}>
                {report.summary.dateFrom} — {report.summary.dateTo || 'present'}
              </Text>
            )}
            <View style={s.sourceTag}>
              <Ionicons name="logo-whatsapp" size={12} color="#25D366" />
              <Text style={s.sourceTagText}>WhatsApp import</Text>
            </View>
          </View>
        )}

        {/* Intelligence sections — from import */}
        {report?.byCategory && Object.entries(report.byCategory).map(([cat, facts]) => (
          <CategorySection key={cat} category={cat} facts={facts as Fact[]} />
        ))}

        {/* Needs review section */}
        {report?.needsReview && report.needsReview.length > 0 && (
          <View style={s.categorySection}>
            <View style={s.categoryHeader}>
              <Ionicons name="alert-circle-outline" size={16} color="#FFA500" />
              <Text style={s.categoryTitle}>Needs Review</Text>
              <Text style={s.categoryCount}>{report.needsReview.length}</Text>
            </View>
            <Text style={s.reviewNote}>These facts had lower confidence — review before saving.</Text>
            {report.needsReview.map((fact, i) => <FactCard key={i} fact={fact} />)}
          </View>
        )}

{/* Empty state */}
        {!hasAnything && (
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

      {/* Bottom bar — SafeAreaView edges bottom for Android nav bar */}
      <SafeAreaView style={s.bottomBarSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity style={s.closeBtn} onPress={() => router.back()}>
            <Text style={s.closeBtnText}>Close</Text>
          </TouchableOpacity>
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

  categorySection: { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 12, elevation: 1 },
  categoryHeader:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  categoryTitle:   { fontSize: 14, fontWeight: '700', color: '#1A1A1A', flex: 1 },
  categoryCount:   { fontSize: 12, color: '#999', backgroundColor: '#F0F0F0', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },

  factCard:    { borderLeftWidth: 3, borderLeftColor: '#E0E0E0', paddingLeft: 10, marginBottom: 10 },
  factHeader:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  dot:         { width: 8, height: 8, borderRadius: 4 },
  factKey:     { fontSize: 12, fontWeight: '600', color: '#555', flex: 1, textTransform: 'capitalize' },
  factClass:   { fontSize: 10, color: '#999', backgroundColor: '#F5F5F5', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  factValue:   { fontSize: 14, color: '#1A1A1A', lineHeight: 20 },
  factEvidence:{ fontSize: 11, color: '#999', marginTop: 3, fontStyle: 'italic' },

  reviewNote:  { fontSize: 12, color: '#FFA500', marginBottom: 10, fontStyle: 'italic' },


  emptyState:  { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle:  { fontSize: 18, fontWeight: '700', color: '#999', marginTop: 16, marginBottom: 8 },
  emptyBody:   { fontSize: 14, color: '#BBB', textAlign: 'center', lineHeight: 20 },

  bottomBarSafe: { backgroundColor: '#FFF' },
  bottomBar:     { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  closeBtn:      { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, backgroundColor: '#F0F0F0' },
  closeBtnText:  { fontSize: 15, fontWeight: '600', color: '#555' },
});
