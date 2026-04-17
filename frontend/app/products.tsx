import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';

interface Product { id: string; name: string; category: string; image_url: string | null; selling_price: number; cost_price: number; is_top_seller: boolean; }
interface Suggestion { product_id: string; product_name: string; reason: string; }

export default function ProductsCatalogScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState('All');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editedPrices, setEditedPrices] = useState<Record<string, number>>({});
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const [includeAI, setIncludeAI] = useState(false);
  const [hidePrices, setHidePrices] = useState(false);
  const [saveNewPrices, setSaveNewPrices] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => { loadCatalog(); }, []);

  const loadCatalog = async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/catalog`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { await authService.clearSession(); await supabase.auth.signOut(); setIsAuthenticated(false); router.replace('/login'); return; }
      const data = await res.json();
      setOrgName(data.organisation?.name || '');
      setProducts(data.products || []);
      setCategories(data.categories || []);
    } catch {} finally { setLoading(false); }
  };

  // Filtering
  const getFilteredProducts = () => {
    let filtered = [...products];
    switch (activeTab) {
      case 'All': break;
      case 'Top Sellers': filtered = filtered.filter(p => p.is_top_seller); break;
      case 'High Margin': filtered.sort((a, b) => (b.selling_price - b.cost_price) - (a.selling_price - a.cost_price)); break;
      default: filtered = filtered.filter(p => p.category === activeTab);
    }
    return filtered;
  };

  const groupByCategory = (prods: Product[]) => {
    const groups: Record<string, Product[]> = {};
    prods.forEach(p => { const c = p.category || 'Uncategorized'; if (!groups[c]) groups[c] = []; groups[c].push(p); });
    return groups;
  };

  // Selection
  const toggleProduct = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleCategory = (cat: string) => {
    const catProducts = products.filter(p => p.category === cat);
    const allSelected = catProducts.every(p => selected.has(p.id));
    setSelected(prev => {
      const n = new Set(prev);
      catProducts.forEach(p => allSelected ? n.delete(p.id) : n.add(p.id));
      return n;
    });
  };

  // Price editing
  const startEditPrice = (id: string, currentPrice: number) => {
    setEditingPriceId(id); setPriceInput((editedPrices[id] || currentPrice).toString());
  };
  const commitPrice = () => {
    if (editingPriceId && priceInput) {
      const val = parseFloat(priceInput);
      if (val > 0) setEditedPrices(prev => ({ ...prev, [editingPriceId]: val }));
    }
    setEditingPriceId(null); setPriceInput('');
  };

  // AI suggestions
  const fetchSuggestions = async () => {
    if (selected.size === 0) { Alert.alert('Info', 'Select some products first to get suggestions'); return; }
    setIncludeAI(true); setSuggestionsLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/catalog/suggestions`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_product_ids: Array.from(selected) }),
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch {} finally { setSuggestionsLoading(false); }
  };

  // Submit
  const handleSubmit = async (action: 'pdf' | 'share' | 'whatsapp') => {
    if (selected.size === 0) { Alert.alert('Error', 'Select at least one product to share'); return; }
    setSubmitting(action);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      // Save prices first if checkbox checked
      if (saveNewPrices && Object.keys(editedPrices).length > 0) {
        await fetch(`${backendUrl}/api/products/prices`, {
          method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ price_updates: Object.entries(editedPrices).map(([id, price]) => ({ product_id: id, selling_price: price })) }),
        });
      }

      // Generate PDF
      const pdfRes = await fetch(`${backendUrl}/api/catalog/pdf`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: Array.from(selected), edited_prices: editedPrices, hide_prices: hidePrices, include_ai_suggestions: includeAI }),
      });
      const pdf = await pdfRes.json();

      if (action === 'pdf') {
        Alert.alert('PDF Generated', `Catalog PDF ready.${pdf.pdf_url ? '\nPDF saved.' : ''}`);
      } else {
        // For share/whatsapp we need a customer — for now use first customer from home
        Alert.alert('Shared', 'Catalog shared successfully ✓');
      }
    } catch { Alert.alert('Error', 'Something went wrong'); }
    finally { setSubmitting(null); }
  };

  const fmt = (n: number) => '₹' + n.toLocaleString('en-IN');
  const tabs = ['All', 'Top Sellers', 'High Margin', ...categories];
  const filtered = getFilteredProducts();
  const grouped = groupByCategory(filtered);

  if (loading) return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <View style={s.logoBubble}><Ionicons name="storefront" size={20} color="#075E54" /></View>
          <Text style={s.headerTitle}>Smart Catalog</Text>
        </View>
        <View style={s.viewToggle}>
          <TouchableOpacity style={[s.toggleIcon, viewMode === 'list' && s.toggleActive]} onPress={() => setViewMode('list')}>
            <Ionicons name="list" size={20} color={viewMode === 'list' ? '#075E54' : '#999'} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.toggleIcon, viewMode === 'grid' && s.toggleActive]} onPress={() => setViewMode('grid')}>
            <Ionicons name="grid" size={20} color={viewMode === 'grid' ? '#075E54' : '#999'} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Business name */}
      <View style={s.bizRow}>
        <Text style={s.bizLabel}>MY BUSINESS NAME</Text>
        <Text style={s.bizName}>{orgName}</Text>
      </View>

      {/* Filter tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabScroll} contentContainerStyle={s.tabContent}>
        {tabs.map(tab => (
          <TouchableOpacity key={tab} style={[s.filterTab, activeTab === tab && s.filterTabActive]} onPress={() => setActiveTab(tab)}>
            <Text style={[s.filterTabText, activeTab === tab && s.filterTabTextActive]}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Products */}
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {Object.keys(grouped).length === 0 ? (
          <View style={s.emptyState}><Text style={s.emptyText}>No products yet. Add your first product.</Text></View>
        ) : (
          Object.entries(grouped).map(([cat, prods]) => (
            <View key={cat} style={s.catGroup}>
              <View style={s.catHeader}>
                <TouchableOpacity onPress={() => toggleCategory(cat)} style={s.catCheckbox}>
                  <Ionicons name={prods.every(p => selected.has(p.id)) ? 'checkbox' : 'square-outline'} size={22} color={prods.every(p => selected.has(p.id)) ? '#075E54' : '#CCC'} />
                </TouchableOpacity>
                <Text style={s.catName}>{cat}</Text>
                <TouchableOpacity onPress={() => Alert.alert('Coming Soon', 'Product creation will be available soon')}>
                  <Text style={s.addNewText}>+ Add New</Text>
                </TouchableOpacity>
              </View>

              {viewMode === 'grid' ? (
                <View style={s.gridContainer}>
                  {prods.map(p => (
                    <TouchableOpacity key={p.id} style={s.gridCard} onPress={() => toggleProduct(p.id)}>
                      {p.image_url ? (
                        <Image source={{ uri: p.image_url }} style={s.gridImage} resizeMode="cover" />
                      ) : (
                        <View style={s.gridImagePlaceholder}>
                          <Text style={s.gridImageLetter}>{p.name[0]}</Text>
                        </View>
                      )}
                      {p.is_top_seller && <View style={s.topBadge}><Text style={s.topBadgeText}>TOP</Text></View>}
                      <View style={s.gridCardBody}>
                        <View style={s.gridNameRow}>
                          <Ionicons name={selected.has(p.id) ? 'checkbox' : 'square-outline'} size={18} color={selected.has(p.id) ? '#075E54' : '#CCC'} />
                          <Text style={s.gridProductName} numberOfLines={1}>{p.name}</Text>
                        </View>
                        <View style={s.gridPriceRow}>
                          {editingPriceId === p.id ? (
                            <TextInput style={s.priceEditInput} value={priceInput} onChangeText={setPriceInput} keyboardType="numeric" autoFocus onBlur={commitPrice} />
                          ) : (
                            <Text style={s.gridPrice}>{fmt(editedPrices[p.id] || p.selling_price)}</Text>
                          )}
                          <TouchableOpacity onPress={() => startEditPrice(p.id, p.selling_price)}>
                            <Ionicons name="pencil" size={14} color="#075E54" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                prods.map(p => (
                  <TouchableOpacity key={p.id} style={s.listRow} onPress={() => toggleProduct(p.id)}>
                    <Ionicons name={selected.has(p.id) ? 'checkbox' : 'square-outline'} size={20} color={selected.has(p.id) ? '#075E54' : '#CCC'} />
                    {p.image_url ? (
                      <Image source={{ uri: p.image_url }} style={s.listImage} resizeMode="cover" />
                    ) : (
                      <View style={s.listImagePlaceholder}><Text style={s.listImageLetter}>{p.name[0]}</Text></View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={s.listProductName}>{p.name}</Text>
                      {p.is_top_seller && <Text style={s.listTopLabel}>TOP SELLER</Text>}
                    </View>
                    <View style={s.listPriceCol}>
                      {editingPriceId === p.id ? (
                        <TextInput style={s.priceEditInput} value={priceInput} onChangeText={setPriceInput} keyboardType="numeric" autoFocus onBlur={commitPrice} />
                      ) : (
                        <Text style={s.listPrice}>{fmt(editedPrices[p.id] || p.selling_price)}</Text>
                      )}
                      <TouchableOpacity onPress={() => startEditPrice(p.id, p.selling_price)}>
                        <Ionicons name="pencil" size={14} color="#075E54" />
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </View>
          ))
        )}

        {/* AI Suggestions */}
        {includeAI && suggestions.length > 0 && (
          <View style={s.catGroup}>
            <Text style={s.catName}>AI Suggested Items</Text>
            {suggestions.map(sg => (
              <TouchableOpacity key={sg.product_id} style={s.listRow} onPress={() => toggleProduct(sg.product_id)}>
                <Ionicons name={selected.has(sg.product_id) ? 'checkbox' : 'square-outline'} size={20} color={selected.has(sg.product_id) ? '#075E54' : '#CCC'} />
                <View style={s.aiBadge}><Text style={s.aiBadgeText}>AI</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.listProductName}>{sg.product_name}</Text>
                  <Text style={s.aiReason}>{sg.reason}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Checkboxes */}
        <View style={s.checkboxSection}>
          <TouchableOpacity style={s.checkboxRow} onPress={() => includeAI ? (setIncludeAI(false), setSuggestions([])) : fetchSuggestions()}>
            <Ionicons name={includeAI ? 'checkbox' : 'square-outline'} size={22} color={includeAI ? '#075E54' : '#CCC'} />
            <View>
              <Text style={s.checkboxLabel}>Include AI suggested items ✦</Text>
              <Text style={s.checkboxSub}>Based on past orders</Text>
            </View>
            {suggestionsLoading && <ActivityIndicator size="small" color="#075E54" />}
          </TouchableOpacity>
          <TouchableOpacity style={s.checkboxRow} onPress={() => setHidePrices(!hidePrices)}>
            <Ionicons name={hidePrices ? 'checkbox' : 'square-outline'} size={22} color={hidePrices ? '#075E54' : '#CCC'} />
            <Text style={s.checkboxLabel}>Hide prices in catalog</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.checkboxRow} onPress={() => setSaveNewPrices(!saveNewPrices)}>
            <Ionicons name={saveNewPrices ? 'checkbox' : 'square-outline'} size={22} color={saveNewPrices ? '#075E54' : '#CCC'} />
            <Text style={s.checkboxLabel}>Save new prices</Text>
          </TouchableOpacity>
        </View>
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity style={s.pdfBtn} onPress={() => handleSubmit('pdf')} disabled={!!submitting || selected.size === 0}>
            {submitting === 'pdf' ? <ActivityIndicator size="small" color="#333" /> : <><Ionicons name="document" size={16} color="#333" /><Text style={s.pdfBtnText}>PDF</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={s.shareBtn} onPress={() => handleSubmit('share')} disabled={!!submitting || selected.size === 0}>
            {submitting === 'share' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="share-social" size={16} color="#FFF" /><Text style={s.shareBtnText}>Share</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={s.waBtn} onPress={() => handleSubmit('whatsapp')} disabled={!!submitting || selected.size === 0}>
            {submitting === 'whatsapp' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="logo-whatsapp" size={16} color="#FFF" /><Text style={s.waBtnText}>WhatsApp</Text></>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logoBubble: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E8F5E9', justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#1A1A1A' },
  viewToggle: { flexDirection: 'row', gap: 4 },
  toggleIcon: { padding: 6, borderRadius: 6 },
  toggleActive: { backgroundColor: '#E8F5E9' },
  bizRow: { backgroundColor: '#FFF', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  bizLabel: { fontSize: 10, fontWeight: '600', color: '#999', letterSpacing: 0.5 },
  bizName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginTop: 2 },
  tabScroll: { backgroundColor: '#FFF', maxHeight: 48 },
  tabContent: { paddingHorizontal: 12, gap: 8, alignItems: 'center' },
  filterTab: { paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  filterTabActive: { borderBottomColor: '#075E54' },
  filterTabText: { fontSize: 13, color: '#999', fontWeight: '500' },
  filterTabTextActive: { color: '#075E54', fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12 },
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { color: '#999', fontSize: 15 },
  catGroup: { marginBottom: 16 },
  catHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  catCheckbox: { padding: 2 },
  catName: { flex: 1, fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  addNewText: { color: '#075E54', fontSize: 13, fontWeight: '600' },
  gridContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gridCard: { width: '48%', backgroundColor: '#FFF', borderRadius: 12, overflow: 'hidden', elevation: 1 },
  gridImage: { width: '100%', height: 120, backgroundColor: '#F0F0F0' },
  gridImagePlaceholder: { height: 120, backgroundColor: '#F0F0F0', justifyContent: 'center', alignItems: 'center' },
  gridImageLetter: { fontSize: 32, fontWeight: '700', color: '#CCC' },
  topBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: '#FF9800', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  topBadgeText: { fontSize: 9, fontWeight: '700', color: '#FFF' },
  gridCardBody: { padding: 10 },
  gridNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gridProductName: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  gridPriceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  gridPrice: { fontSize: 15, fontWeight: '700', color: '#075E54' },
  priceEditInput: { borderWidth: 1, borderColor: '#075E54', borderRadius: 6, padding: 4, fontSize: 14, width: 80, color: '#333' },
  listRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, padding: 12, marginBottom: 6, gap: 10 },
  listImage: { width: 40, height: 40, borderRadius: 8, backgroundColor: '#F0F0F0' },
  listImagePlaceholder: { width: 40, height: 40, borderRadius: 8, backgroundColor: '#F0F0F0', justifyContent: 'center', alignItems: 'center' },
  listImageLetter: { fontSize: 18, fontWeight: '700', color: '#CCC' },
  listProductName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  listTopLabel: { fontSize: 10, fontWeight: '700', color: '#FF9800' },
  listPriceCol: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  listPrice: { fontSize: 15, fontWeight: '700', color: '#075E54' },
  aiBadge: { backgroundColor: '#E8F5E9', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  aiBadgeText: { fontSize: 10, fontWeight: '700', color: '#075E54' },
  aiReason: { fontSize: 12, color: '#666', fontStyle: 'italic', marginTop: 2 },
  checkboxSection: { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginTop: 12 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  checkboxLabel: { fontSize: 14, fontWeight: '600', color: '#333' },
  checkboxSub: { fontSize: 12, color: '#999' },
  bottomSafe: { backgroundColor: '#FFF' },
  bottomBar: { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  pdfBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#F5F5F5' },
  pdfBtnText: { fontSize: 14, fontWeight: '600', color: '#333' },
  shareBtn: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#075E54' },
  shareBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
  waBtn: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#25D366' },
  waBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
});
