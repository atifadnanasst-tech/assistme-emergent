import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../../lib/auth';

// Tutorials & Help — Home Menu Audit, Step 2. Read-only help center that
// searches/lists the help_articles registry (shipped v1.3.400) via
// GET /api/help-articles. Search-only UX: full list on open, filters as you
// type. Tapping an article expands its step-by-step guide + pitfalls.

interface HelpStep {
  screen?: string;
  text?: string;
}
interface HelpArticle {
  slug: string;
  title: string;
  category?: string;
  steps?: HelpStep[];
  pitfalls?: string[];
}

export default function TutorialsHelp() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchArticles = useCallback(async (q: string, isSearch: boolean) => {
    try {
      if (isSearch) setSearching(true);
      const token = await authService.getAccessToken();
      if (!token) {
        router.back();
        return;
      }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const url = q.trim()
        ? `${backendUrl}/api/help-articles?q=${encodeURIComponent(q.trim())}`
        : `${backendUrl}/api/help-articles`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setArticles(data.articles || []);
      }
    } catch (err) {
      console.error('Load help articles error:', err);
    } finally {
      setLoading(false);
      setSearching(false);
    }
  }, [router]);

  // Initial full list
  useEffect(() => {
    fetchArticles('', false);
  }, [fetchArticles]);

  // Debounced search as the user types
  useEffect(() => {
    if (loading) return; // skip during initial load
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchArticles(query, true);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchArticles, loading]);

  const toggle = (slug: string) => {
    setExpandedSlug(prev => (prev === slug ? null : slug));
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Tutorials & Help</Text>
      </View>

      {/* Search box */}
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={18} color="#999" style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search help (e.g. create invoice)"
          placeholderTextColor="#999"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')}>
            <Ionicons name="close-circle" size={18} color="#BBB" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          {searching && (
            <View style={styles.searchingRow}>
              <ActivityIndicator size="small" color="#075E54" />
            </View>
          )}

          {!searching && articles.length === 0 && (
            <View style={styles.emptyWrap}>
              <Ionicons name="help-circle-outline" size={40} color="#CCC" />
              <Text style={styles.emptyText}>
                {query.trim()
                  ? "No help article matches that yet."
                  : "No help articles available."}
              </Text>
            </View>
          )}

          {articles.map((article) => {
            const isOpen = expandedSlug === article.slug;
            return (
              <View key={article.slug} style={styles.card}>
                <TouchableOpacity style={styles.cardHeader} onPress={() => toggle(article.slug)}>
                  <Ionicons name="book-outline" size={20} color="#075E54" style={{ marginRight: 12 }} />
                  <Text style={styles.cardTitle}>{article.title}</Text>
                  <Ionicons
                    name={isOpen ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color="#999"
                  />
                </TouchableOpacity>

                {isOpen && (
                  <View style={styles.cardBody}>
                    {(article.steps || []).map((step, i) => (
                      <View key={i} style={styles.stepRow}>
                        <Text style={styles.stepNum}>{i + 1}</Text>
                        <View style={{ flex: 1 }}>
                          {!!step.screen && <Text style={styles.stepScreen}>{step.screen}</Text>}
                          <Text style={styles.stepText}>{step.text}</Text>
                        </View>
                      </View>
                    ))}

                    {(article.pitfalls || []).length > 0 && (
                      <View style={styles.pitfallsWrap}>
                        <Text style={styles.pitfallsHeading}>Good to know</Text>
                        {(article.pitfalls || []).map((p, i) => (
                          <View key={i} style={styles.pitfallRow}>
                            <Ionicons name="bulb-outline" size={14} color="#B8860B" style={{ marginRight: 6, marginTop: 2 }} />
                            <Text style={styles.pitfallText}>{p}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backBtn: { marginRight: 12 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#222', padding: 0 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { flex: 1, paddingHorizontal: 12, paddingTop: 8 },
  searchingRow: { paddingVertical: 12, alignItems: 'center' },
  emptyWrap: { alignItems: 'center', paddingTop: 60 },
  emptyText: { marginTop: 12, fontSize: 14, color: '#999', textAlign: 'center' },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    marginBottom: 10,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: '#222' },
  cardBody: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
    paddingTop: 12,
  },
  stepRow: { flexDirection: 'row', marginBottom: 12 },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E8F5E9',
    color: '#075E54',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 22,
    marginRight: 10,
  },
  stepScreen: { fontSize: 11, fontWeight: '600', color: '#888', marginBottom: 2 },
  stepText: { fontSize: 14, color: '#333', lineHeight: 20 },
  pitfallsWrap: {
    marginTop: 4,
    backgroundColor: '#FFFDF5',
    borderRadius: 8,
    padding: 10,
  },
  pitfallsHeading: { fontSize: 12, fontWeight: '700', color: '#B8860B', marginBottom: 6 },
  pitfallRow: { flexDirection: 'row', marginBottom: 4 },
  pitfallText: { flex: 1, fontSize: 13, color: '#665500', lineHeight: 18 },
});
