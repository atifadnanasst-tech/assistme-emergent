/**
 * AssistMe - New Quote Screen
 * Location: /frontend/app/customer/[id]/quote.tsx
 * Created: Aug 2026 (Create Quote surface, subtask 3)
 *
 * Built by copying invoice.tsx's structure -- Atif's own explicit
 * instruction: where logic genuinely IS callable (calculateInvoiceTotals,
 * generateDocumentPDF, mirrorCardToReceiverOrg, via the backend's
 * createQuoteRecord()), reuse it directly. Where it isn't (invoice.tsx's
 * own handleSubmit is screen-local, not an importable function), copy
 * the proven pattern rather than force a risky shared abstraction --
 * matching the same reasoning used for record-payment.tsx's three-button
 * flow. Zero changes made to invoice.tsx itself.
 *
 * Deliberately simpler than invoice.tsx, per Atif's explicit "keep V1
 * simple, one sitting" call:
 * - No drafts (invoice.tsx's resume_draft_id / Save Draft / beforeRemove
 *   prompt are all invoice-only concepts here)
 * - No "also create Delivery Challan" -- a quote isn't a finalized sale
 * - No "also collect payment now" -- same reasoning
 * - No packing & handling, address picker, tax ID, payment terms,
 *   delivery preference, PO number, "set as default" -- all invoice-only
 *   extras not part of Spark's own create_quote params either
 *
 * Accepts the same items/due_date/amount/draft_id/action_id URL params
 * invoice.tsx does, specifically so Spark's action-preview "Edit" button
 * (previously hard-routing every quote edit to the INVOICE screen, since
 * this screen was just a stub) can now route create_quote actions here
 * correctly.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { authService } from '../../../lib/auth';

interface Product { id: string; name: string; sku: string; selling_price: number; tax_rate: number; unit: string; hsn_code: string | null; image_url: string | null; }
interface LineItem { product_id: string; product_name: string; hsn_code: string | null; quantity: number; unit_price: number; tax_rate: number; discount_pct: number; line_total: number; }
interface Customer { id: string; name: string; phone: string; }

export default function NewQuoteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; items?: string; amount?: string; due_date?: string; draft_id?: string; action_id?: string }>();
  const id = params.id;
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [createdQuote, setCreatedQuote] = useState<{ id: string; number: string; pdf_url: string | null } | null>(null);
  const [orgName, setOrgName] = useState('');
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(id || '');
  const [customerSearchVisible, setCustomerSearchVisible] = useState(false);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [addingItem, setAddingItem] = useState(false);
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const quantityInputRef = useRef<TextInput>(null);
  const [newQty, setNewQty] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newDiscount, setNewDiscount] = useState('');
  const [newHsn, setNewHsn] = useState('');
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState('');

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => { loadForm(); }, [id]);

  const loadForm = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      // Reuses /api/invoice/new directly -- genuinely generic base data
      // (org/customer/products), not invoice-specific despite the path
      // name, so no separate endpoint needed for this piece.
      const res = await fetch(`${backendUrl}/api/invoice/new?customer_id=${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setOrgName(data.organisation?.name || '');
      setCustomerName(data.customer?.name || '');
      setCustomerId(data.customer?.id || id || '');
      setAllCustomers(data.all_customers || []);
      setProducts(data.products || []);
      if (data.prefilled_items?.length > 0) setItems(data.prefilled_items);
      if (params.due_date) setDueDate(params.due_date as string);

      // Populate from Spark params if passed via URL (same pattern
      // invoice.tsx uses for its own action-preview Edit button).
      if (params.items) {
        try {
          const sparkItems = JSON.parse(params.items as string);
          if (Array.isArray(sparkItems) && sparkItems.length > 0 && data.products) {
            const lineItems: LineItem[] = sparkItems.map((si: any) => {
              const match = (data.products || []).find((p: Product) =>
                p.id === si.product_id || p.name.toLowerCase().includes((si.product_name || '').toLowerCase())
              );
              return {
                product_id: match?.id || si.product_id || '',
                product_name: match?.name || si.product_name || '',
                hsn_code: match?.hsn_code || null,
                quantity: si.quantity || 1,
                unit_price: match?.selling_price || si.unit_price || 0,
                tax_rate: match?.tax_rate || 0,
                discount_pct: 0,
                line_total: (si.quantity || 1) * (match?.selling_price || si.unit_price || 0),
              };
            });
            setItems(lineItems);
          }
        } catch (e) { console.warn('Failed to parse spark items:', e); }
      }
    } catch {} finally { setLoading(false); }
  };

  // Totals (client-side for UX, mirrors invoice.tsx's own math exactly
  // so the preview never drifts from what calculateInvoiceTotals()
  // actually computes server-side).
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const gstAmount = items.reduce((s, i) => s + (i.line_total * i.tax_rate / 100), 0);
  const total = subtotal + gstAmount;
  const gstRates = [...new Set(items.map(i => i.tax_rate))];
  const gstRateSuffix = gstRates.length === 1 ? ` ${gstRates[0]}%` : '';
  const gstLabel = gstRates.length === 0 ? 'GST' : gstRates.length === 1 ? `GST ${gstRates[0]}%` : 'GST (mixed)';

  const handleAddItem = () => {
    if (!selectedProductId) { Alert.alert('Error', 'Select a product'); return; }
    const qty = parseFloat(newQty) || 0;
    const price = parseFloat(newPrice) || 0;
    if (qty <= 0) { Alert.alert('Error', 'Quantity is required'); return; }
    const product = products.find(p => p.id === selectedProductId);
    if (!product) return;
    const discount = parseFloat(newDiscount) || 0;
    const lineSubtotal = qty * price;
    const lineTotal = Math.round((lineSubtotal - (lineSubtotal * discount / 100)) * 100) / 100;
    const newLine = {
      product_id: product.id, product_name: product.name, hsn_code: newHsn || product.hsn_code,
      quantity: qty, unit_price: price, tax_rate: product.tax_rate, discount_pct: discount, line_total: lineTotal,
    };
    if (editingItemIndex !== null) {
      setItems(prev => prev.map((it, idx) => idx === editingItemIndex ? newLine : it));
      setEditingItemIndex(null);
      setAddingItem(false);
    } else {
      setItems(prev => [...prev, newLine]);
    }
    setSelectedProductId(''); setNewQty(''); setNewPrice(''); setNewDiscount(''); setNewHsn(''); setAiSuggestion(null);
  };

  const handleRemoveItem = (index: number) => { setItems(prev => prev.filter((_, i) => i !== index)); };

  const handleSelectProduct = (productId: string) => {
    setSelectedProductId(productId);
    const product = products.find(p => p.id === productId);
    if (product) setNewPrice(product.selling_price.toString());
    if (product) setNewHsn(product.hsn_code || '');
    setAiSuggestion(null);
    setProductSearchQuery('');
    setTimeout(() => quantityInputRef.current?.focus(), 100);
  };

  const handleAiSuggestion = async () => {
    if (!selectedProductId || !customerId) return;
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/invoice/ai-suggestion?product_id=${selectedProductId}&customer_id=${customerId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setAiSuggestion(data.reason || 'No suggestion available yet');
      if (data.suggested_quantity) setNewQty(data.suggested_quantity.toString());
      if (data.suggested_price) setNewPrice(data.suggested_price.toString());
    } catch { setAiSuggestion('No suggestion available yet'); }
  };

  const handleSubmit = async (action: 'pdf' | 'share' | 'whatsapp') => {
    if (items.length === 0) { Alert.alert('Error', 'Add at least one item'); return; }
    setSubmitting(action);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      // Same immutability principle as invoice.tsx: reuse the quote
      // already created earlier in this same visit instead of creating
      // a duplicate on repeated taps.
      let quote: { id: string; number: string; pdf_url: string | null };

      if (createdQuote) {
        quote = createdQuote;
      } else {
        // createQuoteRecord() (backend) generates the PDF INSIDE this
        // same call -- unlike invoice.tsx's two-step create-then-pdf
        // flow, there's no separate PDF-generation request needed here.
        const r1 = await fetch(`${backendUrl}/api/quotes`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_id: customerId,
            items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, hsn_code: i.hsn_code })),
            due_date: dueDate || undefined,
          }),
        });

        if (!r1.ok) {
          const err = await r1.text();
          console.error('[QUOTE] Create failed:', err);
          Alert.alert('Error', 'Failed to create quote');
          return;
        }

        const created = await r1.json();
        if (!created.quote_id) { Alert.alert('Error', 'Failed to create quote'); return; }
        quote = { id: created.quote_id, number: created.quote_number, pdf_url: created.pdf_url };
        setCreatedQuote(quote);
      }

      if (action === 'pdf') {
        Alert.alert('Quote Created', `Quote ${quote.number} saved.`, [
          ...(quote.pdf_url ? [{ text: 'View Quote', onPress: () => Linking.openURL(quote.pdf_url!) }] : []),
          { text: 'OK' },
        ]);
      } else if (action === 'share') {
        const r3 = await fetch(`${backendUrl}/api/quotes/${quote.id}/share`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'app' }),
        });
        if (!r3.ok) {
          Alert.alert('Error', 'Failed to share quote');
          return;
        }
        Alert.alert('Success', 'Quote shared in chat ✓');
        router.back();
      } else if (action === 'whatsapp') {
        const r3 = await fetch(`${backendUrl}/api/quotes/${quote.id}/share`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'whatsapp' }),
        });
        if (!r3.ok) {
          Alert.alert('Error', 'Failed to generate WhatsApp link');
          return;
        }
        const wa = await r3.json();
        if (wa.whatsapp_url) {
          try { await Linking.openURL(wa.whatsapp_url); } catch { Alert.alert('Error', 'Could not open WhatsApp'); }
        }
        router.back();
      }
    } catch (error) {
      console.error('[QUOTE] Submit error:', error);
      Alert.alert('Error', 'Something went wrong');
    } finally {
      setSubmitting(null);
    }
  };

  const handleSelectCustomer = (customer: Customer) => {
    setCustomerId(customer.id);
    setCustomerName(customer.name);
    setCustomerSearchVisible(false);
    setCustomerSearchQuery('');
  };

  const filteredCustomers = allCustomers.filter(c =>
    c.name.toLowerCase().includes(customerSearchQuery.toLowerCase())
  );

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(productSearchQuery.toLowerCase())
  );

  const fmt = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (loading) return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}><TouchableOpacity onPress={() => router.back()} style={s.headerBtn}><Ionicons name="arrow-back" size={24} color="#FFF" /></TouchableOpacity><Text style={s.headerTitle}>New Quote</Text></View>
      <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
    </SafeAreaView>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <SafeAreaView style={s.safe} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}><Ionicons name="arrow-back" size={24} color="#FFF" /></TouchableOpacity>
          <Text style={s.headerTitle}>New Quote</Text>
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
          <Text style={[s.sectionLabel, { marginTop: 0 }]}>MY BUSINESS NAME</Text>
          <TouchableOpacity style={s.fieldRow} onPress={() => router.push('/settings/profile')} activeOpacity={0.7}>
            <Text style={s.fieldValue}>{orgName}</Text>
            <Ionicons name="pencil" size={18} color="#075E54" />
          </TouchableOpacity>

          <Text style={s.sectionLabel}>CUSTOMER</Text>
          <View style={s.fieldRow}>
            <Text style={s.fieldValue}>{customerName}</Text>
            <TouchableOpacity onPress={() => setCustomerSearchVisible(true)} style={{ marginLeft: 'auto' }}>
              <Ionicons name="pencil" size={18} color="#075E54" />
            </TouchableOpacity>
          </View>

          <Text style={s.sectionLabel}>VALID UNTIL <Text style={{ color: '#999', fontWeight: '400' }}>(optional)</Text></Text>
          <TextInput style={s.fieldRow} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" />

          {/* Items */}
          <Text style={s.sectionLabel}>ITEMS</Text>
          {items.map((item, i) => (
            <TouchableOpacity
              key={i} style={s.itemRow}
              onPress={() => {
                setEditingItemIndex(i);
                setSelectedProductId(item.product_id);
                setNewQty(item.quantity.toString());
                setNewPrice(item.unit_price.toString());
                setNewDiscount((item.discount_pct || 0).toString());
                setNewHsn(item.hsn_code || '');
                setAddingItem(true);
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.itemName}>{item.product_name}</Text>
                <Text style={s.itemDetail}>{item.quantity} × {fmt(item.unit_price)}</Text>
                <Text style={{ fontSize: 11, color: '#999', marginTop: 2 }}>HSN: {item.hsn_code || '—'}  ·  Discount: {item.discount_pct || 0}%</Text>
              </View>
              <Text style={s.itemTotal}>{fmt(item.line_total)}</Text>
              <TouchableOpacity onPress={() => handleRemoveItem(i)}><Text style={s.removeBtn}>×</Text></TouchableOpacity>
            </TouchableOpacity>
          ))}

          {addingItem && (
            <View style={s.selectorPanel}>
              <Text style={s.selectorTitle}>ITEM SELECTOR</Text>
              <View style={s.searchContainer}>
                <Ionicons name="search" size={20} color="#999" style={s.searchIcon} />
                <TextInput
                  style={s.searchInputField}
                  placeholder="Search products..."
                  placeholderTextColor="#999"
                  value={productSearchQuery}
                  onChangeText={setProductSearchQuery}
                />
                {productSearchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setProductSearchQuery('')} style={s.clearBtn}>
                    <Ionicons name="close-circle" size={20} color="#999" />
                  </TouchableOpacity>
                )}
              </View>
              {productSearchQuery.length > 0 && (
                <ScrollView style={s.productSearchResults} nestedScrollEnabled keyboardShouldPersistTaps="always">
                  {filteredProducts.map(p => (
                    <TouchableOpacity key={p.id} style={s.productSearchRow} onPress={() => handleSelectProduct(p.id)}>
                      <Text style={s.productSearchName}>{p.name}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={s.productSearchPrice}>₹{p.selling_price}</Text>
                        {selectedProductId === p.id && <Ionicons name="checkmark-circle" size={20} color="#075E54" />}
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
              {selectedProductId && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <Ionicons name="checkmark-circle" size={16} color="#075E54" />
                  <Text style={{ fontSize: 13, color: '#075E54', fontWeight: '600' }}>
                    Selected: {products.find(p => p.id === selectedProductId)?.name}
                  </Text>
                </View>
              )}
              <View style={s.twoCol}>
                <View style={s.col}><Text style={s.miniLabel}>QUANTITY <Text style={{ color: 'red' }}>*</Text></Text><TextInput ref={quantityInputRef} style={s.numInput} value={newQty} onChangeText={setNewQty} keyboardType="numeric" placeholder="0" /></View>
                <View style={s.col}><Text style={s.miniLabel}>PRICE</Text><TextInput style={s.numInput} value={newPrice} onChangeText={setNewPrice} keyboardType="numeric" placeholder="₹ 0.00" /></View>
              </View>
              <View style={s.twoCol}>
                <View style={s.col}><Text style={s.miniLabel}>DISCOUNT %</Text><TextInput style={s.numInput} value={newDiscount} onChangeText={setNewDiscount} keyboardType="numeric" placeholder="0" /></View>
                <View style={s.col}><Text style={s.miniLabel}>HSN CODE</Text><TextInput style={s.numInput} value={newHsn} onChangeText={setNewHsn} keyboardType="numeric" placeholder="e.g. 3304" /></View>
              </View>
              <TouchableOpacity onPress={handleAiSuggestion}><Text style={s.aiSuggestLink}>✦ See AI Suggestion</Text></TouchableOpacity>
              {aiSuggestion && <Text style={s.aiSuggestText}>{aiSuggestion}</Text>}
              <View style={s.selectorBtns}>
                <TouchableOpacity onPress={() => { setAddingItem(false); setEditingItemIndex(null); setAiSuggestion(null); setSelectedProductId(''); setNewQty(''); setNewPrice(''); setNewDiscount(''); setNewHsn(''); }}><Text style={s.cancelText}>Cancel</Text></TouchableOpacity>
                <TouchableOpacity style={s.addToListBtn} onPress={handleAddItem}><Text style={s.addToListText}>{editingItemIndex !== null ? 'Update' : 'Add to List'}</Text></TouchableOpacity>
              </View>
            </View>
          )}

          <TouchableOpacity style={s.addItemBtn} onPress={() => setAddingItem(true)}>
            <Ionicons name="add-circle" size={20} color="#075E54" /><Text style={s.addItemText}>+ ADD ITEM</Text>
          </TouchableOpacity>

          {/* Totals -- no packing & handling for quotes (invoice-only extra) */}
          <View style={s.totalsCard}>
            <View style={s.totalRow}><Text style={s.totalLabel}>Subtotal</Text><Text style={s.totalValue}>{fmt(subtotal)}</Text></View>
            <View style={s.totalRow}><Text style={s.totalLabel}>{gstLabel}</Text><Text style={s.totalValue}>+{fmt(gstAmount)}</Text></View>
            <View style={[s.totalRow, { borderTopWidth: 1, borderTopColor: '#E0E0E0', paddingTop: 12, marginTop: 8 }]}>
              <Text style={s.grandTotalLabel}>TOTAL</Text><Text style={s.grandTotalValue}>{fmt(total)}</Text>
            </View>
          </View>

          <View style={{ height: 100 }} />
        </ScrollView>
      </SafeAreaView>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity style={s.pdfBtn} onPress={() => handleSubmit('pdf')} disabled={!!submitting || items.length === 0 || !!createdQuote}>
            {submitting === 'pdf' ? <ActivityIndicator size="small" color="#333" /> : <><Ionicons name={createdQuote ? 'checkmark-circle' : 'document'} size={16} color="#333" /><Text style={s.pdfBtnText}>{createdQuote ? 'Created' : 'Create'}</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={s.shareBtn} onPress={() => handleSubmit('share')} disabled={!!submitting || items.length === 0}>
            {submitting === 'share' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="share-social" size={16} color="#FFF" /><Text style={s.shareBtnText}>Share Here</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={s.waBtn} onPress={() => handleSubmit('whatsapp')} disabled={!!submitting || items.length === 0}>
            {submitting === 'whatsapp' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="logo-whatsapp" size={16} color="#FFF" /><Text style={s.waBtnText}>WhatsApp</Text></>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Customer Search Modal */}
      <Modal visible={customerSearchVisible} animationType="slide" transparent={true} onRequestClose={() => setCustomerSearchVisible(false)}>
        <KeyboardAvoidingView style={s.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <SafeAreaView style={s.modalContent} edges={['bottom']}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Select Customer</Text>
              <TouchableOpacity onPress={() => setCustomerSearchVisible(false)}>
                <Ionicons name="close" size={24} color="#333" />
              </TouchableOpacity>
            </View>
            <TextInput
              style={s.searchInput}
              placeholder="Search customer..."
              value={customerSearchQuery}
              onChangeText={setCustomerSearchQuery}
              autoFocus
            />
            <ScrollView style={s.customerList}>
              {filteredCustomers.map(customer => (
                <TouchableOpacity key={customer.id} style={s.customerItem} onPress={() => handleSelectCustomer(customer)}>
                  <Text style={s.customerItemName}>{customer.name}</Text>
                  <Text style={s.customerItemPhone}>{customer.phone}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 16, paddingTop: 8 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5, marginTop: 16, marginBottom: 6 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 14, gap: 10 },
  fieldValue: { flex: 1, fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  miniLabel: { fontSize: 10, fontWeight: '600', color: '#999', letterSpacing: 0.3, marginTop: 8, marginBottom: 4 },
  twoCol: { flexDirection: 'row', gap: 16 },
  col: { flex: 1 },
  itemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 12, marginBottom: 6, gap: 10 },
  itemName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  itemDetail: { fontSize: 13, color: '#666', marginTop: 2 },
  itemTotal: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  removeBtn: { fontSize: 22, color: '#D32F2F', paddingHorizontal: 8 },
  addItemBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12 },
  addItemText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  selectorPanel: { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E0E0E0' },
  selectorTitle: { fontSize: 11, fontWeight: '600', color: '#999', marginBottom: 8 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E5E5E5', marginBottom: 8 },
  searchIcon: { marginRight: 8 },
  searchInputField: { flex: 1, fontSize: 15, color: '#1A1A1A', paddingVertical: 4 },
  clearBtn: { padding: 4 },
  productSearchResults: { maxHeight: 200, marginBottom: 12, overflow: 'hidden' },
  productSearchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  productSearchName: { fontSize: 14, color: '#333', flex: 1 },
  productSearchPrice: { fontSize: 13, color: '#666' },
  numInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 10, fontSize: 15 },
  aiSuggestLink: { color: '#075E54', fontSize: 13, fontWeight: '600', marginTop: 8 },
  aiSuggestText: { color: '#666', fontSize: 12, fontStyle: 'italic', marginTop: 4 },
  selectorBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 14 },
  cancelText: { fontSize: 14, color: '#666', paddingVertical: 10 },
  addToListBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 },
  addToListText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  totalsCard: { backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginTop: 16 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  totalLabel: { fontSize: 14, color: '#666' },
  totalValue: { fontSize: 14, color: '#333' },
  grandTotalLabel: { fontSize: 18, fontWeight: '700', color: '#075E54' },
  grandTotalValue: { fontSize: 22, fontWeight: '700', color: '#075E54' },
  bottomSafe: { backgroundColor: '#FFF' },
  bottomBar: { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  pdfBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#F5F5F5' },
  pdfBtnText: { fontSize: 14, fontWeight: '600', color: '#333' },
  shareBtn: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#075E54' },
  shareBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
  waBtn: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#25D366' },
  waBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, height: '80%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E0E0E0' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1A1A1A' },
  searchInput: { marginHorizontal: 16, marginTop: 12, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#F5F5F5', borderRadius: 10, fontSize: 15 },
  customerList: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  customerItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  customerItemName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  customerItemPhone: { fontSize: 13, color: '#666', marginTop: 2 },
});
