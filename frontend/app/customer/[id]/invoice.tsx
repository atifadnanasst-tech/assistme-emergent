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
import AddressPickerSheet from '../../../components/primitives/AddressPickerSheet';
import TransportPickerSheet from '../../../components/primitives/TransportPickerSheet';

interface Product { id: string; name: string; sku: string; selling_price: number; tax_rate: number; unit: string; hsn_code: string | null; image_url: string | null; }
interface LineItem { product_id: string; product_name: string; hsn_code: string | null; quantity: number; unit_price: number; tax_rate: number; discount_pct: number; line_total: number; }
interface Customer { id: string; name: string; phone: string; }

const PAYMENT_TERMS_OPTIONS = ['Due on Receipt', 'Net 15', 'Net 30', 'Net 45'];
const DELIVERY_PREF_OPTIONS = ['Standard Delivery', 'Express Delivery', 'Customer Pickup'];

export default function NewInvoiceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; items?: string; amount?: string; due_date?: string; draft_id?: string; action_id?: string }>();
  const id = params.id;
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [createdInvoice, setCreatedInvoice] = useState<{ id: string; number: string } | null>(null);
  const [orgName, setOrgName] = useState('');
  const [orgGstinState, setOrgGstinState] = useState('');
  const [businessModalVisible, setBusinessModalVisible] = useState(false);
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(id || '');
  const [customerExpanded, setCustomerExpanded] = useState(false);
  const [customerSearchVisible, setCustomerSearchVisible] = useState(false);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [packingModalVisible, setPackingModalVisible] = useState(false);
  const [packingInput, setPackingInput] = useState('');
  const [customerDefaults, setCustomerDefaults] = useState<any>({});
  const [billingAddress, setBillingAddress] = useState<any>(null);
  const [shippingAddress, setShippingAddress] = useState<any>(null);
  const [addressPickerVisible, setAddressPickerVisible] = useState(false);
  const [shippingAddresses, setShippingAddresses] = useState<any[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);
  const [addressSaving, setAddressSaving] = useState(false);
  const [taxId, setTaxId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryPref, setDeliveryPref] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [generateChallan, setGenerateChallan] = useState(false);
  const [categoryOptions, setCategoryOptions] = useState<{ id: string; name: string }[]>([]);
  const [transportName, setTransportName] = useState('');
  const [bundleCount, setBundleCount] = useState('');
  const [goodsDescription, setGoodsDescription] = useState('');
  const [transportPickerVisible, setTransportPickerVisible] = useState(false);
  const [transportOptions, setTransportOptions] = useState<any[]>([]);
  const [transportLoading, setTransportLoading] = useState(false);
  const [transportSaving, setTransportSaving] = useState(false);
  const [invoiceType, setInvoiceType] = useState('Tax Invoice');
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [packingHandling, setPackingHandling] = useState(0);
  const [addingItem, setAddingItem] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const quantityInputRef = useRef<TextInput>(null);
  const [newQty, setNewQty] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newDiscount, setNewDiscount] = useState('');
  const [newHsn, setNewHsn] = useState('');

  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => { loadForm(); }, [id]);

  // Delivery Challan goods-category reuse history (Aug 2026) -- fetch once
  // when the checkbox is first checked, not on every screen load, since
  // most invoices won't need a challan at all.
  useEffect(() => {
    if (!generateChallan || categoryOptions.length > 0) return;
    (async () => {
      try {
        const token2 = await getToken();
        if (!token2) return;
        const backendUrl2 = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl2}/api/organisation/goods-categories`, {
          headers: { 'Authorization': `Bearer ${token2}` },
        });
        if (res.ok) {
          const data = await res.json();
          setCategoryOptions(data.categories || []);
        }
      } catch {}
    })();
  }, [generateChallan]);

  const loadForm = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/invoice/new?customer_id=${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setOrgName(data.organisation?.name || '');
      setOrgGstinState(data.organisation?.gstin_state || '');
      setCustomerName(data.customer?.name || '');
      setCustomerId(data.customer?.id || id || '');
      setAllCustomers(data.all_customers || []);
      setTaxId(data.customer?.tax_id || '');
      setCustomerDefaults(data.customer?.custom_fields || {});
      setPaymentTerms(data.customer?.custom_fields?.payment_terms || '');
      setDeliveryPref(data.customer?.custom_fields?.delivery_preference || '');
      setInvoiceType(data.customer?.custom_fields?.default_invoice_type || 'Tax Invoice');
      setBillingAddress(data.billing_address);
      setShippingAddress(data.shipping_address);
      setProducts(data.products || []);
      if (data.prefilled_items?.length > 0) setItems(data.prefilled_items);

      // Populate from Spark params if passed via URL
      if (params.items) {
        try {
          const sparkItems = JSON.parse(params.items as string);
          if (Array.isArray(sparkItems) && sparkItems.length > 0 && data.products) {
            const lineItems: LineItem[] = sparkItems.map((si: any) => {
              // Match to a product from the loaded products list
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
                line_total: (si.quantity || 1) * (match?.selling_price || si.unit_price || 0),
              };
            });
            setItems(lineItems);
          }
        } catch (e) { console.warn('Failed to parse spark items:', e); }
      }
    } catch {} finally { setLoading(false); }
  };

  // Totals (client-side for UX)
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const gstAmount = items.reduce((s, i) => s + (i.line_total * i.tax_rate / 100), 0);
  const total = subtotal + gstAmount + packingHandling;
  const gstRates = [...new Set(items.map(i => i.tax_rate))];
  const gstLabel = gstRates.length === 0 ? 'GST' : gstRates.length === 1 ? `GST ${gstRates[0]}%` : 'GST (mixed)';
  // CGST/SGST/IGST split -- mirrors calculateInvoiceTotals's exact math
  // (backend/src/index.js) so the preview never drifts from what actually
  // gets saved. Same-state-or-unknown = CGST+SGST (half each); different
  // known states = IGST (full amount). Root-caused Aug 2026 (ATT list #6).
  const isInterstate = !!(orgGstinState && billingAddress?.state &&
    orgGstinState.toLowerCase() !== billingAddress.state.toLowerCase());
  const cgstAmount = isInterstate ? 0 : Math.round(gstAmount / 2 * 100) / 100;
  const sgstAmount = isInterstate ? 0 : Math.round(gstAmount / 2 * 100) / 100;
  const igstAmount = isInterstate ? Math.round(gstAmount * 100) / 100 : 0;
  const gstRateSuffix = gstRates.length === 1 ? ` ${gstRates[0]}%` : '';

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
    setItems(prev => [...prev, {
      product_id: product.id, product_name: product.name, hsn_code: newHsn || product.hsn_code,
      quantity: qty, unit_price: price, tax_rate: product.tax_rate, discount_pct: discount, line_total: lineTotal,
    }]);
    // Stay open (no setAddingItem(false)) -- ready for the next line immediately,
    // matching Atif's "no unnecessary click" spec. Reset fields for a fresh entry.
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

      console.log(`[INVOICE] Action: ${action}`);
      console.log(`[INVOICE] Customer ID: ${customerId}`);
      console.log(`[INVOICE] Items count: ${items.length}`);

      // Real bug fixed Aug 2026: repeated taps of Create/Share/WhatsApp on the
      // SAME screen visit were silently generating a brand new invoice (new
      // number) every time. Now reuses the invoice already created earlier
      // in this same visit instead of creating a duplicate -- invoices are
      // treated as immutable once created (matches real accounting-software
      // practice: Tally/Zoho/QuickBooks/Vyapar all block editing sent
      // invoices; corrections go through a credit/debit note instead, not
      // silently rewriting the original).
      let inv: { invoice_id: string; invoice_number: string };

      if (createdInvoice) {
        console.log('[INVOICE] Reusing already-created invoice:', createdInvoice.id);
        inv = { invoice_id: createdInvoice.id, invoice_number: createdInvoice.number };
      } else {
        // Create invoice
        const r1 = await fetch(`${backendUrl}/api/invoices`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_id: customerId,
            items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, hsn_code: i.hsn_code })),
            packing_handling: packingHandling, invoice_type: invoiceType, po_number: poNumber || null,
            status: action === 'pdf' ? 'draft' : 'sent',
          }),
        });

        if (!r1.ok) {
          const err = await r1.text();
          console.error('[INVOICE] Create failed:', err);
          Alert.alert('Error', 'Failed to create invoice');
          return;
        }

        const created = await r1.json();
        console.log('[INVOICE] Created:', created.invoice_id, created.invoice_number);
        if (!created.invoice_id) { Alert.alert('Error', 'Failed to create invoice'); return; }
        inv = created;
        setCreatedInvoice({ id: created.invoice_id, number: created.invoice_number });

        // "Set as default" (Amazon-style) -- fire-and-forget, non-blocking.
        // Only persists customer-level defaults after the invoice itself
        // was created successfully; a failure here never breaks invoice
        // creation/sending. Added Aug 2026, ATT list #8. Only runs on the
        // FIRST creation, not on reuse.
        if (setAsDefault) {
          fetch(`${backendUrl}/api/customer/${customerId}/defaults`, {
            method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_terms: paymentTerms, delivery_preference: deliveryPref, default_invoice_type: invoiceType }),
          }).catch(() => {});
        }
      }

      // Generate PDF
      console.log('[INVOICE] Generating PDF...');
      // Delivery Challan (Aug 2026, ATT list): optional, generated alongside
      // the invoice in this SAME call when the checkbox is checked -- reuses
      // the same invoice number, no separate creation flow needed.
      const r2 = await fetch(`${backendUrl}/api/invoices/${inv.invoice_id}/pdf`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(generateChallan ? {
          generate_challan: true,
          transport_name: transportName || null,
          bundle_count: bundleCount ? parseInt(bundleCount) : null,
          goods_description: goodsDescription || null,
        } : {}),
      });
      
      if (!r2.ok) {
        const err = await r2.text();
        console.error('[INVOICE] PDF failed:', err);
        Alert.alert('Error', 'PDF generation failed');
        return;
      }
      
      const pdf = await r2.json();
      console.log('[INVOICE] PDF URL:', pdf.pdf_url);

      if (action === 'pdf') {
        // Real tappable buttons instead of an unclickable raw URL block --
        // fixed Aug 2026 after Atif caught the popup being unusable.
        const alertButtons: any[] = [];
        if (pdf.pdf_url) {
          alertButtons.push({ text: 'View Invoice', onPress: () => Linking.openURL(pdf.pdf_url) });
        }
        if (pdf.challan_pdf_url) {
          alertButtons.push({ text: 'View Challan', onPress: () => Linking.openURL(pdf.challan_pdf_url) });
        }
        alertButtons.push({ text: 'OK' });
        Alert.alert('PDF Generated', `Invoice ${inv.invoice_number} saved.`, alertButtons);
      } else if (action === 'share') {
        console.log('[INVOICE] Sharing to app...');
        const r3 = await fetch(`${backendUrl}/api/invoices/${inv.invoice_id}/share`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'app', challan_pdf_url: pdf.challan_pdf_url || null }),
        });
        
        if (!r3.ok) {
          const err = await r3.text();
          console.error('[INVOICE] Share failed:', err);
          Alert.alert('Error', 'Failed to share invoice');
          return;
        }
        
        const shareRes = await r3.json();
        console.log('[INVOICE] Share result:', shareRes);
        Alert.alert('Success', 'Invoice shared in chat ✓');
        router.back();
      } else if (action === 'whatsapp') {
        console.log('[INVOICE] Sharing to WhatsApp...');
        const r3 = await fetch(`${backendUrl}/api/invoices/${inv.invoice_id}/share`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'whatsapp' }),
        });
        // Note: challan_pdf_url deliberately NOT sent for WhatsApp -- that
        // channel goes straight to the customer's number, and the backend's
        // /share endpoint only ever acts on it for channel:'app' anyway.
        
        if (!r3.ok) {
          const err = await r3.text();
          console.error('[INVOICE] WhatsApp share failed:', err);
          Alert.alert('Error', 'Failed to generate WhatsApp link');
          return;
        }
        
        const wa = await r3.json();
        console.log('[INVOICE] WhatsApp URL:', wa.whatsapp_url);
        if (wa.whatsapp_url) {
          try {
            await Linking.openURL(wa.whatsapp_url);
          } catch (linkErr) {
            console.error('[INVOICE] Failed to open WhatsApp:', linkErr);
            Alert.alert('Error', 'Could not open WhatsApp');
          }
        }
        router.back();
      }
    } catch (error) {
      console.error('[INVOICE] Submit error:', error);
      Alert.alert('Error', 'Something went wrong');
    } finally {
      setSubmitting(null);
    }
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
          items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, hsn_code: i.hsn_code })),
          packing_handling: packingHandling, invoice_type: invoiceType, status: 'draft',
        }),
      });
      Alert.alert('Saved', 'Draft saved ✓');
    } catch {} finally { setSubmitting(null); }
  };

  const handleSelectCustomer = (customer: Customer) => {
    setCustomerId(customer.id);
    setCustomerName(customer.name);
    setCustomerSearchVisible(false);
    setCustomerSearchQuery('');
  };

  // Amazon-style shipping address picker (Aug 2026, ATT list #2).
  const openAddressPicker = async () => {
    setAddressPickerVisible(true);
    setAddressesLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/customer/${customerId}/addresses?type=shipping`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setShippingAddresses(data.addresses || []);
      }
    } catch {
    } finally {
      setAddressesLoading(false);
    }
  };

  const handleSelectAddress = (address: any) => {
    setShippingAddress(address);
    setAddressPickerVisible(false);
  };

  const handleAddNewAddress = async (data: any) => {
    setAddressSaving(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/customer/${customerId}/addresses`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'shipping', ...data }),
      });
      if (res.ok) {
        const result = await res.json();
        setShippingAddress(result.address);
        setAddressPickerVisible(false);
      } else {
        Alert.alert('Error', 'Could not save address. Please try again.');
      }
    } catch {
      Alert.alert('Error', 'Could not save address. Please try again.');
    } finally {
      setAddressSaving(false);
    }
  };

  const handleEditPackingHandling = () => {
    setPackingInput(packingHandling.toString());
    setPackingModalVisible(true);
  };

  const handleSavePackingHandling = () => {
    const val = parseFloat(packingInput) || 0;
    setPackingHandling(val);
    setPackingModalVisible(false);
    setPackingInput('');
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

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Business Name - NO MARGIN, clickable */}
        <Text style={[s.sectionLabel, { marginTop: 0 }]}>MY BUSINESS NAME</Text>
        <TouchableOpacity style={s.fieldRow} onPress={() => router.push('/settings/profile')} activeOpacity={0.7}>
          <Text style={s.fieldValue}>{orgName}</Text>
          <Ionicons name="pencil" size={18} color="#075E54" />
        </TouchableOpacity>

        {/* Customer */}
        <Text style={s.sectionLabel}>CUSTOMER</Text>
        <View style={s.fieldRow}>
          <Text style={s.fieldValue}>{customerName}</Text>
          <TouchableOpacity onPress={() => setCustomerSearchVisible(true)} style={{ marginLeft: 'auto' }}>
            <Ionicons name="pencil" size={18} color="#075E54" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setCustomerExpanded(!customerExpanded)} style={{ marginLeft: 8 }}>
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
              <View style={s.col}><Text style={s.miniLabel}>SHIP TO</Text><Text style={s.miniValue}>{shippingAddress ? shippingAddress.line1 : 'Same as billing'}</Text><TouchableOpacity onPress={openAddressPicker}><Text style={s.changeLink}>Change ›</Text></TouchableOpacity></View>
            </View>
            <View style={s.twoCol}>
              <View style={s.col}><Text style={s.miniLabel}>GST</Text><Text style={s.miniValue}>{taxId || '—'}</Text></View>
              <View style={s.col}><Text style={s.miniLabel}>PO NUMBER</Text><TextInput style={s.miniInput} value={poNumber} onChangeText={setPoNumber} placeholder="— (optional)" /></View>
            </View>
            <Text style={s.miniLabel}>PAYMENT TERMS</Text>
            <View style={s.toggleRow}>
              {PAYMENT_TERMS_OPTIONS.map(opt => (
                <TouchableOpacity key={opt} style={[s.toggleBtn, paymentTerms === opt && s.toggleActive]} onPress={() => setPaymentTerms(opt)}>
                  <Text style={[s.toggleText, paymentTerms === opt && s.toggleTextActive]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={s.miniLabel}>DELIVERY PREFERENCE</Text>
            <View style={s.toggleRow}>
              {DELIVERY_PREF_OPTIONS.map(opt => (
                <TouchableOpacity key={opt} style={[s.toggleBtn, deliveryPref === opt && s.toggleActive]} onPress={() => setDeliveryPref(opt)}>
                  <Text style={[s.toggleText, deliveryPref === opt && s.toggleTextActive]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }} onPress={() => setSetAsDefault(!setAsDefault)}>
              <Ionicons name={setAsDefault ? 'checkbox' : 'square-outline'} size={20} color="#075E54" />
              <Text style={{ marginLeft: 8, fontSize: 13, color: '#333' }}>Set as default for {customerName}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Items */}
        <Text style={s.sectionLabel}>ITEMS</Text>
        {items.map((item, i) => (
          <View key={i} style={s.itemRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.itemName}>{item.product_name}</Text>
              <Text style={s.itemDetail}>{item.quantity} × {fmt(item.unit_price)}</Text>
              <Text style={{ fontSize: 11, color: '#999', marginTop: 2 }}>HSN: {item.hsn_code || '—'}  ·  Discount: {item.discount_pct || 0}%</Text>
            </View>
            <Text style={s.itemTotal}>{fmt(item.line_total)}</Text>
            <TouchableOpacity onPress={() => handleRemoveItem(i)}><Text style={s.removeBtn}>×</Text></TouchableOpacity>
          </View>
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
          {isInterstate ? (
            <View style={s.totalRow}><Text style={s.totalLabel}>{`IGST${gstRateSuffix}`}</Text><Text style={s.totalValue}>+{fmt(igstAmount)}</Text></View>
          ) : (
            <>
              <View style={s.totalRow}><Text style={s.totalLabel}>{`CGST${gstRateSuffix ? ` ${gstRates[0]/2}%` : ''}`}</Text><Text style={s.totalValue}>+{fmt(cgstAmount)}</Text></View>
              <View style={s.totalRow}><Text style={s.totalLabel}>{`SGST${gstRateSuffix ? ` ${gstRates[0]/2}%` : ''}`}</Text><Text style={s.totalValue}>+{fmt(sgstAmount)}</Text></View>
            </>
          )}
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>Packing & Handling</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={s.totalValue}>+{fmt(packingHandling)}</Text>
              <TouchableOpacity onPress={handleEditPackingHandling}>
                <Ionicons name="pencil" size={14} color="#075E54" />
              </TouchableOpacity>
            </View>
          </View>
          <View style={[s.totalRow, { borderTopWidth: 1, borderTopColor: '#E0E0E0', paddingTop: 12, marginTop: 8 }]}>
            <Text style={s.grandTotalLabel}>TOTAL</Text><Text style={s.grandTotalValue}>{fmt(total)}</Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center' }} onPress={() => setGenerateChallan(!generateChallan)}>
            <Ionicons name={generateChallan ? 'checkbox' : 'square-outline'} size={20} color="#075E54" />
            <Text style={{ marginLeft: 8, fontSize: 14, color: '#333', fontWeight: '600' }}>Also create Delivery Challan</Text>
          </TouchableOpacity>

          {generateChallan && (
            <View style={{ marginTop: 12 }}>
              <Text style={s.miniLabel}>TRANSPORT</Text>
              <TouchableOpacity
                style={[s.numInput, { justifyContent: 'center' }]}
                onPress={async () => {
                  setTransportPickerVisible(true);
                  setTransportLoading(true);
                  try {
                    const token2 = await getToken();
                    if (!token2) return;
                    const backendUrl2 = process.env.EXPO_PUBLIC_BACKEND_URL;
                    const res = await fetch(`${backendUrl2}/api/customer/${customerId}/addresses?type=transport`, {
                      headers: { 'Authorization': `Bearer ${token2}` },
                    });
                    if (res.ok) {
                      const data = await res.json();
                      setTransportOptions(data.addresses || []);
                    }
                  } catch {} finally {
                    setTransportLoading(false);
                  }
                }}
              >
                <Text style={{ fontSize: 14, color: transportName ? '#1A1A1A' : '#999' }}>
                  {transportName || 'Select transport...'}
                </Text>
              </TouchableOpacity>

              <Text style={[s.miniLabel, { marginTop: 12 }]}>BUNDLES</Text>
              <TextInput style={s.numInput} value={bundleCount} onChangeText={setBundleCount} keyboardType="numeric" placeholder="e.g. 3" />

              <Text style={[s.miniLabel, { marginTop: 12 }]}>GOODS DESCRIPTION <Text style={{ color: '#999', fontWeight: '400' }}>(optional, auto-filled if blank)</Text></Text>
              <TextInput style={s.numInput} value={goodsDescription} onChangeText={setGoodsDescription} placeholder="e.g. Printed Books" />
              {categoryOptions.length > 0 && (
                <View style={[s.productList, { marginTop: 8 }]}>
                  {categoryOptions.map(opt => (
                    <TouchableOpacity key={opt.id} style={s.productChip} onPress={() => setGoodsDescription(opt.name)}>
                      <Text style={s.productChipText}>{opt.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>

        <TransportPickerSheet
          visible={transportPickerVisible}
          options={transportOptions}
          loading={transportLoading}
          saving={transportSaving}
          onSelect={(opt) => { setTransportName(opt.line1); setTransportPickerVisible(false); }}
          onAddNew={async (name) => {
            setTransportSaving(true);
            try {
              const token2 = await getToken();
              if (!token2) return;
              const backendUrl2 = process.env.EXPO_PUBLIC_BACKEND_URL;
              const res = await fetch(`${backendUrl2}/api/customer/${customerId}/addresses`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${token2}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'transport', line1: name }),
              });
              if (res.ok) {
                setTransportName(name);
                setTransportPickerVisible(false);
              } else {
                Alert.alert('Error', 'Could not save transport. Please try again.');
              }
            } catch {
              Alert.alert('Error', 'Could not save transport. Please try again.');
            } finally {
              setTransportSaving(false);
            }
          }}
          onDismiss={() => setTransportPickerVisible(false)}
        />

        <View style={{ height: 100 }} />
        </ScrollView>
      </SafeAreaView>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity style={s.pdfBtn} onPress={() => handleSubmit('pdf')} disabled={!!submitting || items.length === 0}>
            {submitting === 'pdf' ? <ActivityIndicator size="small" color="#333" /> : <><Ionicons name="document" size={16} color="#333" /><Text style={s.pdfBtnText}>Create</Text></>}
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

      <AddressPickerSheet
        visible={addressPickerVisible}
        addresses={shippingAddresses}
        loading={addressesLoading}
        saving={addressSaving}
        onSelect={handleSelectAddress}
        onAddNew={handleAddNewAddress}
        onDismiss={() => setAddressPickerVisible(false)}
      />

      {/* Packing & Handling Edit Modal */}
      <Modal visible={packingModalVisible} animationType="fade" transparent={true} onRequestClose={() => setPackingModalVisible(false)}>
        <View style={s.modalOverlay}>
          <View style={s.packingModal}>
            <Text style={s.packingModalTitle}>Packing & Handling Charges</Text>
            <TextInput
              style={s.packingModalInput}
              placeholder="Enter amount"
              value={packingInput}
              onChangeText={setPackingInput}
              keyboardType="numeric"
              autoFocus
            />
            <View style={s.packingModalButtons}>
              <TouchableOpacity onPress={() => setPackingModalVisible(false)}>
                <Text style={s.packingModalCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.packingModalSaveBtn} onPress={handleSavePackingHandling}>
                <Text style={s.packingModalSave}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
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
  saveDraftBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  saveDraftText: { color: '#A5D6A7', fontSize: 14, fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 16, paddingTop: 8 },
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
  toggleRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
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
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, height: '80%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E0E0E0' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1A1A1A' },
  searchInput: { marginHorizontal: 16, marginTop: 12, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#F5F5F5', borderRadius: 10, fontSize: 15 },
  customerList: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  customerItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  customerItemName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  customerItemPhone: { fontSize: 13, color: '#666', marginTop: 2 },
  packingModal: { backgroundColor: '#FFF', borderRadius: 16, padding: 24, marginHorizontal: 40, minWidth: 280 },
  packingModalTitle: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginBottom: 16 },
  packingModalInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 16 },
  packingModalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  packingModalCancel: { fontSize: 15, color: '#666', paddingVertical: 10, paddingHorizontal: 16 },
  packingModalSaveBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 },
  packingModalSave: { fontSize: 15, fontWeight: '600', color: '#FFF' },
});
