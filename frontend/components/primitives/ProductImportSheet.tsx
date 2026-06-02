/**
 * AssistMe — ProductImportSheet.tsx
 * Location: /frontend/components/primitives/ProductImportSheet.tsx
 * Created: Session H, Jun 2026
 *
 * PURPOSE: AI-native product catalog import — bottom sheet UI.
 *   Step 1: Source picker (Camera / Gallery / PDF)
 *   Step 2: Upload + extraction (progress indicator)
 *   Step 3: Review sheet — per-row inline edit, confidence badge, skip toggle
 *   Step 4: Confirm → POST /api/products/import/confirm
 *
 * ARCHITECTURE: UI only. All API calls go through /api/products/import/extract and /confirm.
 * CONSUMERS: products.tsx Import button
 */

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  TextInput, ScrollView, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet from './BottomSheet';
import { authService } from '../../lib/auth';

interface ExtractedProduct {
  name: string;
  sku?: string | null;
  category?: string | null;
  unit?: string | null;
  selling_price?: number | null;
  cost_price?: number | null;
  tax_rate?: number | null;
  brand?: string | null;
  hsn_code?: string | null;
  description?: string | null;
  resolution_status: 'new' | 'existing' | 'fuzzy';
  confidence: number;
  matched_product?: { id: string; name: string } | null;
}

interface ReviewItem extends ExtractedProduct {
  _action: 'create' | 'update' | 'skip';
  _original_name: string;
  _edited_name: string;
  _edited_selling_price: string;
  _edited_cost_price: string;
  _edited_category: string;
  _edited_gst: string;
  _extracted_price: string;
  _price_locked: boolean;
}

interface ProductImportSheetProps {
  visible: boolean;
  onDismiss: () => void;
  onComplete: (counts: { created: number; updated: number; skipped: number }) => void;
  existingCategories?: string[];
}

type Step = 'pick' | 'extracting' | 'review' | 'confirming';

export default function ProductImportSheet({ visible, onDismiss, onComplete, existingCategories = [] }: ProductImportSheetProps) {
  const [step, setStep] = useState<Step>('pick');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [telemetry, setTelemetry] = useState<{ total_extracted: number; total_new: number; total_resolved: number; total_fuzzy: number; model_used: string } | null>(null);
  const [activeCatIdx, setActiveCatIdx] = useState<number | null>(null);
  const [extractedPriceType, setExtractedPriceType] = useState<'selling' | 'cost'>('selling');

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { Alert.alert('Session expired', 'Please log in again.'); return null; }
    return token;
  };

  const reset = () => { setStep('pick'); setItems([]); setTelemetry(null); };
  const handleDismiss = () => { reset(); onDismiss(); };

  const uploadFile = async (uri: string, mimeType: string, name: string) => {
    const token = await getToken();
    if (!token) return null;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const formData = new FormData();
    formData.append('file', { uri, name, type: mimeType } as any);
    const res = await fetch(`${backendUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { url: data.url, mime_type: mimeType, name };
  };

  const runExtraction = async (uploadedFiles: { url: string; mime_type: string; name: string }[]) => {
    setStep('extracting');
    try {
      const token = await getToken();
      if (!token) { setStep('pick'); return; }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/products/import/extract`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: uploadedFiles }),
      });
      if (!res.ok) { Alert.alert('Error', 'Extraction failed. Please try again.'); setStep('pick'); return; }
      const data = await res.json();

      if (data.used_fallback) {
        Alert.alert('Note', 'One or more files could not be processed natively. Partial results may be shown.');
      }

      setTelemetry({ total_extracted: data.total_extracted, total_new: data.total_new, total_resolved: data.total_resolved, total_fuzzy: data.total_fuzzy, model_used: data.model_used });

      if (!data.products?.length) {
        Alert.alert('No products found', 'Could not extract any products from the selected files.');
        setStep('pick'); return;
      }

      setItems(data.products.map((p: ExtractedProduct) => ({
        ...p,
        _action: p.resolution_status === 'existing' ? 'update' : 'create',
        _original_name: p.name,
        _edited_name: p.name,
        _extracted_price: p.selling_price != null ? String(p.selling_price) : (p.cost_price != null ? String(p.cost_price) : ''),
        _edited_selling_price: p.selling_price != null ? String(p.selling_price) : '',
        _edited_cost_price: '',
        _edited_category: p.category || '',
        _edited_gst: p.tax_rate != null ? String(p.tax_rate) : '',
        _price_locked: false,
      })));
      setStep('review');
    } catch { Alert.alert('Error', 'Something went wrong during extraction.'); setStep('pick'); }
  };

  const pickFromGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Please allow access to your photo library.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images' as ImagePicker.MediaType, allowsMultipleSelection: true, quality: 0.8 });
    if (result.canceled || !result.assets?.length) return;
    setStep('extracting');
    const uploaded = [];
    for (const asset of result.assets) {
      const ext = (asset.uri.split('.').pop() || 'jpg').toLowerCase();
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      const f = await uploadFile(asset.uri, mime, asset.fileName || `photo.${ext}`);
      if (f) uploaded.push(f);
    }
    if (!uploaded.length) { Alert.alert('Upload failed', 'Could not upload images.'); setStep('pick'); return; }
    await runExtraction(uploaded);
  };

  const pickFromCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Please allow camera access.'); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (result.canceled || !result.assets?.[0]) return;
    setStep('extracting');
    const asset = result.assets[0];
    const ext = (asset.uri.split('.').pop() || 'jpg').toLowerCase();
    const f = await uploadFile(asset.uri, ext === 'png' ? 'image/png' : 'image/jpeg', `photo.${ext}`);
    if (!f) { Alert.alert('Upload failed', 'Could not upload image.'); setStep('pick'); return; }
    await runExtraction([f]);
  };

  const pickPDF = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    setStep('extracting');
    const asset = result.assets[0];
    const f = await uploadFile(asset.uri, 'application/pdf', asset.name || 'catalog.pdf');
    if (!f) { Alert.alert('Upload failed', 'Could not upload PDF.'); setStep('pick'); return; }
    await runExtraction([f]);
  };

  const togglePriceType = (newType: 'selling' | 'cost') => {
    setExtractedPriceType(newType);
    setItems(prev => prev.map(item => {
      if (item._price_locked) return item;
      const ep = item._extracted_price;
      if (!ep) return item;
      return {
        ...item,
        _edited_selling_price: newType === 'selling' ? ep : (item._edited_selling_price !== ep ? item._edited_selling_price : ''),
        _edited_cost_price: newType === 'cost' ? ep : (item._edited_cost_price !== ep ? item._edited_cost_price : ''),
      };
    }));
  };

  const confirmImport = async () => {
    if (!items.filter(i => i._action !== 'skip').length) { Alert.alert('Nothing to import', 'All items are skipped.'); return; }
    setStep('confirming');
    try {
      const token = await getToken();
      if (!token) { setStep('review'); return; }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/products/import/confirm`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map(i => ({
          action: i._action,
          matched_id: i._action === 'update' ? i.matched_product?.id : undefined,
          original_name: i._original_name !== i._edited_name ? i._original_name : undefined,
          product_data: { name: i._edited_name, sku: i.sku || null, category: i._edited_category || null, unit: i.unit || null, selling_price: i._edited_selling_price ? Number(i._edited_selling_price) : null, cost_price: i._edited_cost_price ? Number(i._edited_cost_price) : null, tax_rate: i._edited_gst ? Number(i._edited_gst) : (i.tax_rate || null), brand: i.brand || null, hsn_code: i.hsn_code || null, description: i.description || null },
        })) }),
      });
      if (!res.ok) { Alert.alert('Error', 'Import failed. Please try again.'); setStep('review'); return; }
      const data = await res.json();
      reset();
      onComplete({ created: data.created, updated: data.updated, skipped: data.skipped });
    } catch { Alert.alert('Error', 'Something went wrong.'); setStep('review'); }
  };

  const confColor = (c: number) => c >= 0.95 ? '#2E7D32' : c >= 0.75 ? '#F57C00' : '#C62828';
  const statusColor = (s: string) => s === 'new' ? '#2E7D32' : s === 'fuzzy' ? '#F57C00' : '#1565C0';
  const statusLabel = (s: string) => s === 'new' ? 'Add to Catalog' : s === 'existing' ? 'Already Exists' : 'Similar Found';

  return (
    <BottomSheet visible={visible} onDismiss={handleDismiss} maxHeight={640}>
      <View style={s.header}>
        <Text style={s.title}>
          {step === 'pick' && 'Import Products'}
          {step === 'extracting' && 'Extracting...'}
          {step === 'review' && `Review ${items.length} Products`}
          {step === 'confirming' && 'Importing...'}
        </Text>
        {step === 'pick' && <TouchableOpacity onPress={handleDismiss} style={{ padding: 4 }}><Ionicons name="close" size={22} color="#333" /></TouchableOpacity>}
        {step === 'review' && <TouchableOpacity onPress={reset} style={{ padding: 4 }}><Ionicons name="arrow-back" size={22} color="#333" /></TouchableOpacity>}
      </View>

      {step === 'pick' && (
        <View style={s.pickContainer}>
          <Text style={s.pickSub}>AI will extract products from your source</Text>
          {[
            { icon: 'camera-outline', title: 'Camera', sub: 'Capture a price list or catalog page', fn: pickFromCamera },
            { icon: 'images-outline', title: 'Gallery', sub: 'Select one or more photos', fn: pickFromGallery },
            { icon: 'document-text-outline', title: 'PDF Catalog', sub: 'Import from supplier PDF or brochure', fn: pickPDF },
          ].map(btn => (
            <TouchableOpacity key={btn.title} style={s.sourceBtn} onPress={btn.fn}>
              <Ionicons name={btn.icon as any} size={24} color="#075E54" />
              <View style={{ flex: 1 }}>
                <Text style={s.sourceBtnTitle}>{btn.title}</Text>
                <Text style={s.sourceBtnSub}>{btn.sub}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#CCC" />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {(step === 'extracting' || step === 'confirming') && (
        <View style={s.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
          <Text style={s.loadingText}>{step === 'extracting' ? 'AI is reading your catalog...' : 'Saving products...'}</Text>
          {step === 'extracting' && <Text style={s.loadingSub}>This may take a few seconds</Text>}
        </View>
      )}

      {step === 'review' && (
        <>
          {telemetry && (
            <View style={s.telemetryRow}>
              <Text style={s.telemetryText}>✦ {telemetry.total_extracted} products found · {telemetry.total_new} to add · {telemetry.total_resolved} already in catalog · {telemetry.total_fuzzy} similar</Text>
            </View>
          )}
          {(() => {
            const unedited = items.filter(i => !i._price_locked).length;
            return (
              <View style={s.globalPriceRow}>
                <View>
                  <Text style={s.globalPriceLabel}>Imported prices represent:</Text>
                  {unedited < items.length && <Text style={s.globalPriceSub}>{unedited} unedited · {items.length - unedited} prices locked</Text>}
                </View>
                <TouchableOpacity style={s.globalPriceBtn} onPress={() => togglePriceType(extractedPriceType === 'selling' ? 'cost' : 'selling')}>
                  <Text style={s.globalPriceBtnText}>{extractedPriceType === 'selling' ? 'Sale Price ↕' : 'Cost Price ↕'}</Text>
                </TouchableOpacity>
              </View>
            );
          })()}

          <ScrollView style={{ maxHeight: 390 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {items.map((item, idx) => (
              <View key={idx} style={[s.reviewRow, item._action === 'skip' && s.reviewRowSkipped]}>
                <View style={s.reviewTop}>
                  <View style={[s.badge, { backgroundColor: statusColor(item.resolution_status) + '22' }]}>
                    <Text style={[s.badgeText, { color: statusColor(item.resolution_status) }]}>{statusLabel(item.resolution_status)}</Text>
                  </View>
                  <View style={[s.badge, { backgroundColor: confColor(item.confidence) + '22' }]}>
                    <Text style={[s.badgeText, { color: confColor(item.confidence) }]}>{Math.round(item.confidence * 100)}%</Text>
                  </View>
                  <TouchableOpacity style={s.skipBtn} onPress={() => {
                    const u = [...items];
                    u[idx]._action = u[idx]._action === 'skip' ? (item.resolution_status === 'existing' ? 'update' : 'create') : 'skip';
                    setItems(u);
                  }}>
                    <Text style={[s.skipText, item._action === 'skip' && { color: '#075E54' }]}>{item._action === 'skip' ? 'Restore' : 'Skip'}</Text>
                  </TouchableOpacity>
                </View>
                <TextInput style={[s.reviewName, item._action === 'skip' && s.strikethrough]} value={item._edited_name} onChangeText={v => { const u = [...items]; u[idx]._edited_name = v; setItems(u); }} editable={item._action !== 'skip'} />
                <View style={s.reviewMeta}>
                  <View style={s.priceField}>
                    <Text style={s.priceFieldLabel}>SALE</Text>
                    <TextInput style={[s.reviewPrice, extractedPriceType === 'cost' && !item._edited_selling_price && s.reviewPriceDim]} value={item._edited_selling_price} onChangeText={v => { const u = [...items]; u[idx]._edited_selling_price = v; u[idx]._price_locked = true; setItems(u); }} keyboardType="numeric" placeholder="—" editable={item._action !== 'skip'} />
                  </View>
                  <View style={s.priceField}>
                    <Text style={s.priceFieldLabel}>COST</Text>
                    <TextInput style={[s.reviewPrice, extractedPriceType === 'selling' && !item._edited_cost_price && s.reviewPriceDim]} value={item._edited_cost_price} onChangeText={v => { const u = [...items]; u[idx]._edited_cost_price = v; u[idx]._price_locked = true; setItems(u); }} keyboardType="numeric" placeholder="—" editable={item._action !== 'skip'} />
                  </View>
                  <View style={s.priceField}>
                    <Text style={s.priceFieldLabel}>GST%</Text>
                    <TextInput style={s.reviewGst} value={item._edited_gst} onChangeText={v => { const u = [...items]; u[idx]._edited_gst = v; setItems(u); }} keyboardType="numeric" placeholder="—" editable={item._action !== 'skip'} />
                  </View>
                </View>
                <View>
                  <TextInput
                    style={s.reviewCat}
                    value={item._edited_category}
                    onChangeText={v => { const u = [...items]; u[idx]._edited_category = v; setItems(u); setActiveCatIdx(idx); }}
                    onFocus={() => setActiveCatIdx(idx)}
                    onBlur={() => setTimeout(() => setActiveCatIdx(null), 150)}
                    placeholder="Category"
                    editable={item._action !== 'skip'}
                  />
                  {activeCatIdx === idx && existingCategories.filter(c => c.toLowerCase().includes((item._edited_category || '').toLowerCase()) && c !== item._edited_category && (item._edited_category || '').length > 0).length > 0 && (
                    <View style={s.catDropdown}>
                      {existingCategories.filter(c => c.toLowerCase().includes((item._edited_category || '').toLowerCase()) && c !== item._edited_category).slice(0, 4).map(c => (
                        <TouchableOpacity key={c} style={s.catDropdownItem} onPress={() => { const u = [...items]; u[idx]._edited_category = c; setItems(u); setActiveCatIdx(null); }}>
                          <Text style={s.catDropdownText}>{c}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
                {(item.sku || item.brand || item.hsn_code) && (
                  <Text style={s.reviewExtra}>
                    {[item.sku && `SKU: ${item.sku}`, item.brand && `Brand: ${item.brand}`, item.hsn_code && `HSN: ${item.hsn_code}`].filter(Boolean).join(' · ')}
                  </Text>
                )}
                {item.resolution_status === 'existing' && item.matched_product && (
                  <Text style={s.reviewMatch}>↳ Will update: {item.matched_product.name}</Text>
                )}
                {item.resolution_status === 'fuzzy' && item.matched_product && (
                  <TouchableOpacity style={s.fuzzyChip} onPress={() => {
                    const u = [...items];
                    u[idx]._original_name = u[idx]._edited_name;
                    u[idx]._edited_name = item.matched_product!.name;
                    u[idx]._action = 'update';
                    setItems(u);
                  }}>
                    <Ionicons name="swap-horizontal" size={12} color="#F57C00" />
                    <Text style={s.fuzzyChipText}>Use instead: {item.matched_product.name}</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </ScrollView>
          <View style={s.confirmBar}>
            <Text style={s.confirmCount}>{items.filter(i => i._action !== 'skip').length} of {items.length} selected</Text>
            <TouchableOpacity style={s.confirmBtn} onPress={confirmImport}>
              <Ionicons name="checkmark-circle" size={18} color="#FFF" />
              <Text style={s.confirmBtnText}>Import All</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F0F0F0', marginBottom: 8 },
  title: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  pickContainer: { paddingVertical: 8, gap: 10 },
  pickSub: { fontSize: 13, color: '#999', marginBottom: 4 },
  sourceBtn: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 12, backgroundColor: '#F8F8F8', borderWidth: 1, borderColor: '#EFEFEF' },
  sourceBtnTitle: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  sourceBtnSub: { fontSize: 12, color: '#999', marginTop: 2 },
  loadingContainer: { alignItems: 'center', paddingVertical: 50, gap: 16 },
  loadingText: { fontSize: 15, fontWeight: '600', color: '#1A1A1A' },
  loadingSub: { fontSize: 13, color: '#999' },
  telemetryRow: { backgroundColor: '#E8F5E9', borderRadius: 8, padding: 8, marginBottom: 8 },
  telemetryText: { fontSize: 11, color: '#2E7D32', fontWeight: '500' },
  reviewRow: { borderBottomWidth: 1, borderBottomColor: '#F5F5F5', paddingVertical: 10, gap: 6 },
  reviewRowSkipped: { opacity: 0.4 },
  reviewTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  skipBtn: { marginLeft: 'auto' as any, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: '#F0F0F0' },
  skipText: { fontSize: 12, fontWeight: '600', color: '#666' },
  reviewName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A', borderBottomWidth: 1, borderBottomColor: '#EFEFEF', paddingVertical: 2 },
  strikethrough: { textDecorationLine: 'line-through', color: '#999' },
  reviewMeta: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  reviewPrice: { fontSize: 13, fontWeight: '600', color: '#075E54', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, minWidth: 70 },
  reviewCat: { fontSize: 12, color: '#666', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, flex: 1 },
  reviewExtra: { fontSize: 11, color: '#999', fontStyle: 'italic' },
  reviewMatch: { fontSize: 11, color: '#1565C0' },
  reviewFuzzy: { fontSize: 11, color: '#F57C00' },
  confirmBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F0F0F0', marginTop: 4 },
  confirmCount: { fontSize: 13, color: '#666' },
  confirmBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#075E54', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  confirmBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
  reviewGst: { fontSize: 12, color: '#333', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, width: 55 },
  catDropdown: { position: 'absolute' as any, top: 36, left: 0, right: 0, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, zIndex: 999, elevation: 10 },
  catDropdownItem: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  catDropdownText: { fontSize: 13, color: '#333' },
  fuzzyChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: '#FFF3E0', borderWidth: 1, borderColor: '#F57C00', alignSelf: 'flex-start' as any },
  fuzzyChipText: { fontSize: 11, color: '#F57C00', fontWeight: '600' },
  globalPriceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4, marginBottom: 6, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  globalPriceLabel: { fontSize: 12, color: '#444', fontWeight: '600' },
  globalPriceSub: { fontSize: 10, color: '#999', marginTop: 2 },
  globalPriceBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#075E54' },
  globalPriceBtnText: { fontSize: 12, fontWeight: '700', color: '#FFF' },
  priceField: { alignItems: 'center', gap: 2 },
  priceFieldLabel: { fontSize: 9, color: '#999', fontWeight: '700', letterSpacing: 0.5 },
  reviewPriceDim: { opacity: 0.3 },
});
