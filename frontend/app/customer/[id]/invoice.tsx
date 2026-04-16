import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { authService } from '../../../lib/auth';

interface Product { id: string; name: string; sku: string; selling_price: number; tax_rate: number; unit: string; hsn_code: string | null; }
interface LineItem { product_id: string; product_name: string; hsn_code: string | null; quantity: number; unit_price: number; tax_rate: number; line_total: number; }

export default function NewInvoiceScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(id || '');
  const [customerExpanded, setCustomerExpanded] = useState(false);
  const [customerDefaults, setCustomerDefaults] = useState<any>({});
  const [billingAddress, setBillingAddress] = useState<any>(null);
  const [shippingAddress, setShippingAddress] = useState<any>(null);
  const [taxId, setTaxId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryPref, setDeliveryPref] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [invoiceType, setInvoiceType] = useState('Tax Invoice');
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [packingHandling, setPackingHandling] = useState(0);
  const [addingItem, setAddingItem] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);

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
      const res = await fetch(`${backendUrl}/api/invoice/new?customer_id=${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setOrgName(data.organisation?.name || '');
      setCustomerName(data.customer?.name || '');
      setCustomerId(data.customer?.id || id || '');
      setTaxId(data.customer?.tax_id || '');
      setCustomerDefaults(data.customer?.custom_fields || {});
      setPaymentTerms(data.customer?.custom_fields?.payment_terms || '');
      setDeliveryPref(data.customer?.custom_fields?.delivery_preference || '');
      setInvoiceType(data.customer?.custom_fields?.default_invoice_type || 'Tax Invoice');
      setBillingAddress(data.billing_address);
      setShippingAddress(data.shipping_address);
      setProducts(data.products || []);
      if (data.prefilled_items?.length > 0) setItems(data.prefilled_items);
    } catch {} finally { setLoading(false); }
  };

  // Totals (client-side for UX)
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const gstAmount = items.reduce((s, i) => s + (i.line_total * i.tax_rate / 100), 0);
  const total = subtotal + gstAmount + packingHandling;
  const gstRates = [...new Set(items.map(i => i.tax_rate))];
  const gstLabel = gstRates.length === 0 ? 'GST' : gstRates.length === 1 ? `GST ${gstRates[0]}%` : 'GST (mixed)';

  const handleAddItem = () => {
    if (!selectedProductId) { Alert.alert('Error', 'Select a product'); return; }
    const qty = parseFloat(newQty) || 0;
    const price = parseFloat(newPrice) || 0;
    if (qty <= 0 || price <= 0) { Alert.alert('Error', 'Quantity and price must be > 0'); return; }
    const product = products.find(p => p.id === selectedProductId);
    if (!product) return;
    setItems(prev => [...prev, {
      product_id: product.id, product_name: product.name, hsn_code: product.hsn_code,
      quantity: qty, unit_price: price, tax_rate: product.tax_rate, line_total: Math.round(qty * price * 100) / 100,
    }]);
    setAddingItem(false); setSelectedProductId(''); setNewQty(''); setNewPrice(''); setAiSuggestion(null);
  };

  const handleRemoveItem = (index: number) => { setItems(prev => prev.filter((_, i) => i !== index)); };

  const handleSelectProduct = (productId: string) => {
    setSelectedProductId(productId);
    const product = products.find(p => p.id === productId);
    if (product) setNewPrice(product.selling_price.toString());
    setAiSuggestion(null);
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

      // Create invoice
      const r1 = await fetch(`${backendUrl}/api/invoices`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price })),
          packing_handling: packingHandling, invoice_type: invoiceType, po_number: poNumber || null,
          status: action === 'pdf' ? 'draft' : 'sent',
        }),
      });
      const inv = await r1.json();
      if (!inv.invoice_id) { Alert.alert('Error', 'Failed to create invoice'); return; }

      // Generate PDF
      const r2 = await fetch(`${backendUrl}/api/invoices/${inv.invoice_id}/pdf`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
      });
      const pdf = await r2.json();

      if (action === 'pdf') {
        Alert.alert('PDF Generated', `Invoice ${inv.invoice_number} saved.\n${pdf.pdf_url ? 'PDF ready.' : ''}`);
      } else if (action === 'share') {
        await fetch(`${backendUrl}/api/invoices/${inv.invoice_id}/share`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'app' }),
        });
        router.back();
      } else if (action === 'whatsapp') {
        const r3 = await fetch(`${backendUrl}/api/invoices/${inv.invoice_id}/share`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'whatsapp' }),
        });
        const wa = await r3.json();
        if (wa.whatsapp_url) { try { await Linking.openURL(wa.whatsapp_url); } catch {} }
        router.back();
      }
    } catch { Alert.alert('Error', 'Something went wrong'); }
    finally { setSubmitting(null); }
  };

  const handleSaveDraft = async () => {
    if (items.length === 0) { Alert.alert('Info', 'Add items before saving'); return; }
    setSubmitting('draft');
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      await fetch(`${backendUrl}/api/invoices`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price })),
          packing_handling: packingHandling, invoice_type: invoiceType, status: 'draft',
        }),
      });
      Alert.alert('Saved', 'Draft saved ✓');
    } catch {} finally { setSubmitting(null); }
  };

  const fmt = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (loading) return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}><TouchableOpacity onPress={() => router.back()} style={s.headerBtn}><Ionicons name="arrow-back" size={24} color="#FFF" /></TouchableOpacity><Text style={s.headerTitle}>New Invoice</Text></View>
      <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
    </SafeAreaView>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <SafeAreaView style={s.safe} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}><Ionicons name="arrow-back" size={24} color="#FFF" /></TouchableOpacity>
          <Text style={s.headerTitle}>New Invoice</Text>
          <TouchableOpacity onPress={handleSaveDraft} style={s.saveDraftBtn} disabled={!!submitting}>
            {submitting === 'draft' ? <ActivityIndicator size="small" color="#A5D6A7" /> : <Text style={s.saveDraftText}>Save Draft</Text>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Business Name */}
        <Text style={s.sectionLabel}>MY BUSINESS NAME</Text>
        <View style={s.fieldRow}><Text style={s.fieldValue}>{orgName}</Text><Ionicons name="pencil" size={18} color="#075E54" /></View>

        {/* Customer */}
        <Text style={s.sectionLabel}>CUSTOMER</Text>
        <View style={s.fieldRow}>
          <Text style={s.fieldValue}>{customerName}</Text>
          <Ionicons name="pencil" size={18} color="#075E54" />
          <TouchableOpacity onPress={() => setCustomerExpanded(!customerExpanded)}>
            <Ionicons name={customerExpanded ? 'chevron-up' : 'chevron-down'} size={22} color="#666" />
          </TouchableOpacity>
        </View>

        {customerExpanded && (
          <View style={s.expandedSection}>
            {customerDefaults.payment_terms && <Text style={s.defaultsLabel}>Customer defaults <Text style={{ color: '#4CAF50' }}>All saved ✓</Text></Text>}
            <Text style={s.miniLabel}>INVOICE TYPE</Text>
            <View style={s.toggleRow}>
              <TouchableOpacity style={[s.toggleBtn, invoiceType === 'Tax Invoice' && s.toggleActive]} onPress={() => setInvoiceType('Tax Invoice')}>
                <Text style={[s.toggleText, invoiceType === 'Tax Invoice' && s.toggleTextActive]}>Tax Invoice</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.toggleBtn, invoiceType === 'Internal' && s.toggleActive]} onPress={() => setInvoiceType('Internal')}>
                <Text style={[s.toggleText, invoiceType === 'Internal' && s.toggleTextActive]}>Internal</Text>
              </TouchableOpacity>
            </View>
            <View style={s.twoCol}>
              <View style={s.col}><Text style={s.miniLabel}>BILL TO</Text><Text style={s.miniValue}>{billingAddress ? `${billingAddress.line1}, ${billingAddress.city}` : '—'}</Text></View>
              <View style={s.col}><Text style={s.miniLabel}>SHIP TO</Text><Text style={s.miniValue}>{shippingAddress ? shippingAddress.line1 : 'Same as billing'}</Text><Text style={s.changeLink}>Change ›</Text></View>
            </View>
            <View style={s.twoCol}>
              <View style={s.col}><Text style={s.miniLabel}>GST</Text><Text style={s.miniValue}>{taxId || '—'}</Text></View>
              <View style={s.col}><Text style={s.miniLabel}>PAYMENT TERMS</Text><Text style={s.miniValue}>{paymentTerms || '—'}</Text></View>
            </View>
            <View style={s.twoCol}>
              <View style={s.col}><Text style={s.miniLabel}>DELIVERY PREFERENCE</Text><Text style={s.miniValue}>{deliveryPref || '—'}</Text></View>
              <View style={s.col}><Text style={s.miniLabel}>PO NUMBER</Text><TextInput style={s.miniInput} value={poNumber} onChangeText={setPoNumber} placeholder="— (optional)" /></View>
            </View>
          </View>
        )}

        {/* Items */}
        <Text style={s.sectionLabel}>ITEMS</Text>
        {items.map((item, i) => (
          <View key={i} style={s.itemRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.itemName}>{item.product_name}{item.hsn_code ? ` (HSN ${item.hsn_code})` : ''}</Text>
              <Text style={s.itemDetail}>{item.quantity} × {fmt(item.unit_price)}</Text>
            </View>
            <Text style={s.itemTotal}>{fmt(item.line_total)}</Text>
            <TouchableOpacity onPress={() => handleRemoveItem(i)}><Text style={s.removeBtn}>×</Text></TouchableOpacity>
          </View>
        ))}

        {addingItem && (
          <View style={s.selectorPanel}>
            <Text style={s.selectorTitle}>ITEM SELECTOR</Text>
            <View style={s.productList}>
              {products.map(p => (
                <TouchableOpacity key={p.id} style={[s.productChip, selectedProductId === p.id && s.productChipActive]} onPress={() => handleSelectProduct(p.id)}>
                  <Text style={[s.productChipText, selectedProductId === p.id && { color: '#FFF' }]}>{p.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.twoCol}>
              <View style={s.col}><Text style={s.miniLabel}>QUANTITY</Text><TextInput style={s.numInput} value={newQty} onChangeText={setNewQty} keyboardType="numeric" placeholder="0" /></View>
              <View style={s.col}><Text style={s.miniLabel}>PRICE</Text><TextInput style={s.numInput} value={newPrice} onChangeText={setNewPrice} keyboardType="numeric" placeholder="₹ 0.00" /></View>
            </View>
            <TouchableOpacity onPress={handleAiSuggestion}><Text style={s.aiSuggestLink}>✦ See AI Suggestion</Text></TouchableOpacity>
            {aiSuggestion && <Text style={s.aiSuggestText}>{aiSuggestion}</Text>}
            <TouchableOpacity onPress={() => Alert.alert('Coming Soon', 'Product creation will be available soon')}><Text style={s.newItemLink}>+ NEW ITEM</Text></TouchableOpacity>
            <View style={s.selectorBtns}>
              <TouchableOpacity onPress={() => { setAddingItem(false); setAiSuggestion(null); }}><Text style={s.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={s.addToListBtn} onPress={handleAddItem}><Text style={s.addToListText}>Add to List</Text></TouchableOpacity>
            </View>
          </View>
        )}

        <TouchableOpacity style={s.addItemBtn} onPress={() => setAddingItem(true)}>
          <Ionicons name="add-circle" size={20} color="#075E54" /><Text style={s.addItemText}>+ ADD ITEM</Text>
        </TouchableOpacity>

        {/* Totals */}
        <View style={s.totalsCard}>
          <View style={s.totalRow}><Text style={s.totalLabel}>Subtotal</Text><Text style={s.totalValue}>{fmt(subtotal)}</Text></View>
          <View style={s.totalRow}><Text style={s.totalLabel}>{gstLabel}</Text><Text style={s.totalValue}>+{fmt(gstAmount)}</Text></View>
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>Packing & Handling</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={s.totalValue}>+{fmt(packingHandling)}</Text>
              <TouchableOpacity onPress={() => {
                Alert.prompt ? Alert.prompt('Packing & Handling', 'Enter amount', (v) => setPackingHandling(parseFloat(v) || 0)) :
                  setPackingHandling(prev => prev === 0 ? 150 : 0);
              }}><Ionicons name="pencil" size={14} color="#075E54" /></TouchableOpacity>
            </View>
          </View>
          <View style={[s.totalRow, { borderTopWidth: 1, borderTopColor: '#E0E0E0', paddingTop: 12, marginTop: 8 }]}>
            <Text style={s.grandTotalLabel}>TOTAL</Text><Text style={s.grandTotalValue}>{fmt(total)}</Text>
          </View>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity style={s.pdfBtn} onPress={() => handleSubmit('pdf')} disabled={!!submitting || items.length === 0}>
            {submitting === 'pdf' ? <ActivityIndicator size="small" color="#333" /> : <><Ionicons name="document" size={16} color="#333" /><Text style={s.pdfBtnText}>PDF</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={s.shareBtn} onPress={() => handleSubmit('share')} disabled={!!submitting || items.length === 0}>
            {submitting === 'share' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="share-social" size={16} color="#FFF" /><Text style={s.shareBtnText}>Share Here</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={s.waBtn} onPress={() => handleSubmit('whatsapp')} disabled={!!submitting || items.length === 0}>
            {submitting === 'whatsapp' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="logo-whatsapp" size={16} color="#FFF" /><Text style={s.waBtnText}>WhatsApp</Text></>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  saveDraftBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  saveDraftText: { color: '#A5D6A7', fontSize: 14, fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5, marginTop: 16, marginBottom: 6 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 14, gap: 10 },
  fieldValue: { flex: 1, fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  expandedSection: { backgroundColor: '#FFF', borderLeftWidth: 3, borderLeftColor: '#075E54', borderRadius: 10, padding: 14, marginTop: 4 },
  defaultsLabel: { fontSize: 13, color: '#666', marginBottom: 10 },
  miniLabel: { fontSize: 10, fontWeight: '600', color: '#999', letterSpacing: 0.3, marginTop: 8, marginBottom: 4 },
  miniValue: { fontSize: 14, color: '#333' },
  miniInput: { fontSize: 14, color: '#333', borderBottomWidth: 1, borderBottomColor: '#E0E0E0', paddingVertical: 4 },
  changeLink: { color: '#075E54', fontSize: 13, fontWeight: '600', marginTop: 4 },
  twoCol: { flexDirection: 'row', gap: 16 },
  col: { flex: 1 },
  toggleRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  toggleBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20, backgroundColor: '#F0F0F0' },
  toggleActive: { backgroundColor: '#075E54' },
  toggleText: { fontSize: 13, fontWeight: '600', color: '#666' },
  toggleTextActive: { color: '#FFF' },
  itemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 12, marginBottom: 6, gap: 10 },
  itemName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  itemDetail: { fontSize: 13, color: '#666', marginTop: 2 },
  itemTotal: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  removeBtn: { fontSize: 22, color: '#D32F2F', paddingHorizontal: 8 },
  addItemBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12 },
  addItemText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  selectorPanel: { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#E0E0E0' },
  selectorTitle: { fontSize: 11, fontWeight: '600', color: '#999', marginBottom: 8 },
  productList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  productChip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: '#F0F0F0' },
  productChipActive: { backgroundColor: '#075E54' },
  productChipText: { fontSize: 13, color: '#333' },
  numInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 10, fontSize: 15 },
  aiSuggestLink: { color: '#075E54', fontSize: 13, fontWeight: '600', marginTop: 8 },
  aiSuggestText: { color: '#666', fontSize: 12, fontStyle: 'italic', marginTop: 4 },
  newItemLink: { color: '#075E54', fontSize: 14, fontWeight: '700', marginTop: 10 },
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
});
