import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform, Image,
  Modal, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';
import ProductFormSheet, { ProductFormData } from '../components/primitives/ProductFormSheet';

interface Product { id: string; name: string; category: string; image_url: string | null; selling_price: number; cost_price: number; tax_rate: number; is_top_seller: boolean; }
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
  // Product form state
  const [formVisible, setFormVisible] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [formInitialValues, setFormInitialValues] = useState<Partial<ProductFormData>>({});
  const [formLoading, setFormLoading] = useState(false);
  const [formCategory, setFormCategory] = useState('');
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [longPressProduct, setLongPressProduct] = useState<Product | null>(null);
  const [longPressMenuVisible, setLongPressMenuVisible] = useState(false);
  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [archivedVisible, setArchivedVisible] = useState(false);
  const [archivedProducts, setArchivedProducts] = useState<{id:string,name:string,category:string,selling_price:number}[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

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

  const loadArchived = async () => {
    setArchivedLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/products/archived`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      setArchivedProducts(data.products || []);
    } catch {} finally { setArchivedLoading(false); }
  };

  const handleUnarchive = async (productId: string) => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      });
      if (res.ok) { await loadArchived(); await loadCatalog(); }
      else { Alert.alert('Error', 'Could not unarchive product.'); }
    } catch { Alert.alert('Error', 'Could not unarchive product.'); }
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

      console.log(`[CATALOG] Action: ${action}, Selected: ${selected.size} products`);

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
      
      if (!pdfRes.ok) {
        const errText = await pdfRes.text();
        console.error('[CATALOG] PDF generation failed:', errText);
        Alert.alert('Error', 'Failed to generate PDF');
        return;
      }
      
      const pdf = await pdfRes.json();
      console.log('[CATALOG] PDF URL:', pdf.pdf_url);

      if (action === 'pdf') {
        Alert.alert(
          'PDF Generated ✓',
          `Your catalog is ready!\n\n${pdf.pdf_url || 'PDF URL not available'}`,
          [
            {
              text: 'Copy Link',
              onPress: () => {
                // Note: Clipboard API not available in basic RN, would need @react-native-clipboard/clipboard
                Alert.alert('Link', pdf.pdf_url || '');
              }
            },
            {
              text: 'Open PDF',
              onPress: () => {
                if (pdf.pdf_url) {
                  Linking.openURL(pdf.pdf_url).catch(() => Alert.alert('Error', 'Could not open PDF'));
                }
              }
            },
            { text: 'OK', style: 'cancel' }
          ]
        );
      } else if (action === 'whatsapp') {
        // Open WhatsApp with PDF link and default message
        const message = encodeURIComponent(
          `Check out our latest product catalog from ${orgName}!\n\n📄 ${pdf.pdf_url}\n\nGenerated by AssistMe: https://assistme.app`
        );
        const waUrl = `https://wa.me/?text=${message}`;
        console.log('[CATALOG] Opening WhatsApp with URL');
        
        try {
          await Linking.openURL(waUrl);
        } catch (linkErr) {
          console.error('[CATALOG] Failed to open WhatsApp:', linkErr);
          Alert.alert('Error', 'Could not open WhatsApp');
        }
      } else {
        // share action
        Alert.alert('Shared', 'Catalog shared successfully ✓');
      }
    } catch (error) {
      console.error('[CATALOG] Submit error:', error);
      Alert.alert('Error', 'Something went wrong');
    } finally { 
      setSubmitting(null); 
    }
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

  const openAddForm = (category?: string) => {
    setFormMode('add');
    setFormInitialValues(category ? { category } : {});
    setFormCategory(category || '');
    setEditingProductId(null);
    setFormVisible(true);
  };

  const openEditForm = (product: Product) => {
    setFormMode('edit');
    setFormInitialValues({
      name: product.name,
      category: product.category,
      sellingPrice: String(product.selling_price),
      taxRate: product.tax_rate ?? 0,
      costPrice: String(product.cost_price || ''),
      imageUri: product.image_url || undefined,
    });
    setEditingProductId(product.id);
    setFormVisible(true);
    setLongPressMenuVisible(false);
  };

  const uploadProductImage = async (productId: string, imageUri: string) => {
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const formData = new FormData();
      const filename = imageUri.split('/').pop() || 'photo.jpg';
      const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      formData.append('file', { uri: imageUri, name: filename, type: mime } as any);
      await fetch(`${backendUrl}/api/products/${productId}/image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
    } catch (err) {
      console.error('[uploadProductImage] failed:', err);
    }
  };

  const handleUpdatePhoto = async (product: Product) => {
    setLongPressMenuVisible(false);
    const permission = await (await import('expo-image-picker')).requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { Alert.alert('Permission required', 'Please allow access to your photo library.'); return; }
    const result = await (await import('expo-image-picker')).launchImageLibraryAsync({
      mediaTypes: 'images' as any,
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      await uploadProductImage(product.id, result.assets[0].uri);
      await loadCatalog();
      Alert.alert('Done', 'Photo updated.');
    }
  };

  const handleFormSubmit = async (data: ProductFormData) => {
    setFormLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const body = {
        name: data.name,
        selling_price: Number(data.sellingPrice),
        tax_rate: data.taxRate,
        category: data.category || null,
        cost_price: Number(data.costPrice) || 0,
      };
      const res = formMode === 'add'
        ? await fetch(`${backendUrl}/api/products`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch(`${backendUrl}/api/products/${editingProductId}`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        const saved = await res.json().catch(() => ({}));
        const productId = formMode === 'add' ? saved.id : editingProductId;
        if (data.imageUri && productId) {
          await uploadProductImage(productId, data.imageUri);
        }
        setFormVisible(false);
        await loadCatalog();
        Alert.alert('Success', formMode === 'add' ? 'Product added successfully.' : 'Product updated.');
      } else {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Error', err.message || 'Something went wrong.');
      }
    } catch (err) {
      Alert.alert('Error', 'Could not save product. Please try again.');
    } finally {
      setFormLoading(false);
    }
  };

  const handleArchive = async (product: Product) => {
    setLongPressMenuVisible(false);
    Alert.alert('Archive Product', `Archive "${product.name}"? It will no longer appear in your catalog.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Archive', style: 'destructive', onPress: async () => {
        try {
          const token = await getToken();
          if (!token) return;
          const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
          const res = await fetch(`${backendUrl}/api/products/${product.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: false }),
          });
          if (res.ok) { await loadCatalog(); }
          else { Alert.alert('Error', 'Could not archive product.'); }
        } catch { Alert.alert('Error', 'Could not archive product.'); }
      }},
    ]);
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <View style={s.logoBubble}><Ionicons name="storefront" size={20} color="#075E54" /></View>
          <Text style={s.headerTitle}>Smart Catalog</Text>
        </View>
        <View style={s.viewToggle}>
          <TouchableOpacity style={s.selectAllBtn} onPress={() => {
            const allIds = filtered.map(p => p.id);
            const allSelected = allIds.every(id => selected.has(id));
            setSelected(allSelected ? new Set() : new Set(allIds));
          }}>
            <Text style={s.selectAllText}>{filtered.length > 0 && filtered.every(p => selected.has(p.id)) ? 'Deselect All' : 'Select All'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.toggleIcon} onPress={() => setHeaderMenuVisible(true)}>
            <Ionicons name="ellipsis-vertical" size={22} color="#333" />
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
                <TouchableOpacity onPress={() => openAddForm(cat)}>
                  <Text style={s.addNewText}>+ Add New</Text>
                </TouchableOpacity>
              </View>

              {viewMode === 'grid' ? (
                <View style={s.gridContainer}>
                  {prods.map(p => (
                    <TouchableOpacity key={p.id} style={s.gridCard} onPress={() => toggleProduct(p.id)}
                      onLongPress={() => { setLongPressProduct(p); setLongPressMenuVisible(true); }}>
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
                  <TouchableOpacity key={p.id} style={s.listRow} onPress={() => toggleProduct(p.id)} onLongPress={() => { setLongPressProduct(p); setLongPressMenuVisible(true); }}>
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

      </ScrollView>

      {/* Catalog Options Strip */}
      <View style={s.optionsStrip}>
        <TouchableOpacity style={s.optionItem} onPress={() => includeAI ? (setIncludeAI(false), setSuggestions([])) : fetchSuggestions()}>
          <Ionicons name={includeAI ? 'checkbox' : 'square-outline'} size={16} color={includeAI ? '#075E54' : '#999'} />
          <Text style={s.optionLabel}>AI Suggest</Text>
          {suggestionsLoading && <ActivityIndicator size="small" color="#075E54" />}
        </TouchableOpacity>
        <TouchableOpacity style={s.optionItem} onPress={() => setHidePrices(!hidePrices)}>
          <Ionicons name={hidePrices ? 'checkbox' : 'square-outline'} size={16} color={hidePrices ? '#075E54' : '#999'} />
          <Text style={s.optionLabel}>Hide Prices</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.optionItem} onPress={() => setSaveNewPrices(!saveNewPrices)}>
          <Ionicons name={saveNewPrices ? 'checkbox' : 'square-outline'} size={16} color={saveNewPrices ? '#075E54' : '#999'} />
          <Text style={s.optionLabel}>Save Prices</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom Action Bar */}
      <SafeAreaView style={s.bottomSafe} edges={['bottom']}>
        <View style={s.bottomBar}>
          <TouchableOpacity style={[s.pdfBtn, selected.size === 0 && s.btnDisabled]} onPress={() => selected.size === 0 ? Alert.alert('', 'Select at least 1 product first') : handleSubmit('pdf')} disabled={!!submitting}>
            {submitting === 'pdf' ? <ActivityIndicator size="small" color="#333" /> : <><Ionicons name="document" size={16} color={selected.size === 0 ? '#BBB' : '#333'} /><Text style={[s.pdfBtnText, selected.size === 0 && s.btnDisabledText]}>PDF</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={[s.shareBtn, selected.size === 0 && s.btnDisabled]} onPress={() => selected.size === 0 ? Alert.alert('', 'Select at least 1 product first') : handleSubmit('share')} disabled={!!submitting}>
            {submitting === 'share' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="share-social" size={16} color={selected.size === 0 ? '#BBB' : '#FFF'} /><Text style={[s.shareBtnText, selected.size === 0 && s.btnDisabledText]}>Share</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={[s.waBtn, selected.size === 0 && s.btnDisabled]} onPress={() => selected.size === 0 ? Alert.alert('', 'Select at least 1 product first') : handleSubmit('whatsapp')} disabled={!!submitting}>
            {submitting === 'whatsapp' ? <ActivityIndicator size="small" color="#FFF" /> : <><Ionicons name="logo-whatsapp" size={16} color={selected.size === 0 ? '#BBB' : '#FFF'} /><Text style={[s.waBtnText, selected.size === 0 && s.btnDisabledText]}>WhatsApp</Text></>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Header three-dot menu */}
      <Modal visible={headerMenuVisible} transparent animationType="fade" onRequestClose={() => setHeaderMenuVisible(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' }} onPress={() => setHeaderMenuVisible(false)}>
          <View style={{ position: 'absolute', top: 60, right: 12, backgroundColor: '#FFF', borderRadius: 12, paddingVertical: 8, minWidth: 200, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 8 }}>
            {[
              { label: 'Add Product', icon: 'add-circle-outline', onPress: () => { setHeaderMenuVisible(false); openAddForm(); } },
              { label: viewMode === 'grid' ? 'List View' : 'Grid View', icon: viewMode === 'grid' ? 'list-outline' : 'grid-outline', onPress: () => { setViewMode(v => v === 'grid' ? 'list' : 'grid'); setHeaderMenuVisible(false); } },
              { label: 'Import Products', icon: 'cloud-upload-outline', onPress: () => { setHeaderMenuVisible(false); Alert.alert('Coming Soon', 'Import Products from photo, PDF, or document.'); } },
              { label: 'Archived Products', icon: 'archive-outline', onPress: () => { setHeaderMenuVisible(false); loadArchived(); setArchivedVisible(true); } },
              { label: 'Generate Catalog PDF', icon: 'document-text-outline', onPress: () => { setHeaderMenuVisible(false); handleSubmit('pdf'); } },
            ].map(item => (
              <TouchableOpacity key={item.label} onPress={item.onPress} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
                <Ionicons name={item.icon as any} size={20} color="#333" />
                <Text style={{ fontSize: 15, color: '#333' }}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Long press product menu */}
      <Modal visible={longPressMenuVisible} transparent animationType="fade" onRequestClose={() => setLongPressMenuVisible(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' }} onPress={() => setLongPressMenuVisible(false)}>
          <View style={{ backgroundColor: '#FFF', borderRadius: 16, paddingVertical: 8, minWidth: 220, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#666', paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' }}>
              {longPressProduct?.name}
            </Text>
            <TouchableOpacity onPress={() => longPressProduct && openEditForm(longPressProduct)}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}>
              <Ionicons name="create-outline" size={20} color="#075E54" />
              <Text style={{ fontSize: 15, color: '#333' }}>Edit Product</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => longPressProduct && handleUpdatePhoto(longPressProduct)}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}>
              <Ionicons name="camera-outline" size={20} color="#075E54" />
              <Text style={{ fontSize: 15, color: '#333' }}>Update Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => longPressProduct && handleArchive(longPressProduct)}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}>
              <Ionicons name="archive-outline" size={20} color="#E53935" />
              <Text style={{ fontSize: 15, color: '#E53935' }}>Archive Product</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Archived Products Modal */}
      <Modal visible={archivedVisible} transparent animationType="slide" onRequestClose={() => setArchivedVisible(false)}>
        <View style={s.archivedOverlay}>
          <View style={s.archivedSheet}>
            <View style={s.archivedHeader}>
              <Text style={s.archivedTitle}>Archived Products</Text>
              <TouchableOpacity onPress={() => setArchivedVisible(false)} style={{ padding: 6 }}>
                <Ionicons name="close" size={22} color="#333" />
              </TouchableOpacity>
            </View>
            {archivedLoading ? (
              <ActivityIndicator size="large" color="#075E54" style={{ marginTop: 40 }} />
            ) : archivedProducts.length === 0 ? (
              <View style={s.archivedEmpty}>
                <Text style={s.archivedEmptyText}>No archived products</Text>
              </View>
            ) : (
              <ScrollView>
                {archivedProducts.map(p => (
                  <View key={p.id} style={s.archivedRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.archivedName}>{p.name}</Text>
                      <Text style={s.archivedCat}>{p.category || 'Uncategorized'}</Text>
                    </View>
                    <TouchableOpacity style={s.unarchiveBtn} onPress={() => handleUnarchive(p.id)}>
                      <Text style={s.unarchiveBtnText}>Restore</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Product Form Sheet — Add / Edit */}
      <ProductFormSheet
        visible={formVisible}
        mode={formMode}
        initialValues={formInitialValues}
        categories={categories}
        onSubmit={handleFormSubmit}
        onDismiss={() => setFormVisible(false)}
        loading={formLoading}
      />
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
  selectAllBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  selectAllText: { fontSize: 13, color: '#075E54', fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  btnDisabledText: { color: '#999' },
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
  catGroup: { marginBottom: 20 },
  catHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10, backgroundColor: '#E8F5E9', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: '#075E54' },
  catCheckbox: { padding: 2 },
  catName: { flex: 1, fontSize: 14, fontWeight: '700', color: '#075E54', textTransform: 'uppercase', letterSpacing: 0.5 },
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
  optionsStrip: { flexDirection: 'row', backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#F0F0F0', paddingHorizontal: 12, paddingVertical: 6, gap: 4 },
  optionItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6 },
  optionLabel: { fontSize: 11, color: '#555', fontWeight: '500' },
  archivedOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  archivedSheet: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '75%', paddingBottom: 30 },
  archivedHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  archivedTitle: { fontSize: 16, fontWeight: '700', color: '#1A1A1A' },
  archivedEmpty: { alignItems: 'center', paddingVertical: 50 },
  archivedEmptyText: { fontSize: 14, color: '#999' },
  archivedRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  archivedName: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  archivedCat: { fontSize: 12, color: '#999', marginTop: 2 },
  unarchiveBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: '#E8F5E9', borderWidth: 1, borderColor: '#075E54' },
  unarchiveBtnText: { fontSize: 13, fontWeight: '600', color: '#075E54' },
  bottomSafe: { backgroundColor: '#FFF' },
  bottomBar: { flexDirection: 'row', backgroundColor: '#FFF', paddingVertical: 10, paddingHorizontal: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  pdfBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#F5F5F5' },
  pdfBtnText: { fontSize: 14, fontWeight: '600', color: '#333' },
  shareBtn: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#075E54' },
  shareBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
  waBtn: { flex: 1.2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 10, backgroundColor: '#25D366' },
  waBtnText: { fontSize: 14, fontWeight: '600', color: '#FFF' },
});
