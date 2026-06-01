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
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import BottomSheet from './BottomSheet';

const GST_OPTIONS = [0, 5, 12, 18, 28];

export interface ProductFormData {
  name: string;
  category: string;
  sellingPrice: string;
  taxRate: number;
  costPrice: string;
}

interface ProductFormSheetProps {
  visible: boolean;
  mode: 'add' | 'edit';
  initialValues?: Partial<ProductFormData>;
  categories?: string[];
  onSubmit: (data: ProductFormData) => void;
  onDismiss: () => void;
  loading?: boolean;
}

export default function ProductFormSheet({
  visible, mode, initialValues, categories = [], onSubmit, onDismiss, loading = false,
}: ProductFormSheetProps) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [taxRate, setTaxRate] = useState(0);
  const [costPrice, setCostPrice] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    if (visible && initialValues) {
      setName(initialValues.name || '');
      setCategory(initialValues.category || '');
      setSellingPrice(initialValues.sellingPrice || '');
      setTaxRate(initialValues.taxRate ?? 0);
      setCostPrice(initialValues.costPrice || '');
    }
    if (!visible) {
      setName(''); setCategory(''); setSellingPrice('');
      setTaxRate(0); setCostPrice(''); setShowSuggestions(false);
    }
  }, [visible]);

  const filteredCategories = categories.filter(c =>
    c.toLowerCase().includes(category.toLowerCase()) && c !== category && category.length > 0
  );

  const canSubmit = name.trim().length > 0 && sellingPrice.length > 0 && Number(sellingPrice) >= 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), category: category.trim(), sellingPrice, taxRate, costPrice });
  };

  return (
    <BottomSheet visible={visible} onDismiss={onDismiss}>
      <Text style={styles.heading}>{mode === 'add' ? 'Add Product' : 'Edit Product'}</Text>

      <Text style={styles.label}>Product Name *</Text>
      <TextInput
        style={styles.input} placeholder="e.g. Attar Rose" placeholderTextColor="#999"
        value={name} onChangeText={setName} autoFocus={mode === 'add'}
      />

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

      <View style={styles.actions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onDismiss} disabled={loading}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          onPress={handleSubmit} disabled={loading || !canSubmit}>
          {loading
            ? <ActivityIndicator size="small" color="#FFF" />
            : <Text style={styles.submitText}>{mode === 'add' ? 'Add Product' : 'Save Changes'}</Text>
          }
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 18, fontWeight: '700', color: '#1A1A1A', marginBottom: 16 },
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
});
