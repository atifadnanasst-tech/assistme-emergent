/**
 * AssistMe - Purchase Bill Screen
 * Location: /frontend/app/customer/[id]/purchase-bill.tsx
 * Created: Aug 2026 (Purchase Bill / Supplier Payment subtask 2)
 *
 * Deliberately a LEANER mirror of invoice.tsx, not a full copy -- built
 * after a field-by-field discussion with Atif on what genuinely applies
 * to goods coming IN versus going out. Excluded on purpose: billing/
 * shipping address (we don't tell a supplier where WE are), transport/
 * e-way/Challan generation (that's documentation for OUR outgoing
 * transport, not goods we're receiving), invoice type selector, PO
 * number (no Purchase Order feature exists beyond a stub), and
 * "collect payment now" (Record Payment Made is its own separate
 * screen, matching how Record Payment Received already stays separate
 * from Create Invoice).
 *
 * Calls the new POST /api/purchase-bills endpoint, a thin wrapper
 * around the existing, already-proven recordPurchaseBill() service
 * (same one Spark's create_purchase_bill case already uses) -- zero new
 * business logic, inventory/cost-price/entity_memory updates all
 * already handled server-side exactly as they are for Spark.
 *
 * Reuses the existing GET /api/invoice/new endpoint for loading
 * customer + products data -- identical data shape needed, no new GET
 * endpoint required.
 *
 * Image capture (Atif's own recollection, confirmed accurate): calls
 * the new POST /api/purchase-bills/extract-from-image endpoint, which
 * reuses the same proven GPT-4o vision pattern Spark's chat attachment
 * path already uses, just asking for structured JSON directly since
 * this is a manual form with no further LLM re-parse step.
 *
 * FUTURE-READY, NOT WIRED (per Atif's explicit instruction): inline
 * "create new product" for an unrecognized item is intentionally left
 * out of this build -- confirmed via code investigation that this
 * doesn't exist for ANY document type yet (not invoices, not quotes).
 * See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md. When built, it should call
 * the existing createProduct() primitive (already used by the Products
 * tab) to get a real product_id, then pass that into this screen's
 * existing item-handling exactly as today -- no restructuring needed
 * here to support it later.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { authService } from '../../../lib/auth';

interface Product { id: string; name: string; sku: string; selling_price: number; tax_rate: number; unit: string; hsn_code: string | null; }
interface LineItem { product_id: string; product_name: string; quantity: number; unit_price: number; tax_rate: number; discount_pct: number; line_total: number; }

export default function NewPurchaseBillScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(id || '');
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);

  const [supplierBillNumber, setSupplierBillNumber] = useState('');
  const [notes, setNotes] = useState('');

  const [addingItem, setAddingItem] = useState(false);
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const quantityInputRef = useRef<TextInput>(null);
  const [newQty, setNewQty] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newDiscount, setNewDiscount] = useState('');

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut({ scope: 'local' }); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  const loadForm = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      // Reuses the existing invoice/new endpoint -- same customer +
      // products data shape a purchase bill also needs, no new GET
      // endpoint required.
      const res = await fetch(`${backendUrl}/api/invoice/new?customer_id=${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut({ scope: 'local' }); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setCustomerName(data.customer?.name || '');
      setCustomerId(data.customer?.id || id || '');
      setProducts(data.products || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { loadForm(); }, []);

  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const taxAmount = items.reduce((s, i) => s + (i.line_total * i.tax_rate / 100), 0);
  const total = subtotal + taxAmount;

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(productSearchQuery.toLowerCase())
  );

  const handleSelectProduct = (productId: string) => {
    setSelectedProductId(productId);
    const product = products.find(p => p.id === productId);
    // Cost price, not selling price, is the right default here -- this
    // is what WE pay the supplier, not what we'd charge a customer.
    // products.selling_price is the only price field GET /api/invoice/new
    // currently returns; the owner can still type the real cost freely.
    if (product) setNewPrice('');
    setProductSearchQuery('');
    setTimeout(() => quantityInputRef.current?.focus(), 100);
  };

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
    const newLine: LineItem = {
      product_id: product.id, product_name: product.name,
      quantity: qty, unit_price: price, tax_rate: product.tax_rate, discount_pct: discount, line_total: lineTotal,
    };
    if (editingItemIndex !== null) {
      setItems(prev => prev.map((it, idx) => idx === editingItemIndex ? newLine : it));
      setEditingItemIndex(null);
      setAddingItem(false);
    } else {
      setItems(prev => [...prev, newLine]);
    }
    setSelectedProductId(''); setNewQty(''); setNewPrice(''); setNewDiscount('');
  };

  const handleRemoveItem = (index: number) => { setItems(prev => prev.filter((_, i) => i !== index)); };

  const handleEditItem = (index: number) => {
    const item = items[index];
    setSelectedProductId(item.product_id);
    setNewQty(String(item.quantity));
    setNewPrice(String(item.unit_price));
    setNewDiscount(item.discount_pct ? String(item.discount_pct) : '');
    setEditingItemIndex(index);
    setAddingItem(true);
  };

  // Image capture (Aug 2026) -- reuses the app's own already-proven
  // ImagePicker pattern (same usage as ai.tsx's gallery/camera attach),
  // requesting base64 directly so this screen can send it straight to
  // the new extraction endpoint without a separate upload step.
  const handleCaptureFromImage = async (source: 'camera' | 'gallery') => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', source === 'camera' ? 'Please allow camera access.' : 'Please allow access to your photo library.');
        return;
      }
      const launchFn = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
      const result = await launchFn({ mediaTypes: 'images' as any, quality: 0.7, base64: true });
      if (result.canceled || !result.assets?.[0]?.base64) return;

      const asset = result.assets[0];
      const ext = (asset.uri.split('.').pop() || 'jpg').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';

      setExtracting(true);
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/purchase-bills/extract-from-image`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: asset.base64, mime_type: mime }),
      });

      if (!res.ok) {
        Alert.alert('Could Not Read Image', 'Try a clearer photo, or enter the details manually.');
        return;
      }
      const extracted = await res.json();

      if (extracted.supplier_bill_number) setSupplierBillNumber(extracted.supplier_bill_number);
      if (extracted.notes) setNotes(extracted.notes);

      const matchedItems: LineItem[] = (extracted.items || []).map((ei: any) => {
        const match = products.find(p => p.name.toLowerCase().includes((ei.product_name || '').toLowerCase()) || (ei.product_name || '').toLowerCase().includes(p.name.toLowerCase()));
        const qty = Number(ei.quantity) || 1;
        const price = Number(ei.unit_price) || 0;
        return {
          product_id: match?.id || '',
          product_name: match?.name || ei.product_name || 'Unrecognized item',
          quantity: qty, unit_price: price, tax_rate: match?.tax_rate || 0, discount_pct: 0,
          line_total: qty * price,
        };
      }).filter((li: LineItem) => li.product_id);

      const unmatchedCount = (extracted.items || []).length - matchedItems.length;
      if (matchedItems.length > 0) setItems(prev => [...prev, ...matchedItems]);

      if (unmatchedCount > 0) {
        Alert.alert(
          'Some Items Not Added',
          `${matchedItems.length} item(s) added. ${unmatchedCount} item(s) didn't match a product in your catalog and were skipped -- add those manually below.`
        );
      } else if (matchedItems.length === 0) {
        Alert.alert('No Items Found', 'Could not confidently read any items from this image. Please add them manually.');
      }
    } catch (err) {
      console.error('[handleCaptureFromImage]', err);
      Alert.alert('Error', 'Could not process this image. Please try again or enter details manually.');
    } finally {
      setExtracting(false);
    }
  };

  const handleSubmit = async () => {
    if (items.length === 0) { Alert.alert('Error', 'Add at least one item'); return; }
    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/purchase-bills`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, tax_rate: i.tax_rate })),
          supplier_bill_number: supplierBillNumber || null,
          notes: notes || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Error', err.error === 'no_items' ? 'Add at least one item' : 'Failed to record purchase bill');
        return;
      }
      const created = await res.json();
      Alert.alert('Purchase Bill Recorded', `${created.bill_number} — ₹${(created.total_amount || 0).toLocaleString('en-IN')}`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (err) {
      console.error('[handleSubmit] purchase bill', err);
      Alert.alert('Error', 'Failed to record purchase bill');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>New Purchase Bill</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scrollContent}>
          <Text style={s.sectionLabel}>SUPPLIER</Text>
          <View style={s.card}>
            <Text style={s.supplierName}>{customerName || 'Unknown supplier'}</Text>
          </View>

          <View style={s.captureRow}>
            <TouchableOpacity style={s.captureBtn} onPress={() => handleCaptureFromImage('camera')} disabled={extracting}>
              <Ionicons name="camera-outline" size={20} color="#075E54" />
              <Text style={s.captureBtnText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.captureBtn} onPress={() => handleCaptureFromImage('gallery')} disabled={extracting}>
              <Ionicons name="image-outline" size={20} color="#075E54" />
              <Text style={s.captureBtnText}>From Gallery</Text>
            </TouchableOpacity>
          </View>
          {extracting && (
            <View style={s.extractingRow}>
              <ActivityIndicator size="small" color="#075E54" />
              <Text style={s.extractingText}>Reading bill...</Text>
            </View>
          )}

          <Text style={s.sectionLabel}>SUPPLIER BILL NUMBER</Text>
          <TextInput
            style={s.input}
            value={supplierBillNumber}
            onChangeText={setSupplierBillNumber}
            placeholder="As printed on their bill (optional)"
            placeholderTextColor="#AAA"
          />

          <Text style={s.sectionLabel}>ITEMS</Text>
          {items.map((item, index) => (
            <View key={index} style={s.itemRow}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => handleEditItem(index)}>
                <Text style={s.itemName}>{item.product_name}</Text>
                <Text style={s.itemMeta}>{item.quantity} × ₹{item.unit_price.toFixed(2)}{item.discount_pct ? ` (−${item.discount_pct}%)` : ''}</Text>
              </TouchableOpacity>
              <Text style={s.itemTotal}>₹{item.line_total.toFixed(2)}</Text>
              <TouchableOpacity onPress={() => handleRemoveItem(index)} style={s.itemRemoveBtn}>
                <Ionicons name="close-circle" size={20} color="#D32F2F" />
              </TouchableOpacity>
            </View>
          ))}

          {!addingItem ? (
            <TouchableOpacity style={s.addItemBtn} onPress={() => setAddingItem(true)}>
              <Ionicons name="add-circle-outline" size={20} color="#075E54" />
              <Text style={s.addItemText}>Add Item</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.addItemCard}>
              <TouchableOpacity style={s.productPickerBtn} onPress={() => setProductSearchQuery(productSearchQuery ? '' : ' ')}>
                <Text style={s.productPickerText}>
                  {selectedProductId ? products.find(p => p.id === selectedProductId)?.name : 'Select a product'}
                </Text>
                <Ionicons name="chevron-down" size={18} color="#666" />
              </TouchableOpacity>
              {productSearchQuery !== '' && (
                <View style={s.productList}>
                  <TextInput
                    style={s.productSearchInput}
                    value={productSearchQuery.trim()}
                    onChangeText={(t) => setProductSearchQuery(t || ' ')}
                    placeholder="Search products..."
                    placeholderTextColor="#AAA"
                    autoFocus
                  />
                  {filteredProducts.slice(0, 8).map(p => (
                    <TouchableOpacity key={p.id} style={s.productOption} onPress={() => handleSelectProduct(p.id)}>
                      <Text style={s.productOptionText}>{p.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={s.qtyPriceRow}>
                <TextInput ref={quantityInputRef} style={[s.input, { flex: 1 }]} value={newQty} onChangeText={setNewQty} placeholder="Qty" keyboardType="numeric" placeholderTextColor="#AAA" />
                <TextInput style={[s.input, { flex: 1 }]} value={newPrice} onChangeText={setNewPrice} placeholder="Unit price paid" keyboardType="numeric" placeholderTextColor="#AAA" />
              </View>
              <TextInput style={s.input} value={newDiscount} onChangeText={setNewDiscount} placeholder="Discount % (optional)" keyboardType="numeric" placeholderTextColor="#AAA" />
              <View style={s.addItemActions}>
                <TouchableOpacity style={s.cancelItemBtn} onPress={() => { setAddingItem(false); setEditingItemIndex(null); setSelectedProductId(''); setNewQty(''); setNewPrice(''); setNewDiscount(''); }}>
                  <Text style={s.cancelItemText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.addToListBtn} onPress={handleAddItem}>
                  <Text style={s.addToListText}>{editingItemIndex !== null ? 'Update' : 'Add to List'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <Text style={s.sectionLabel}>NOTES</Text>
          <TextInput
            style={[s.input, s.notesInput]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            placeholderTextColor="#AAA"
            multiline
          />

          <View style={s.totalsCard}>
            <View style={s.totalsRow}><Text style={s.totalsLabel}>Subtotal</Text><Text style={s.totalsValue}>₹{subtotal.toFixed(2)}</Text></View>
            <View style={s.totalsRow}><Text style={s.totalsLabel}>Tax</Text><Text style={s.totalsValue}>₹{taxAmount.toFixed(2)}</Text></View>
            <View style={[s.totalsRow, s.totalsRowFinal]}><Text style={s.totalsLabelFinal}>Total</Text><Text style={s.totalsValueFinal}>₹{total.toFixed(2)}</Text></View>
          </View>
        </ScrollView>

        <View style={s.footer}>
          <TouchableOpacity style={s.submitBtn} onPress={handleSubmit} disabled={submitting}>
            {submitting ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.submitText}>Record Purchase Bill</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5, marginBottom: 8, marginTop: 16 },
  card: { backgroundColor: '#FFF', borderRadius: 10, padding: 14 },
  supplierName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  captureRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  captureBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderWidth: 1, borderColor: '#075E54', borderRadius: 10, borderStyle: 'dashed' },
  captureBtnText: { fontSize: 13, fontWeight: '700', color: '#075E54' },
  extractingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', marginTop: 10 },
  extractingText: { fontSize: 13, color: '#666' },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1A1A1A' },
  notesInput: { minHeight: 70, textAlignVertical: 'top' },
  itemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 14, marginBottom: 8 },
  itemName: { fontSize: 15, fontWeight: '600', color: '#1A1A1A' },
  itemMeta: { fontSize: 12, color: '#999', marginTop: 2 },
  itemTotal: { fontSize: 14, fontWeight: '700', color: '#1A1A1A', marginRight: 8 },
  itemRemoveBtn: { padding: 4 },
  addItemBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderWidth: 1, borderColor: '#075E54', borderRadius: 10, borderStyle: 'dashed' },
  addItemText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  addItemCard: { backgroundColor: '#FFF', borderRadius: 10, padding: 14, gap: 10 },
  productPickerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
  productPickerText: { fontSize: 15, color: '#1A1A1A' },
  productList: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, overflow: 'hidden' },
  productSearchInput: { paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  productOption: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  productOptionText: { fontSize: 14, color: '#1A1A1A' },
  qtyPriceRow: { flexDirection: 'row', gap: 10 },
  addItemActions: { flexDirection: 'row', gap: 10 },
  cancelItemBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E0E0E0', alignItems: 'center' },
  cancelItemText: { fontSize: 14, fontWeight: '600', color: '#666' },
  addToListBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: '#075E54', alignItems: 'center' },
  addToListText: { fontSize: 14, fontWeight: '700', color: '#FFF' },
  totalsCard: { backgroundColor: '#FFF', borderRadius: 10, padding: 16, marginTop: 20 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  totalsRowFinal: { marginTop: 4, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F0F0F0', marginBottom: 0 },
  totalsLabel: { fontSize: 14, color: '#666' },
  totalsValue: { fontSize: 14, color: '#1A1A1A' },
  totalsLabelFinal: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  totalsValueFinal: { fontSize: 18, fontWeight: '700', color: '#075E54' },
  footer: { padding: 16, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  submitBtn: { backgroundColor: '#075E54', borderRadius: 10, paddingVertical: 16, alignItems: 'center' },
  submitText: { fontSize: 16, fontWeight: '700', color: '#FFF' },
});
