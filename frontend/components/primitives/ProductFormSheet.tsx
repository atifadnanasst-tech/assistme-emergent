/**
 * AssistMe - ProductFormSheet primitive
 * Location: /frontend/components/primitives/ProductFormSheet.tsx
 * Created: Session G, Jun 2026
 *
 * PURPOSE: UI-only product form — collects data, calls onSubmit. No API calls inside.
 *          Caller (products.tsx) owns all business logic and API calls.
 *
 * CURRENT CONSUMERS: products.tsx (Add Product, Edit Product)
 * PLANNED CONSUMERS: Import Products review sheet, Spark Catalog
 *
 * onSubmit receives: { name, category, sellingPrice, taxRate, costPrice }
 * Caller converts sellingPrice/costPrice strings to numbers before calling API.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import BottomSheet from './BottomSheet';

const GST_OPTIONS = [0, 5, 12, 18, 28];

export interface ProductFormData {
  name: string;
  category: string;
  sellingPrice: string;
  taxRate: number;
  costPrice: string;
  hsnCode: string;
  imageUri?: string;
  // Starting stock -- only meaningful on 'add' (a brand-new product
  // always starts at zero; this is simply the first increment if the
  // trader tells us how many they already have on hand). Never shown
  // or sent on 'edit' -- editing a product's details should never
  // silently move stock.
  quantity?: string;
  // Set instead of name/category/etc when the trader tapped a
  // suggested existing product rather than creating a new one --
  // caller should add stock to this product, not create a duplicate.
  matchedProductId?: string;
}

export interface ProductSuggestion {
  id: string;
  name: string;
  sellingPrice?: number;
}

interface ProductFormSheetProps {
  visible: boolean;
  mode: 'add' | 'edit';
  initialValues?: Partial<ProductFormData>;
  categories?: string[];
  onSubmit: (data: ProductFormData) => void;
  onDismiss: () => void;
  loading?: boolean;
  // Duplicate-detection (Sept 2026, basic inventory module). This
  // component makes no API calls itself (see file header) -- the
  // caller debounces onNameChange, calls the existing
  // POST /api/products/resolve, and passes back whatever it finds as
  // suggestions. Reuses the SAME resolveProduct() engine already
  // proven in Spark invoice creation and bulk/AI product import --
  // no new matching logic, just a new call site.
  onNameChange?: (name: string) => void;
  suggestions?: ProductSuggestion[];
  matchedProduct?: ProductSuggestion | null;
  onSelectSuggestion?: (product: ProductSuggestion) => void;
  onClearMatch?: () => void;
}

export default function ProductFormSheet({
  visible, mode, initialValues, categories = [], onSubmit, onDismiss, loading = false,
}: ProductFormSheetProps) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [taxRate, setTaxRate] = useState(0);
  const [costPrice, setCostPrice] = useState('');
  const [hsnCode, setHsnCode] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');

  useEffect(() => {
    if (visible && initialValues) {
      setName(initialValues.name || '');
      setCategory(initialValues.category || '');
      setSellingPrice(initialValues.sellingPrice || '');
      setTaxRate(initialValues.taxRate ?? 0);
      setCostPrice(initialValues.costPrice || '');
      setHsnCode(initialValues.hsnCode || '');
      setImageUri(initialValues.imageUri || null);
    }
    if (!visible) {
      setName(''); setCategory(''); setSellingPrice('');
      setTaxRate(0); setCostPrice(''); setHsnCode(''); setShowSuggestions(false); setImageUri(null);
      setQuantity('');
    }
  }, [visible]);

  const filteredCategories = categories.filter(c =>
    c.toLowerCase().includes(category.toLowerCase()) && c !== category && category.length > 0
  );

  useEffect(() => {
    if (mode !== 'add' || matchedProduct || !onNameChange) return;
    const timer = setTimeout(() => onNameChange(name.trim()), 500);
    return () => clearTimeout(timer);
  }, [name, mode, matchedProduct]);

  const canSubmit = matchedProduct
    ? Number(quantity) > 0
    : name.trim().length > 0 && sellingPrice.length > 0 && Number(sellingPrice) >= 0;

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images' as ImagePicker.MediaType,
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (matchedProduct) {
      onSubmit({
        name: matchedProduct.name, category: '', sellingPrice: '', taxRate: 0, costPrice: '',
        hsnCode: '', quantity, matchedProductId: matchedProduct.id,
      });
      return;
    }
    onSubmit({
      name: name.trim(), category: category.trim(), sellingPrice, taxRate, costPrice,
      hsnCode: hsnCode.trim(), imageUri: imageUri || undefined,
      quantity: mode === 'add' ? quantity : undefined,
    });
  };

  return (
    <BottomSheet visible={visible} onDismiss={onDismiss}>
      <Text style={styles.heading}>{matchedProduct ? 'Add Stock' : (mode === 'add' ? 'Add Product' : 'Edit Product')}</Text>

      {matchedProduct ? (
        <>
          <View style={styles.matchBanner}>
            <Text style={styles.matchBannerText}>Adding stock to existing product:</Text>
            <Text style={styles.matchBannerName}>{matchedProduct.name}</Text>
            <TouchableOpacity onPress={onClearMatch}>
              <Text style={styles.matchBannerClear}>Not this one? Create a new product instead</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.label}>How many are you adding? *</Text>
          <TextInput
            style={styles.input} placeholder="0" placeholderTextColor="#999"
            keyboardType="numeric" value={quantity} onChangeText={setQuantity} autoFocus
          />
        </>
      ) : (
        <>
          <TouchableOpacity style={styles.imagePicker} onPress={pickImage}>
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.imagePreview} />
            ) : (
              <View style={styles.imagePlaceholder}>
                <Text style={styles.imagePlaceholderIcon}>📷</Text>
                <Text style={styles.imagePlaceholderText}>Add Photo</Text>
              </View>
            )}
            <Text style={styles.imagePickerLabel}>{imageUri ? 'Change Photo' : 'Add Photo'}</Text>
          </TouchableOpacity>

          <Text style={styles.label}>Product Name *</Text>
          <TextInput
            style={styles.input} placeholder="e.g. Attar Rose" placeholderTextColor="#999"
            value={name} onChangeText={setName} autoFocus={mode === 'add'}
          />

          {mode === 'add' && !!suggestions?.length && (
            <View style={styles.matchSuggestions}>
              <Text style={styles.matchSuggestionsLabel}>Did you mean one of these already in your catalog?</Text>
              <View style={styles.matchChipRow}>
                {suggestions.map(s => (
                  <TouchableOpacity key={s.id} style={styles.matchChip}
                    onPress={() => onSelectSuggestion && onSelectSuggestion(s)}>
                    <Text style={styles.matchChipText}>{s.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          <Text style={styles.label}>Category</Text>
          <TextInput
            style={styles.input} placeholder="e.g. Attar, Bakhoor, Books" placeholderTextColor="#999"
            value={category}
            onChangeText={(t) => { setCategory(t); setShowSuggestions(t.length > 0); }}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          />
          {showSuggestions && filteredCategories.length > 0 && (
            <View style={styles.suggestions}>
              {filteredCategories.slice(0, 4).map(c => (
                <TouchableOpacity key={c} style={styles.suggestionItem}
                  onPress={() => { setCategory(c); setShowSuggestions(false); }}>
                  <Text style={styles.suggestionText}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.label}>Selling Price ₹ *</Text>
          <TextInput
            style={styles.input} placeholder="0" placeholderTextColor="#999"
            keyboardType="numeric" value={sellingPrice} onChangeText={setSellingPrice}
          />

          <Text style={styles.label}>GST Rate</Text>
          <View style={styles.gstRow}>
            {GST_OPTIONS.map(rate => (
              <TouchableOpacity key={rate} style={[styles.gstChip, taxRate === rate && styles.gstChipActive]}
                onPress={() => setTaxRate(rate)}>
                <Text style={[styles.gstChipText, taxRate === rate && styles.gstChipTextActive]}>{rate}%</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Cost Price ₹ <Text style={styles.optional}>(optional)</Text></Text>
          <TextInput
            style={styles.input} placeholder="What you pay the supplier" placeholderTextColor="#999"
            keyboardType="numeric" value={costPrice} onChangeText={setCostPrice}
          />

          <Text style={styles.label}>HSN Code <Text style={styles.optional}>(optional)</Text></Text>
          <TextInput
            style={styles.input} placeholder="e.g. 3304" placeholderTextColor="#999"
            keyboardType="numeric" value={hsnCode} onChangeText={setHsnCode}
          />

          {mode === 'add' && (
            <>
              <Text style={styles.label}>How many do you have right now? <Text style={styles.optional}>(optional)</Text></Text>
              <TextInput
                style={styles.input} placeholder="0" placeholderTextColor="#999"
                keyboardType="numeric" value={quantity} onChangeText={setQuantity}
              />
            </>
          )}
        </>
      )}

      <View style={styles.actions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onDismiss} disabled={loading}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          onPress={handleSubmit} disabled={loading || !canSubmit}>
          {loading
            ? <ActivityIndicator size="small" color="#FFF" />
            : <Text style={styles.submitText}>{matchedProduct ? 'Add Stock' : (mode === 'add' ? 'Add Product' : 'Save Changes')}</Text>
          }
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 16 },
  imagePicker: { alignItems: 'center', marginBottom: 8 },
  imagePreview: { width: 90, height: 90, borderRadius: 12, marginBottom: 4 },
  imagePlaceholder: { width: 90, height: 90, borderRadius: 12, backgroundColor: '#E8F5E9', justifyContent: 'center', alignItems: 'center', marginBottom: 4 },
  imagePlaceholderIcon: { fontSize: 28 },
  imagePlaceholderText: { fontSize: 11, color: '#999', marginTop: 2 },
  imagePickerLabel: { fontSize: 12, color: '#075E54', fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6, marginTop: 12 },
  optional: { fontSize: 12, fontWeight: '400', color: '#999' },
  input: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1A1A1A', backgroundColor: '#FAFAFA' },
  suggestions: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, marginTop: 4, backgroundColor: '#FFF', overflow: 'hidden' },
  suggestionItem: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  suggestionText: { fontSize: 14, color: '#333' },
  gstRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  gstChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E0E0E0', backgroundColor: '#FAFAFA' },
  gstChipActive: { backgroundColor: '#075E54', borderColor: '#075E54' },
  gstChipText: { fontSize: 13, fontWeight: '600', color: '#666' },
  gstChipTextActive: { color: '#FFF' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 24, marginBottom: 8 },
  cancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, borderWidth: 1, borderColor: '#E0E0E0', alignItems: 'center' },
  cancelText: { fontSize: 15, fontWeight: '600', color: '#666' },
  submitBtn: { flex: 2, paddingVertical: 14, borderRadius: 10, backgroundColor: '#075E54', alignItems: 'center' },
  submitBtnDisabled: { backgroundColor: '#CCC' },
  submitText: { fontSize: 15, fontWeight: '700', color: '#FFF' },
  matchBanner: { backgroundColor: '#E8F5E9', borderRadius: 10, padding: 14, marginBottom: 8 },
  matchBannerText: { fontSize: 12, color: '#4A7C59', marginBottom: 2 },
  matchBannerName: { fontSize: 16, fontWeight: '700', color: '#1A1A1A', marginBottom: 8 },
  matchBannerClear: { fontSize: 12, color: '#075E54', fontWeight: '600' },
  matchSuggestions: { marginTop: 4, marginBottom: 4 },
  matchSuggestionsLabel: { fontSize: 12, color: '#888', marginBottom: 6 },
  matchChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  matchChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: '#E8F5E9', borderWidth: 1, borderColor: '#A5D6A7' },
  matchChipText: { fontSize: 13, color: '#2E7D32', fontWeight: '600' },
});
