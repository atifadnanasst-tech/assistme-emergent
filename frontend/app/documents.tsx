/**
 * AssistMe - Unified Documents Screen
 * Location: /frontend/app/documents.tsx
 * Created: Aug 2026 (Unified Documents surface, subtasks E/F/G)
 *
 * PURPOSE: Single screen reused in two contexts, scope is the only
 * difference:
 * - Customer-scoped: /documents?customer_id=xxx (filter pre-locked, no picker)
 * - Org-wide: /documents (all customers; multi-select filter to follow as
 *   an immediate follow-up, per agreed sequencing -- not in this first pass)
 *
 * Four tabs: Invoice, Challan, Quote, Draft. Tap behavior:
 * - Invoice/Quote row -> opens the PDF directly (Linking.openURL)
 * - Challan row -> "View Challan" if one exists, else an inline "Create
 *   Challan" expand-in-place mini-form (transport/bundles/description),
 *   matching Atif's explicit spec: no navigation away, no separate screen.
 * - Draft row -> navigates into the New Invoice screen with resume_draft_id,
 *   reusing the resume capability already built and tested (subtask H).
 *
 * Backed entirely by GET /api/documents (subtask A, fixed for pdf_url gap)
 * and the existing POST /api/invoices/:invoice_id/pdf challan-generation
 * logic (confirmed reusable as-is, subtask B).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Linking, Alert, TextInput, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../lib/auth';
import BottomSheet from '../components/primitives/BottomSheet';

type TabType = 'invoice' | 'challan' | 'quote' | 'draft' | 'receipt';

interface InvoiceDoc {
  id: string; invoice_number: string; customer_id: string; customer_name: string;
  total_amount: number; issue_date: string; pdf_url: string | null;
  has_challan: boolean; challan_pdf_url: string | null;
}
interface QuoteDoc {
  id: string; quote_number: string; customer_id: string; customer_name: string;
  total_amount: number; issue_date: string; pdf_url: string | null;
}
interface DraftDoc {
  id: string; customer_id: string; customer_name: string;
  total_amount: number; created_at: string;
}
// Payment Received tab (Aug 2026). Unified payment + advance shape --
// type distinguishes them for the visual treatment Atif asked for
// ("all receipts can be seen in one place but card structure will
// ensure it is seen a little differently").
interface ReceiptDoc {
  type: 'payment' | 'advance'; id: string; customer_id: string; customer_name: string;
  amount: number; date: string; payment_mode: string | null;
  invoice_number?: string | null; purpose?: string | null; status?: string;
}

const fmt = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export default function DocumentsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ customer_id?: string }>();
  const isCustomerScoped = !!params.customer_id;

  const [activeTab, setActiveTab] = useState<TabType>('invoice');
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<InvoiceDoc[]>([]);
  const [quotes, setQuotes] = useState<QuoteDoc[]>([]);
  const [drafts, setDrafts] = useState<DraftDoc[]>([]);
  const [receipts, setReceipts] = useState<ReceiptDoc[]>([]);

  // Inline "Create Challan" mini-form state (Atif's spec: expand in place,
  // no navigation, no separate screen).
  const [challanFormFor, setChallanFormFor] = useState<string | null>(null);
  const [transportName, setTransportName] = useState('');
  const [bundleCount, setBundleCount] = useState('');
  const [goodsDescription, setGoodsDescription] = useState('');
  const [creatingChallan, setCreatingChallan] = useState(false);

  // Org-wide multi-select customer filter (Aug 2026, immediate follow-up
  // per agreed sequencing). Empty set = "All" -- matches Atif's own spec
  // ("or don't select at all, it is for all"). Only relevant when NOT
  // customer-scoped; the customer-scoped view has nothing to filter.
  const [allCustomers, setAllCustomers] = useState<{ id: string; name: string }[]>([]);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());
  const [customerFilterVisible, setCustomerFilterVisible] = useState(false);

  // Sort toggle (Aug 2026, honest fix -- this was planned as part of the
  // filter follow-up but never actually built when the filter itself
  // shipped). Newest-first by default, matching the backend's own order;
  // client-side reverse when toggled, no re-fetch needed.
  const [sortAscending, setSortAscending] = useState(false);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { router.replace('/login'); return null; }
    return token;
  };

  const loadDocuments = async () => {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      let qs = '';
      if (params.customer_id) {
        qs = `?customer_id=${params.customer_id}`;
      } else if (selectedCustomerIds.size > 0) {
        qs = `?customer_ids=${Array.from(selectedCustomerIds).join(',')}`;
      }
      const res = await fetch(`${backendUrl}/api/documents${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setInvoices(data.invoices || []);
        setQuotes(data.quotes || []);
        setDrafts(data.drafts || []);
        setReceipts(data.receipts || []);
      }
    } catch {} finally { setLoading(false); }
  };

  // Fixed Aug 2026 (Atif's feedback): plain useEffect only ran once on
  // mount, so returning here after resuming+editing a draft elsewhere
  // showed stale data (old amounts, old counts) until a manual reload.
  // useFocusEffect re-runs this every time the screen regains focus.
  useFocusEffect(useCallback(() => { loadDocuments(); }, [params.customer_id, selectedCustomerIds]));

  // Fetch the customer list once for the filter picker -- only needed in
  // org-wide mode, no point fetching it when the scope is already locked.
  useEffect(() => {
    if (isCustomerScoped) return;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl}/api/customers`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          setAllCustomers(data.customers || []);
        }
      } catch {}
    })();
  }, []);

  const toggleCustomerFilter = (id: string) => {
    setSelectedCustomerIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openPdf = (url: string | null) => {
    if (!url) return;
    Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open PDF'));
  };

  const handleCreateChallan = async (invoiceId: string) => {
    setCreatingChallan(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/invoices/${invoiceId}/pdf`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generate_challan: true,
          transport_name: transportName || null,
          bundle_count: bundleCount ? parseInt(bundleCount) : null,
          goods_description: goodsDescription || null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setChallanFormFor(null);
        setTransportName(''); setBundleCount(''); setGoodsDescription('');
        await loadDocuments();
        if (data.challan_pdf_url) openPdf(data.challan_pdf_url);
      } else {
        Alert.alert('Error', 'Could not create challan. Please try again.');
      }
    } catch {
      Alert.alert('Error', 'Could not create challan. Please try again.');
    } finally { setCreatingChallan(false); }
  };

  const tabs: { key: TabType; label: string; count: number }[] = [
    { key: 'invoice', label: 'Invoice', count: invoices.length },
    { key: 'challan', label: 'Challan', count: invoices.filter(i => i.has_challan).length },
    { key: 'quote', label: 'Quote', count: quotes.length },
    { key: 'draft', label: 'Draft', count: drafts.length },
    { key: 'receipt', label: 'Receipt', count: receipts.length },
  ];

  const renderInvoiceRow = ({ item }: { item: InvoiceDoc }) => (
    <TouchableOpacity style={s.row} onPress={() => openPdf(item.pdf_url)}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{item.invoice_number}</Text>
        {!isCustomerScoped && <Text style={s.rowSubtitle}>{item.customer_name}</Text>}
        <Text style={s.rowDate}>{fmtDate(item.issue_date)}</Text>
      </View>
      <Text style={s.rowAmount}>{fmt(item.total_amount)}</Text>
    </TouchableOpacity>
  );

  const renderChallanRow = ({ item }: { item: InvoiceDoc }) => (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{item.invoice_number}</Text>
        {!isCustomerScoped && <Text style={s.rowSubtitle}>{item.customer_name}</Text>}
        <Text style={s.rowDate}>{fmtDate(item.issue_date)}</Text>
        {challanFormFor === item.id && (
          <View style={s.inlineForm}>
            <TextInput style={s.inlineInput} placeholder="Transport name" placeholderTextColor="#999" value={transportName} onChangeText={setTransportName} />
            <TextInput style={s.inlineInput} placeholder="Bundles" placeholderTextColor="#999" value={bundleCount} onChangeText={setBundleCount} keyboardType="numeric" />
            <TextInput style={s.inlineInput} placeholder="Goods description (optional)" placeholderTextColor="#999" value={goodsDescription} onChangeText={setGoodsDescription} />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={s.inlineCancelBtn} onPress={() => setChallanFormFor(null)} disabled={creatingChallan}>
                <Text style={s.inlineCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.inlineSubmitBtn} onPress={() => handleCreateChallan(item.id)} disabled={creatingChallan}>
                {creatingChallan ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.inlineSubmitText}>Submit</Text>}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
      {item.has_challan ? (
        <TouchableOpacity style={s.actionBtn} onPress={() => openPdf(item.challan_pdf_url)}>
          <Text style={s.actionBtnText}>View Challan</Text>
        </TouchableOpacity>
      ) : challanFormFor !== item.id ? (
        <TouchableOpacity style={s.actionBtnOutline} onPress={() => setChallanFormFor(item.id)}>
          <Text style={s.actionBtnOutlineText}>Create Challan</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const renderQuoteRow = ({ item }: { item: QuoteDoc }) => (
    <TouchableOpacity style={s.row} onPress={() => openPdf(item.pdf_url)}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{item.quote_number}</Text>
        {!isCustomerScoped && <Text style={s.rowSubtitle}>{item.customer_name}</Text>}
        <Text style={s.rowDate}>{fmtDate(item.issue_date)}</Text>
      </View>
      <Text style={s.rowAmount}>{fmt(item.total_amount)}</Text>
    </TouchableOpacity>
  );

  const renderDraftRow = ({ item }: { item: DraftDoc }) => (
    <TouchableOpacity style={s.row} onPress={() => router.push(`/customer/${item.customer_id}/invoice?resume_draft_id=${item.id}`)}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{!isCustomerScoped ? item.customer_name : 'Draft'}</Text>
        <Text style={s.rowDate}>{fmtDate(item.created_at)}</Text>
      </View>
      <Text style={s.rowAmount}>{fmt(item.total_amount)}</Text>
      <Ionicons name="chevron-forward" size={18} color="#999" style={{ marginLeft: 8 }} />
    </TouchableOpacity>
  );

  // Compacted to a two-column layout (Aug 2026, Atif's feedback) --
  // matches the same amount-on-the-right pattern the other row renderers
  // already use, cutting the row height roughly in half versus four
  // fully stacked lines.
  const renderReceiptRow = ({ item }: { item: ReceiptDoc }) => (
    <View style={[s.row, item.type === 'advance' && s.advanceRow]}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {!isCustomerScoped && <Text style={s.rowTitle}>{item.customer_name}</Text>}
          {item.type === 'advance' && (
            <View style={s.advanceBadge}><Text style={s.advanceBadgeText}>ADVANCE</Text></View>
          )}
        </View>
        <Text style={s.rowSubtitle}>
          {item.type === 'payment'
            ? `${item.payment_mode || 'Payment'}${item.invoice_number ? ` — ${item.invoice_number}` : ''}`
            : `${item.payment_mode || 'Advance'}${item.purpose ? ` — ${item.purpose}` : ''}${item.status === 'fully_applied' ? ' (fully applied)' : ''}`}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={s.rowAmount}>{fmt(item.amount)}</Text>
        <Text style={s.rowDate}>{fmtDate(item.date)}</Text>
      </View>
    </View>
  );

  const emptyLabel = { invoice: 'No invoices yet', challan: 'No invoices yet', quote: 'No quotes yet', draft: 'No drafts', receipt: 'No payments received yet' }[activeTab];

  const currentData = activeTab === 'invoice' ? invoices : activeTab === 'challan' ? invoices : activeTab === 'quote' ? quotes : activeTab === 'draft' ? drafts : receipts;
  const sortedData = sortAscending ? [...currentData].reverse() : currentData;

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Documents</Text>
        {isCustomerScoped ? (
          <View style={{ width: 24 }} />
        ) : (
          <TouchableOpacity onPress={() => setCustomerFilterVisible(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="filter" size={20} color="#FFFFFF" />
            {selectedCustomerIds.size > 0 && <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700' }}>{selectedCustomerIds.size}</Text>}
          </TouchableOpacity>
        )}
      </View>

      {!isCustomerScoped && (
        <BottomSheet visible={customerFilterVisible} onDismiss={() => setCustomerFilterVisible(false)} scrollable={false}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 4 }}>Filter by Customer</Text>
          <Text style={{ fontSize: 13, color: '#999', marginBottom: 12 }}>Select one, several, or none for all customers.</Text>
          {/* Apply pinned above the scrollable list (Aug 2026, Atif's
              feedback) -- with hundreds of customers, a bottom-anchored
              button would sit behind a very long scroll. */}
          <TouchableOpacity
            style={{ marginBottom: 12, backgroundColor: '#075E54', paddingVertical: 12, borderRadius: 10, alignItems: 'center' }}
            onPress={() => setCustomerFilterVisible(false)}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 14 }}>Apply</Text>
          </TouchableOpacity>
          <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
              onPress={() => setSelectedCustomerIds(new Set())}
            >
              <Ionicons name={selectedCustomerIds.size === 0 ? 'checkbox' : 'square-outline'} size={20} color="#075E54" />
              <Text style={{ marginLeft: 10, fontSize: 14, fontWeight: '700', color: '#075E54' }}>All Customers</Text>
            </TouchableOpacity>
            {allCustomers.map(cust => (
              <TouchableOpacity
                key={cust.id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
                onPress={() => toggleCustomerFilter(cust.id)}
              >
                <Ionicons name={selectedCustomerIds.has(cust.id) ? 'checkbox' : 'square-outline'} size={20} color="#075E54" />
                <Text style={{ marginLeft: 10, fontSize: 14, color: '#1A1A1A' }}>{cust.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </BottomSheet>
      )}

      <View style={s.tabBarContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabBar}>
          {tabs.map(t => (
            <TouchableOpacity key={t.key} style={[s.tab, activeTab === t.key && s.tabActive]} onPress={() => setActiveTab(t.key)}>
              <Text style={[s.tabText, activeTab === t.key && s.tabTextActive]}>{t.label}{t.count > 0 ? ` (${t.count})` : ''}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity style={s.sortBtn} onPress={() => setSortAscending(!sortAscending)}>
          <Ionicons name={sortAscending ? 'arrow-up' : 'arrow-down'} size={18} color="#075E54" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#075E54" />
      ) : (
        <FlatList
          data={sortedData}
          keyExtractor={(item: any) => item.id}
          renderItem={activeTab === 'invoice' ? renderInvoiceRow : activeTab === 'challan' ? renderChallanRow : activeTab === 'quote' ? renderQuoteRow : activeTab === 'draft' ? renderDraftRow : renderReceiptRow}
          ListEmptyComponent={<Text style={s.emptyText}>{emptyLabel}</Text>}
          contentContainerStyle={{ paddingBottom: 20 }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#075E54', paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  // Made horizontally scrollable (Aug 2026, Atif's feedback) -- flex:1
  // equal division looked increasingly squeezed as tabs were added
  // (Receipt, and Balance Sheet to follow), so each tab now takes its
  // own natural content width and the row scrolls instead of shrinking.
  tabBarContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E0E0E0' },
  tabBar: { flexDirection: 'row', flexGrow: 0 },
  tab: { paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  sortBtn: { paddingHorizontal: 14, paddingVertical: 12, justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: '#F0F0F0' },
  tabActive: { borderBottomColor: '#075E54' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#999' },
  tabTextActive: { color: '#075E54' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  advanceRow: { borderLeftWidth: 3, borderLeftColor: '#F59E0B' },
  advanceBadge: { backgroundColor: '#FEF3C7', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  advanceBadgeText: { fontSize: 9, fontWeight: '700', color: '#92400E', letterSpacing: 0.3 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: '#1A1A1A' },
  rowSubtitle: { fontSize: 13, color: '#555', marginTop: 2 },
  rowDate: { fontSize: 12, color: '#999', marginTop: 2 },
  rowAmount: { fontSize: 15, fontWeight: '700', color: '#1A1A1A' },
  actionBtn: { backgroundColor: '#E8F5E9', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  actionBtnText: { fontSize: 12, fontWeight: '700', color: '#075E54' },
  actionBtnOutline: { borderWidth: 1, borderColor: '#075E54', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  actionBtnOutlineText: { fontSize: 12, fontWeight: '700', color: '#075E54' },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 40, fontSize: 14 },
  inlineForm: { marginTop: 10, gap: 8 },
  inlineInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, color: '#1A1A1A', backgroundColor: '#FAFAFA' },
  inlineCancelBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#E0E0E0', alignItems: 'center' },
  inlineCancelText: { fontSize: 13, fontWeight: '600', color: '#666' },
  inlineSubmitBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: '#075E54', alignItems: 'center' },
  inlineSubmitText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
});
