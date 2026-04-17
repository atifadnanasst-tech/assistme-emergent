import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image,
  ActivityIndicator, Alert, Linking, TextInput, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { authService } from '../../lib/auth';

interface Product {
  id: string;
  name: string;
  category: string;
  image_url: string | null;
  selling_price: number;
  sku: string | null;
  is_top_seller: boolean;
}

export default function SmartCatalogsScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hidePrices, setHidePrices] = useState(false);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      router.replace('/login');
      return null;
    }
    return token;
  };

  useEffect(() => {
    loadCatalog();
  }, []);

  const loadCatalog = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/catalog`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }
      const data = await res.json();
      setOrgName(data.organisation?.name || '');
      setCategories(data.categories || []);
      setProducts(data.products || []);

      // Auto-select top sellers
      const topSellerIds = new Set(
        (data.products || []).filter((p: Product) => p.is_top_seller).map((p: Product) => p.id)
      );
      setSelectedIds(topSellerIds);
    } catch (error) {
      console.error('[CATALOG] Load error:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleProduct = (id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const toggleCategory = (category: string) => {
    const categoryProducts = products.filter(p => p.category === category);
    const allSelected = categoryProducts.every(p => selectedIds.has(p.id));
    
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      categoryProducts.forEach(p => {
        if (allSelected) {
          newSet.delete(p.id);
        } else {
          newSet.add(p.id);
        }
      });
      return newSet;
    });
  };

  const handleGeneratePDF = async () => {
    if (selectedIds.size === 0) {
      Alert.alert('Error', 'Please select at least one product');
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      console.log('[CATALOG] Generating PDF for', selectedIds.size, 'products');

      const res = await fetch(`${backendUrl}/api/catalog/pdf`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product_ids: Array.from(selectedIds),
          hide_prices: hidePrices,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error('[CATALOG] PDF failed:', err);
        Alert.alert('Error', 'Failed to generate PDF');
        return;
      }

      const data = await res.json();
      console.log('[CATALOG] PDF generated:', data.pdf_url);
      Alert.alert(
        'PDF Generated',
        'Catalog PDF created successfully!',
        [
          { text: 'View PDF', onPress: () => Linking.openURL(data.pdf_url) },
          { text: 'OK', style: 'cancel' },
        ]
      );
    } catch (error) {
      console.error('[CATALOG] PDF error:', error);
      Alert.alert('Error', 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWhatsAppShare = async () => {
    if (selectedIds.size === 0) {
      Alert.alert('Error', 'Please select at least one product');
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      console.log('[CATALOG] Generating PDF for WhatsApp share');

      // First generate PDF
      const res1 = await fetch(`${backendUrl}/api/catalog/pdf`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          product_ids: Array.from(selectedIds),
          hide_prices: hidePrices,
        }),
      });

      if (!res1.ok) {
        Alert.alert('Error', 'Failed to generate PDF');
        return;
      }

      const pdf = await res1.json();
      console.log('[CATALOG] PDF URL:', pdf.pdf_url);

      // Generate WhatsApp share link
      const text = encodeURIComponent(
        `Check out our latest product catalog from ${orgName}!\n\n📄 ${pdf.pdf_url}\n\nGenerated by AssistMe: https://assistme.app`
      );
      const waUrl = `https://wa.me/?text=${text}`;

      try {
        await Linking.openURL(waUrl);
      } catch (linkErr) {
        console.error('[CATALOG] Failed to open WhatsApp:', linkErr);
        Alert.alert('Error', 'Could not open WhatsApp');
      }
    } catch (error) {
      console.error('[CATALOG] WhatsApp share error:', error);
      Alert.alert('Error', 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Smart Catalogs</Text>
        </View>
        <View style={s.center}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Smart Catalogs</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: '#FFF', fontSize: 13 }}>{selectedIds.size} selected</Text>
        </View>
      </View>

      <ScrollView style={s.scroll}>
        {/* Hide Prices Toggle */}
        <View style={s.toggleContainer}>
          <Text style={s.toggleLabel}>Hide Prices</Text>
          <TouchableOpacity
            onPress={() => setHidePrices(!hidePrices)}
            style={[s.toggle, hidePrices && s.toggleActive]}
          >
            <View style={[s.toggleThumb, hidePrices && s.toggleThumbActive]} />
          </TouchableOpacity>
        </View>

        {/* Products by Category */}
        {categories.map(category => {
          const categoryProducts = products.filter(p => p.category === category);
          const allSelected = categoryProducts.every(p => selectedIds.has(p.id));
          const someSelected = categoryProducts.some(p => selectedIds.has(p.id));

          return (
            <View key={category} style={s.categorySection}>
              <TouchableOpacity
                style={s.categoryHeader}
                onPress={() => toggleCategory(category)}
              >
                <Text style={s.categoryTitle}>{category}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={s.categoryCount}>
                    {categoryProducts.filter(p => selectedIds.has(p.id)).length}/{categoryProducts.length}
                  </Text>
                  <Ionicons
                    name={allSelected ? 'checkmark-circle' : someSelected ? 'checkmark-circle-outline' : 'ellipse-outline'}
                    size={24}
                    color={allSelected || someSelected ? '#075E54' : '#CCC'}
                  />
                </View>
              </TouchableOpacity>

              {categoryProducts.map(product => (
                <TouchableOpacity
                  key={product.id}
                  style={s.productCard}
                  onPress={() => toggleProduct(product.id)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    {product.image_url ? (
                      <Image source={{ uri: product.image_url }} style={s.productImage} />
                    ) : (
                      <View style={[s.productImage, s.productImagePlaceholder]}>
                        <Ionicons name="image-outline" size={24} color="#999" />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={s.productName}>{product.name}</Text>
                      {product.sku && <Text style={s.productSku}>SKU: {product.sku}</Text>}
                      {!hidePrices && <Text style={s.productPrice}>₹{product.selling_price.toFixed(2)}</Text>}
                    </View>
                    <Ionicons
                      name={selectedIds.has(product.id) ? 'checkmark-circle' : 'ellipse-outline'}
                      size={28}
                      color={selectedIds.has(product.id) ? '#075E54' : '#CCC'}
                    />
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          );
        })}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity
            style={s.pdfBtn}
            onPress={handleGeneratePDF}
            disabled={submitting || selectedIds.size === 0}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#075E54" />
            ) : (
              <>
                <Ionicons name="document" size={18} color="#075E54" />
                <Text style={s.pdfBtnText}>Generate PDF</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={s.waBtn}
            onPress={handleWhatsAppShare}
            disabled={submitting || selectedIds.size === 0}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#FFF" />
            ) : (
              <>
                <Ionicons name="logo-whatsapp" size={18} color="#FFF" />
                <Text style={s.waBtnText}>Share on WhatsApp</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  scroll: { flex: 1 },
  toggleContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', padding: 16, marginBottom: 8 },
  toggleLabel: { fontSize: 15, fontWeight: '600', color: '#333' },
  toggle: { width: 50, height: 28, borderRadius: 14, backgroundColor: '#DDD', padding: 2, justifyContent: 'center' },
  toggleActive: { backgroundColor: '#075E54', alignItems: 'flex-end' },
  toggleThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFF' },
  toggleThumbActive: { backgroundColor: '#FFF' },
  categorySection: { marginBottom: 8 },
  categoryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', padding: 14, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  categoryTitle: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  categoryCount: { fontSize: 13, color: '#666' },
  productCard: { backgroundColor: '#FFF', padding: 12, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  productImage: { width: 60, height: 60, borderRadius: 8, backgroundColor: '#F0F0F0' },
  productImagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  productName: { fontSize: 15, fontWeight: '600', color: '#1A1A1A', marginBottom: 2 },
  productSku: { fontSize: 12, color: '#999', marginBottom: 2 },
  productPrice: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  bottomSafe: { backgroundColor: '#FFF' },
  bottomBar: { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  pdfBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#F0F0F0', borderWidth: 1, borderColor: '#075E54' },
  pdfBtnText: { fontSize: 14, fontWeight: '600', color: '#075E54' },
  waBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#25D366' },
  waBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
});
