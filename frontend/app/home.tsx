import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useNavigation, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';
import { getLanguageLabel, DEFAULT_LANGUAGE } from '../constants/languages';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
let Contacts: any = null;
try { Contacts = require('expo-contacts'); } catch { Contacts = null; }

interface FilterTab {
  id: string;
  name: string;
  count: number | null;
  is_custom: boolean;
}

interface InsightStrip {
  content: string;
  items: Array<{ id: string; text: string; completed: boolean }>;
}
interface InsightCard {
  type: 'collections' | 'deliveries' | 'my_tasks';
  label: string;
  count: number;
  tab: 'watchlist' | 'mytasks';
}

interface Conversation {
  customer_id: string;
  name: string;
  initials: string;
  avatar_color: string;
  last_message: string;
  last_message_at: string;
  outstanding_amount: number | null;
  is_overdue: boolean;
  unread_count: number;
  health_score: number | null;
  payable_amount: number | null;
  is_payable_overdue: boolean;
  net_position: number;
  net_direction: 'receivable' | 'payable' | 'settled';
}

interface HomeData {
  insight_strip: InsightStrip | null;
  insight_cards: InsightCard[];
  filter_tabs: FilterTab[];
  conversations: Conversation[];
  has_more?: boolean;
  next_offset?: number | null;
  returned?: number;
  subscription_plan?: string;
  language?: string | null;
}

export default function HomeScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  
  const insets = useSafeAreaInsets();
  // Home FAB redesign, Phase 1 -- Add Contact + Set Reminder only. Voice
  // Reminder is deliberately NOT included yet: its real pipeline (Audio
  // Intelligence Primitive, transcription, AI extraction, confirmation
  // sheet) doesn't exist yet, and a visible button for something the
  // owner can't actually use isn't shipped here -- it gets added as its
  // own complete, reviewed patch once Phase 2 actually lands.
  const [fabExpanded, setFabExpanded] = useState(false);
  // refreshing stays a SEPARATE local state from useQuery's own
  // isFetching -- isFetching is also true during background polling and
  // realtime-triggered refetches, which would make the pull-to-refresh
  // spinner appear unexpectedly every 30s. refreshing is deliberately
  // only ever set by the user's actual pull gesture (see handleRefresh).
  const [refreshing, setRefreshing] = useState(false);
  // Home screen pagination (v1.3.399) -- tracked separately from
  // loading/refreshing so the footer spinner only shows for "load more",
  // not for the initial load or pull-to-refresh.
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showThreeDotMenu, setShowThreeDotMenu] = useState(false);
  // ── Header Search, Tier 1 (Home Menu Audit) ──
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; name: string; phone: string | null; company: string | null; outstanding_balance: number }>>([]);
  const [searching, setSearching] = useState(false);

  // Header Search, Tier 1 — debounced customer search (350ms, same pattern
  // as the Tutorials & Help screen). Empty query clears results without a
  // network call. MOVED HERE (hotfix): must be unconditional, before the
  // `if (loading && !homeData) return (...)` early return below -- every
  // hook must run in the same order on every render (Rules of Hooks).
  // Placing it after that early return caused a white-screen crash on
  // launch, since the hook wasn't called during the initial loading render
  // but WAS called on the next render once data arrived.
  useEffect(() => {
    if (!searchActive) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const token = await authService.getAccessToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl}/api/customers/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          setSearchResults(json.customers || []);
        }
      } catch (err) {
        console.error('Customer search error:', err);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery, searchActive]);

  const closeSearch = () => {
    setSearchActive(false);
    setSearchQuery('');
    setSearchResults([]);
  };
  const [showToolsSheet, setShowToolsSheet] = useState(false);
  // Must be in the state block, not after the early return at line ~400
  // (if loading && !homeData) -- a useState after that return causes
  // "Rendered more hooks than during previous render" crash.
  const [insightExpanded, setInsightExpanded] = useState(false);
  // Collapse on blur (leaving Home) and on scroll -- three ways to close:
  // tap strip again, tap bullet, leave screen, or scroll away.
  useFocusEffect(useCallback(() => {
    return () => setInsightExpanded(false);
  }, []));

  const channelRef = useRef<any>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Phase 2 of the TanStack Offline Cache Sprint (AssistMe_Offline_Cache_
  // Handover.md). Query key includes the active filter tab so each tab
  // (All/Dues/Quotes) caches independently -- switching tabs shows that
  // tab's own last-known data instantly rather than blocking on a
  // network round trip, and works offline if that tab was ever
  // successfully loaded before.
  //
  // MUST be declared before debouncedLoadHomeData below -- a real bug,
  // found via Atif's on-device testing, had homeQuery declared AFTER
  // debouncedLoadHomeData while debouncedLoadHomeData's dependency array
  // already referenced homeQuery.refetch, throwing "Cannot read property
  // 'refetch' of undefined" on every single render. This ordering is
  // deliberate and load-bearing -- do not move this block back down.
  const queryClient = useQueryClient();
  const homeQueryKey = ['home-customers', activeTab || 'all'];
  const homeQuery = useQuery({
    queryKey: homeQueryKey,
    queryFn: async () => {
      let token = await authService.getAccessToken();
      if (!token) {
        const refreshed = await authService.refreshSession();
        if (!refreshed) throw new Error('AUTH_REQUIRED');
        token = await authService.getAccessToken();
        if (!token) throw new Error('AUTH_REQUIRED');
      }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const filterTab = activeTab === 'all' ? undefined : activeTab;
      const url = filterTab
        ? `${backendUrl}/api/home?filter=${filterTab}`
        : `${backendUrl}/api/home`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (response.status === 401) throw new Error('UNAUTHORIZED');
        if (!response.ok) throw new Error('Failed to load home data');
        return (await response.json()) as HomeData;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  });

  const debouncedLoadHomeData = useCallback((_tabId?: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      homeQuery.refetch();
    }, 500);
  }, [homeQuery.refetch]);

  const syncContactNames = async (conversations: any[]) => {
    if (!Contacts) return;
    try {
      const { status } = await Contacts.getPermissionsAsync();
      if (status !== 'granted') return;
      const { data: deviceContacts } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
      });
      if (!deviceContacts || deviceContacts.length === 0) return;
      const phoneMap: Record<string, string> = {};
      deviceContacts.forEach((contact: any) => {
        if (!contact.name || !contact.phoneNumbers) return;
        contact.phoneNumbers.forEach((pn: any) => {
          if (!pn.number) return;
          const normalized = pn.number.replace(/\D/g, '');
          if (normalized.length >= 10) {
            phoneMap[normalized.slice(-10)] = contact.name;
          }
        });
      });
      if (Object.keys(phoneMap).length === 0) return;
      const token = await authService.getAccessToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      for (const conv of conversations) {
        const name = conv.name || '';
        const isPhonePattern = /^[0-9+\s()-]{7,15}$/.test(name.trim());
        if (!isPhonePattern) continue;
        const digits = name.replace(/\D/g, '');
        if (digits.length < 10) continue;
        const last10 = digits.slice(-10);
        const contactName = phoneMap[last10];
        if (!contactName) continue;
        try {
          await fetch(`${backendUrl}/api/customers/${conv.customer_id}/name`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: contactName }),
          });
          console.log('[CONTACTS] Updated ' + name + ' -> ' + contactName);
        } catch (err) {
          console.warn('[CONTACTS] Update failed:', err);
        }
      }
    } catch (err) {
      console.warn('[CONTACTS] Sync failed:', err);
    }
  };

  // v5-correct pattern for query-success side effects (onSuccess was
  // removed in TanStack Query v5 -- confirmed via TanStack's own
  // migration guide). query.data's reference is stable/memoized by the
  // library and only changes when genuinely new data arrives, so this
  // effect does not re-run on every render.
  useEffect(() => {
    if (homeQuery.data?.conversations && homeQuery.data.conversations.length > 0) {
      syncContactNames(homeQuery.data.conversations);
    }
  }, [homeQuery.data]);

  // v5-correct pattern for query-error side effects (onError removed in
  // v5, same reasoning as above). Preserves the EXACT prior 401/auth
  // handling -- AUTH_REQUIRED (no valid token, refresh failed) sends
  // straight to login; UNAUTHORIZED (server says the session itself is
  // invalid) does a full sign-out first, matching loadHomeData's
  // original behavior exactly.
  useEffect(() => {
    if (!homeQuery.error) return;
    const msg = (homeQuery.error as Error).message;
    if (msg === 'AUTH_REQUIRED') {
      router.replace('/login');
    } else if (msg === 'UNAUTHORIZED') {
      (async () => {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
      })();
    } else {
      console.error('Load home data error:', homeQuery.error);
    }
  }, [homeQuery.error]);

  useEffect(() => {
    const setupRealtime = async () => {
      const orgId = await authService.getOrganisationId();
      if (!orgId) return;

      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }

      const tabForRefresh = activeTab === 'all' ? undefined : activeTab || undefined;

      channelRef.current = supabase
        .channel(`org-${orgId}`)
        .on('broadcast', { event: 'message_created' }, () => {
          console.log('[REALTIME] Broadcast received on home');
          debouncedLoadHomeData(tabForRefresh);
        })
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `organisation_id=eq.${orgId}`,
          },
          () => {
            console.log('[REALTIME] postgres_changes received on home');
            debouncedLoadHomeData(tabForRefresh);
          }
        )
        .subscribe();

      pollingRef.current = setInterval(() => {
        debouncedLoadHomeData(tabForRefresh);
      }, 30000);
    };

    setupRealtime();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      const tabForRefresh = activeTab === 'all' ? undefined : activeTab || undefined;
      debouncedLoadHomeData(tabForRefresh);
    });
    return unsubscribe;
  }, [navigation, activeTab]);

  // Home screen pagination (v1.3.399). See
  // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Pagination /
  // Enrichment Cost". Unlike loadHomeData (which replaces homeData
  // entirely -- used for initial load, refresh, and tab switches), this
  // APPENDS the next page onto the existing conversations list, since
  // filter_tabs/insight_strip/insight_cards don't change page to page.
  const loadMoreConversations = async () => {
    if (isLoadingMore || !homeQuery.data?.has_more || homeQuery.data?.next_offset == null) {
      return;
    }

    setIsLoadingMore(true);
    try {
      let token = await authService.getAccessToken();
      if (!token) {
        setIsLoadingMore(false);
        return;
      }

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const filterTab = activeTab && activeTab !== 'all' ? activeTab : undefined;
      const base = filterTab
        ? `${backendUrl}/api/home?filter=${filterTab}`
        : `${backendUrl}/api/home`;
      const url = `${base}${filterTab ? '&' : '?'}offset=${homeQuery.data.next_offset}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('Failed to load more conversations');
      }

      const data: HomeData = await response.json();

      queryClient.setQueryData(homeQueryKey, (prev: HomeData | undefined) => {
        if (!prev) return data;
        return {
          ...prev,
          conversations: [...prev.conversations, ...(data.conversations || [])],
          has_more: data.has_more,
          next_offset: data.next_offset,
          returned: (prev.returned ?? prev.conversations.length) + (data.returned ?? (data.conversations || []).length),
        };
      });

      if (data.conversations && data.conversations.length > 0) {
        syncContactNames(data.conversations);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('Load more timeout');
      } else {
        console.error('Load more conversations error:', error);
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleTabPress = (tabId: string) => {
    if (tabId === activeTab) {
      // Same tab tapped again -- force a fresh fetch for this tab.
      homeQuery.refetch();
    } else {
      // Changing activeTab changes homeQuery's queryKey (['home-customers',
      // activeTab]) -- useQuery automatically fetches the new tab's data,
      // or shows its cached data instantly if this tab was loaded before.
      // No explicit fetch call needed here, unlike the original code.
      setActiveTab(tabId);
    }
  };

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await homeQuery.refetch();
    setRefreshing(false);
  }, [homeQuery.refetch]);

  const handleLogout = async () => {
    try {
      const token = await authService.getAccessToken();
      if (token) {
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        await fetch(`${backendUrl}/api/auth/sign-out`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
      }
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      router.replace('/login');
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (diffHours < 24) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'long' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const renderConversationItem = ({ item }: { item: Conversation }) => (
    <TouchableOpacity
      style={styles.conversationRow}
      onPress={() => router.push(`/chat/${item.customer_id}`)}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: item.avatar_color }]}>
        <Text style={styles.avatarText}>{item.initials}</Text>
      </View>

      {/* Content */}
      <View style={styles.conversationContent}>
        <View style={styles.conversationHeader}>
          <Text style={styles.customerName} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.timestamp}>
            {formatTimestamp(item.last_message_at)}
          </Text>
        </View>

        <View style={styles.conversationFooter}>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.last_message}
          </Text>
          
          {/* Badges — 4 states:
               receivable + within terms = grey
               receivable + overdue      = red
               payable    + within terms = amber
               payable    + overdue      = dark amber */}
          <View style={styles.badges}>
            {item.net_direction !== 'settled' && Math.abs(item.net_position || 0) > 0 && (
              <View style={[
                styles.amountBadge,
                item.net_direction === 'receivable' && item.is_overdue && styles.amountBadgeOverdue,
                item.net_direction === 'payable' && !item.is_payable_overdue && styles.amountBadgePayable,
                item.net_direction === 'payable' && item.is_payable_overdue && styles.amountBadgePayableOverdue,
              ]}>
                <Text style={[
                  styles.amountText,
                  item.net_direction === 'receivable' && item.is_overdue && styles.amountTextOverdue,
                  item.net_direction === 'payable' && !item.is_payable_overdue && styles.amountTextPayable,
                  item.net_direction === 'payable' && item.is_payable_overdue && styles.amountTextPayableOverdue,
                ]}>
                  {item.net_direction === 'payable' ? 'You owe ₹' : '₹'}{Math.abs(item.net_position || 0).toLocaleString('en-IN')}
                </Text>
              </View>
            )}
            
            {item.unread_count > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadText}>{item.unread_count}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  if (homeQuery.isLoading && !homeQuery.data) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>AssistMe</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  const conversations = homeQuery.data?.conversations || [];
  const filterTabs = homeQuery.data?.filter_tabs || [];
  const insightStrip = homeQuery.data?.insight_strip;
  const insightCards = homeQuery.data?.insight_cards || [];
  // "Last synced" indicator (TanStack Offline Cache Sprint, Phase 2) --
  // dataUpdatedAt is a built-in TanStack Query field, the timestamp of
  // the last successful fetch for this exact query key.
  const lastSyncedText = homeQuery.dataUpdatedAt
    ? (() => {
        const mins = Math.round((Date.now() - homeQuery.dataUpdatedAt) / 60000);
        if (mins < 1) return 'Last synced just now';
        if (mins === 1) return 'Last synced 1 min ago';
        if (mins < 60) return `Last synced ${mins} mins ago`;
        const hrs = Math.round(mins / 60);
        return `Last synced ${hrs} hr${hrs === 1 ? '' : 's'} ago`;
      })()
    : null;

  return (
    <>
      {/* Header SafeAreaView */}
      <SafeAreaView style={styles.headerSafeArea} edges={['top']}>
        <View style={styles.header}>
          {searchActive ? (
            // Header Search, Tier 1 (Home Menu Audit) — WhatsApp-style: title
            // area replaced by an input while search is active.
            <View style={styles.searchBarRow}>
              <TextInput
                style={styles.searchBarInput}
                placeholder="Search customers..."
                placeholderTextColor="#FFFFFFAA"
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
                autoCorrect={false}
              />
              <TouchableOpacity onPress={closeSearch} style={styles.headerIcon}>
                <Ionicons name="close" size={24} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View>
                <Text style={styles.headerTitle}>AssistMe</Text>
                {/* "Last synced" indicator (TanStack Offline Cache Sprint,
                    Phase 2). Per Atif's explicit request: only shown when
                    currently offline (fetchStatus:'paused' -- a real,
                    built-in TanStack Query signal set when a network
                    request has genuinely failed and retries are paused,
                    confirmed via TanStack's own docs before using it, no
                    new package/native build needed). Not shown while
                    online/synced -- no value in cluttering the header
                    with information that's only actually useful during
                    an outage. */}
                {lastSyncedText && homeQuery.fetchStatus === 'paused' && (
                  <Text style={styles.lastSyncedSubtitle}>{lastSyncedText}</Text>
                )}
              </View>
              <View style={styles.headerIcons}>
                <TouchableOpacity style={styles.headerIcon} onPress={() => setSearchActive(true)}>
                  <Ionicons name="search-outline" size={24} color="#FFFFFF" />
                </TouchableOpacity>
                {/* MUTED-v1: checkmark-done header icon — dead button, no user-expected
                    meaning, no implementation. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
                    -> "Home Menu Audit". Restore only if a real mark-all-read/filter is built.
                <TouchableOpacity style={styles.headerIcon}>
                  <Ionicons name="checkmark-done-outline" size={24} color="#FFFFFF" />
                </TouchableOpacity>
                */}
                <TouchableOpacity 
                  style={styles.headerIcon}
                  onPress={() => setShowThreeDotMenu(true)}
                >
                  <Ionicons name="ellipsis-vertical" size={24} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        {/* Header Search, Tier 1 — results dropdown, only when search is active */}
        {searchActive && searchQuery.trim().length > 0 && (
          <View style={styles.searchResultsWrap}>
            {searching ? (
              <View style={styles.searchResultsLoading}>
                <ActivityIndicator size="small" color="#075E54" />
              </View>
            ) : searchResults.length === 0 ? (
              <Text style={styles.searchNoResults}>No customers match "{searchQuery.trim()}"</Text>
            ) : (
              searchResults.map((cust) => (
                <TouchableOpacity
                  key={cust.id}
                  style={styles.searchResultRow}
                  onPress={() => {
                    closeSearch();
                    router.push(`/chat/${cust.id}`);
                  }}
                >
                  <Ionicons name="person-circle-outline" size={32} color="#075E54" />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={styles.searchResultName}>{cust.name}</Text>
                    {!!cust.phone && <Text style={styles.searchResultSub}>{cust.phone}</Text>}
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {/* Filter Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterTabsContainer}
          contentContainerStyle={styles.filterTabsContent}
        >
          {/* All tab (always first) */}
          <TouchableOpacity
            style={[
              styles.filterTab,
              activeTab === 'all' && styles.filterTabActive
            ]}
            onPress={() => handleTabPress('all')}
          >
            <Text style={[
              styles.filterTabText,
              activeTab === 'all' && styles.filterTabTextActive
            ]}>
              All
            </Text>
          </TouchableOpacity>

          {/* Other tabs (skip "All" since it's hardcoded above) */}
          {filterTabs.filter((tab) => tab.name !== 'All').map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.filterTab,
                activeTab === tab.id && styles.filterTabActive
              ]}
              onPress={() => handleTabPress(tab.id)}
            >
              <Text style={[
                styles.filterTabText,
                activeTab === tab.id && styles.filterTabTextActive
              ]}>
                {tab.name}
              </Text>
              {tab.count !== null && tab.count > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{tab.count}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}

          {/* MUTED-v1: pill "+" add-custom-list button — dead button (no onPress);
              the customer-bucketing feature it implies is unbuilt (same feature as
              the Lists menu entry). Hidden until bucketing ships. See
              ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit".
          <TouchableOpacity style={styles.addTabButton}>
            <Ionicons name="add" size={20} color="#075E54" />
          </TouchableOpacity>
          */}
        </ScrollView>

        {/* Insight Strip -- expandable yellow banner. Shows live counts
            when backend returns insight_cards; falls back to morning-brief
            text otherwise. insightExpanded state is in the hook block
            above the early return to avoid hooks-order crash. */}
        {insightCards.length > 0 ? (
          <TouchableOpacity style={styles.insightStrip} onPress={() => setInsightExpanded(!insightExpanded)} activeOpacity={0.8}>
            <Ionicons name="bulb" size={20} color="#8B6914" />
            <Text style={styles.insightText}>
              {insightCards[0]?.type === 'collections'
                ? `⚠️ ${insightCards[0].count} collections overdue as of today`
                : insightCards[0]?.type === 'deliveries'
                ? `🚚 ${insightCards[0].count} deliveries pending dispatch today`
                : `✅ ${insightCards[0]?.count} follow-ups pending as of today`}
              {insightCards.length > 1 ? ` · +${insightCards.length - 1} more` : ''}
            </Text>
            <Ionicons name={insightExpanded ? 'chevron-up' : 'chevron-down'} size={18} color="#8B6914" />
          </TouchableOpacity>
        ) : insightStrip && insightStrip.content ? (
          <TouchableOpacity
            style={styles.insightStrip}
            activeOpacity={0.7}
            onPress={() => router.push('/activity')}
          >
            <Ionicons name="bulb" size={20} color="#8B6914" />
            <Text style={styles.insightText} numberOfLines={2}>
              {insightStrip.content}
            </Text>
            <Text style={styles.insightDetails}>Details ›</Text>
          </TouchableOpacity>
        ) : null}
        {insightExpanded && insightCards.length > 0 && (
          <View style={styles.insightExpanded}>
            {insightCards.map(card => (
              <TouchableOpacity
                key={card.type}
                style={styles.insightBullet}
                onPress={() => { setInsightExpanded(false); router.push({ pathname: '/activity', params: { tab: card.tab } }); }}
                activeOpacity={0.7}
              >
                <Text style={styles.insightBulletIcon}>
                  {card.type === 'collections' ? '⚠️' : card.type === 'deliveries' ? '🚚' : '✅'}
                </Text>
                <Text style={styles.insightBulletText}>{card.label}</Text>
                <Ionicons name="chevron-forward" size={14} color="#8B6914" />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </SafeAreaView>

      {/* Conversation List */}
      <FlatList
        data={conversations}
        renderItem={renderConversationItem}
        keyExtractor={(item) => item.customer_id}
        onScrollBeginDrag={() => setInsightExpanded(false)}
        onEndReached={loadMoreConversations}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={['#075E54']}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="chatbubbles-outline" size={64} color="#CCCCCC" />
            <Text style={styles.emptyStateText}>No conversations yet</Text>
            <Text style={styles.emptyStateSubtext}>
              Add your first customer to get started
            </Text>
            <TouchableOpacity onPress={() => router.push('/settings/profile')} activeOpacity={0.7} style={{ marginTop: 8 }}>
              <Text style={[styles.emptyStateSubtext, { color: '#075E54', textDecorationLine: 'underline' }]}>
                or set up your Business Profile (Tools {'>'} Business Profile)
              </Text>
            </TouchableOpacity>
          </View>
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View style={{ paddingVertical: 20 }}>
              <ActivityIndicator size="small" color="#075E54" />
            </View>
          ) : null
        }
        contentContainerStyle={conversations.length === 0 && styles.emptyListContent}
      />

      {/* FAB -- expandable, Google Calendar style. "Add Contact" keeps its
          exact original behavior and route. Tap-outside (the backdrop)
          closes the menu. Known UX enhancement, deferred: hardware back
          button doesn't close the menu first -- it falls through to
          Home's default back behavior instead. Not a correctness issue,
          no data loss, can be added as its own focused patch later. */}
      {fabExpanded && (
        <Pressable style={styles.fabBackdrop} onPress={() => setFabExpanded(false)}>
          <View style={styles.fabPills}>
            <TouchableOpacity
              style={styles.fabPill}
              onPress={() => { setFabExpanded(false); router.push('/voice-reminder'); }}
            >
              <Ionicons name="mic" size={20} color="#075E54" />
              <Text style={styles.fabPillText}>Voice Reminder</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.fabPill}
              onPress={() => { setFabExpanded(false); router.push('/task-detail'); }}
            >
              <Ionicons name="checkbox-outline" size={20} color="#075E54" />
              <Text style={styles.fabPillText}>Set Reminder</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.fabPill}
              onPress={() => { setFabExpanded(false); router.push('/customer/new'); }}
            >
              <Ionicons name="person-add-outline" size={20} color="#075E54" />
              <Text style={styles.fabPillText}>Add Contact</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      )}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setFabExpanded(!fabExpanded)}
      >
        <Ionicons name={fabExpanded ? 'close' : 'add'} size={28} color="#FFFFFF" />
      </TouchableOpacity>

      <Text style={{ textAlign: "center", fontSize: 10, color: "#CCC", paddingVertical: 2 }}>v1.3.440</Text>
      {/* Bottom Navigation SafeAreaView */}
      <SafeAreaView style={styles.bottomNavSafeArea} edges={['bottom']}>
        <View style={styles.bottomNav}>
          <TouchableOpacity style={styles.navItemActive}>
            <View style={styles.navItemActivePill}>
              <Ionicons name="chatbubbles" size={24} color="#FFFFFF" />
              <Text style={styles.navItemTextActive}>Chats</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.navItem}
            onPress={() => router.push('/products')}
          >
            <Ionicons name="cube-outline" size={24} color="#667781" />
            <Text style={styles.navItemText}>Products</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.navItem}
            onPress={() => setShowToolsSheet(true)}
          >
            <Ionicons name="settings-outline" size={24} color="#667781" />
            <Text style={styles.navItemText}>Tools</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.navItem}
            onPress={() => router.push('/ai')}
          >
            <Ionicons name="sparkles-outline" size={24} color="#667781" />
            <Text style={styles.navItemText}>AI</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* 3-Dot Menu Overlay */}
      <Modal
        visible={showThreeDotMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowThreeDotMenu(false)}
      >
        <TouchableOpacity 
          style={styles.menuOverlay}
          activeOpacity={1}
          onPress={() => setShowThreeDotMenu(false)}
        >
          {/* 3-dot menu rebuilt as an Operations hub (Home Menu Audit).
              Categorized for structure; all items are roadmap-committed and
              currently frozen "Coming soon" (non-navigating). Dashboard flips
              to a live entry when its screen is built. Removed vs. old menu:
              New Group (hidden), See Inventory (redundant with Products nav),
              Settings (lives on the bottom Tools sheet).
              MUTED-v1 removed items preserved as comments at end of this block. */}
          <View style={styles.menuCard}>
            <Text style={styles.menuSection}>BUSINESS OPERATIONS</Text>
            {/* Dashboard: live as of Tier 1 build (Home Menu Audit). Was
                frozen "Coming soon" — no longer, per that section's own
                stated plan ("flips to a live entry when its screen is
                built"). Tier 2 (downloadable reports) still pending. */}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/dashboard');
              }}
            >
              <Ionicons name="stats-chart-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Dashboard</Text>
            </TouchableOpacity>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="megaphone-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Broadcast</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>ORGANISE</Text>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="list-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Lists</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>ACCESS & GROWTH</Text>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="phone-portrait-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Linked Devices</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>
            <View style={[styles.menuItem, styles.comingSoonRow]}>
              <Ionicons name="gift-outline" size={20} color="#B0B0B0" />
              <Text style={styles.comingSoonItemText}>Refer & Earn</Text>
              <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
            </View>

            {/* MUTED-v1 (Home Menu Audit) — removed from this menu:
                New Group: WhatsApp-style group chat, not needed for AssistMe (hidden).
                See Inventory: redundant — Products is the bottom-nav 2nd tab.
                Settings: lives on the bottom Tools sheet (setShowToolsSheet).
                Note: "Invite Team Members" was a mislabel — it is a REFERRAL feature,
                now correctly named "Refer & Earn" above (distinct from staff/roles). */}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Tools Bottom Sheet */}
      <Modal
        visible={showToolsSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowToolsSheet(false)}
      >
        <TouchableOpacity 
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setShowToolsSheet(false)}
        >
          <View style={styles.sheetContainer}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Settings & more</Text>
            
            <ScrollView style={styles.sheetContent} contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}>
              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/profile'); }}>
                <Ionicons name="briefcase-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Business profile</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              {/* Manage staff & roles — coming-soon (frozen). Real feature
                  (multi-user, permissions) worth advertising; unbuilt in v1. */}
              <View style={[styles.sheetItem, styles.comingSoonRow]}>
                <Ionicons name="people-outline" size={24} color="#B0B0B0" />
                <Text style={styles.comingSoonSheetText}>Manage staff & roles</Text>
                <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
              </View>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/billing'); }}>
                <Ionicons name="card-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Subscription & billing</Text>
                {homeQuery.data?.subscription_plan && (
                  <View style={styles.planBadge}>
                    <Text style={styles.planBadgeText}>{homeQuery.data.subscription_plan.toUpperCase()}</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              {/* MUTED-v1 (Home Menu Audit): "Smart Catalogs" (-> /settings/catalogs)
                  hidden — redundant with the Products screen (bottom-nav 2nd tab,
                  the intentionally-built one with import + 3-dot tools). This route
                  led to a loosely-similar inferior page. Restore only if a distinct
                  catalog-config surface is ever needed.
              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/catalogs'); }}>
                <Ionicons name="book-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Smart Catalogs</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>
              */}

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/business-preferences'); }}>
                <Ionicons name="notifications-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Business Preferences</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              {/* Appearance — coming-soon (frozen) with descriptive badge.
                  Current theme (Green–Cream) is intentional; more themes are roadmap. */}
              <View style={[styles.sheetItem, styles.comingSoonRow]}>
                <Ionicons name="color-palette-outline" size={24} color="#B0B0B0" />
                <Text style={styles.comingSoonSheetText}>Appearance</Text>
                <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Green–Cream · more coming soon</Text></View>
              </View>

              {/* Add Social Media — coming-soon (frozen). Owner wants it; unbuilt in v1. */}
              <View style={[styles.sheetItem, styles.comingSoonRow]}>
                <Ionicons name="share-social-outline" size={24} color="#B0B0B0" />
                <Text style={styles.comingSoonSheetText}>Add Social Media</Text>
                <View style={styles.comingSoonBadge}><Text style={styles.comingSoonBadgeText}>Coming soon</Text></View>
              </View>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/export'); }}>
                <Ionicons name="download-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Export my data</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/help'); }}>
                <Ionicons name="help-circle-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Tutorials & help</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/language'); }}>
                <Ionicons name="language-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Language</Text>
                <Text style={styles.sheetItemValue}>{getLanguageLabel(homeQuery.data?.language || DEFAULT_LANGUAGE)}</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/disclaimer'); }}>
                <Ionicons name="document-text-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Disclaimer</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <View style={styles.sheetDivider} />

              <TouchableOpacity style={styles.sheetItemDanger} onPress={handleLogout}>
                <Ionicons name="log-out-outline" size={24} color="#D32F2F" />
                <Text style={styles.sheetItemTextDanger}>Sign out</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  headerSafeArea: {
    backgroundColor: '#075E54',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerIcons: {
    flexDirection: 'row',
    gap: 16,
  },
  lastSyncedSubtitle: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#FFFFFFAA',
    marginTop: 2,
  },
  headerIcon: {
    padding: 4,
  },
  filterTabsContainer: {
    backgroundColor: '#075E54',
  },
  filterTabsContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    borderWidth: 1,
    borderColor: '#FFFFFF',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginRight: 8,
  },
  filterTabActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#075E54',
  },
  filterTabText: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  filterTabTextActive: {
    color: '#075E54',
  },
  tabBadge: {
    backgroundColor: '#D32F2F',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    paddingHorizontal: 6,
  },
  tabBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  addTabButton: {
    width: 40,
    height: 40,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  insightExpanded: {
    backgroundColor: '#FFF8E1',
    paddingHorizontal: 16,
    paddingBottom: 6,
    borderTopWidth: 1,
    borderTopColor: '#F0E0A0',
  },
  insightBullet: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0E0A0',
  },
  insightBulletIcon: { fontSize: 15 },
  insightBulletText: { flex: 1, fontSize: 14, color: '#8B6914', fontWeight: '500' },
  insightStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF8E1',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  insightText: {
    flex: 1,
    fontSize: 14,
    color: '#8B6914',
  },
  insightDetails: {
    fontSize: 14,
    color: '#8B6914',
    fontWeight: '600',
  },
  conversationRow: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  conversationContent: {
    flex: 1,
    marginLeft: 12,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  customerName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
  timestamp: {
    fontSize: 12,
    color: '#999999',
  },
  conversationFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMessage: {
    flex: 1,
    fontSize: 14,
    color: '#667781',
  },
  badges: {
    flexDirection: 'row',
    gap: 8,
  },
  amountBadge: {
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  amountBadgeOverdue: {
    backgroundColor: '#FFF0F0',
  },
  amountBadgePayable: {
    backgroundColor: '#FFF8E1',
  },
  amountBadgePayableOverdue: {
    backgroundColor: '#FFF3E0',
  },
  amountText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888888',
  },
  amountTextOverdue: {
    color: '#D32F2F',
  },
  amountTextPayable: {
    color: '#F57C00',
  },
  amountTextPayableOverdue: {
    color: '#E65100',
  },
  unreadBadge: {
    backgroundColor: '#25D366',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyStateText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#999999',
    marginTop: 16,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#CCCCCC',
    marginTop: 8,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  fabBackdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.2)', justifyContent: 'flex-end', alignItems: 'flex-end',
  },
  // bottom: 184 = fab's own bottom (120) + fab's height (56) + an 8px
  // gap -- anchored to the FAB's actual position, not an arbitrary guess,
  // so it stays correct if a 3rd pill (Voice Reminder) is added later
  // (pills stack upward via `gap`, this anchor doesn't need to change).
  fabPills: { position: 'absolute', right: 16, bottom: 184, gap: 10 },
  fabPill: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFF',
    paddingHorizontal: 18, paddingVertical: 12, borderRadius: 24,
    elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
  },
  fabPillText: { fontSize: 15, color: '#1A1A1A', fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 120,
    width: 56,
    height: 56,
    backgroundColor: '#075E54',
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    zIndex: 10,
  },
  bottomNavSafeArea: {
    backgroundColor: '#FFFFFF',
  },
  bottomNav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
  },
  navItem: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  navItemText: {
    fontSize: 12,
    color: '#667781',
    marginTop: 4,
  },
  navItemActive: {
    alignItems: 'center',
  },
  navItemActivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 6,
  },
  navItemTextActive: {
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 60,
    paddingRight: 16,
  },
  menuCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    minWidth: 250,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  menuSection: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999999',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 16,
  },
  menuItemText: {
    fontSize: 14,
    color: '#333333',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#F0F0F0',
    marginVertical: 8,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#CCCCCC',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333333',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sheetContent: {
    paddingBottom: 16,
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 16,
  },
  sheetItemText: {
    flex: 1,
    fontSize: 16,
    color: '#333333',
  },
  sheetItemTextDisabled: {
    flex: 1,
    fontSize: 16,
    color: '#BBBBBB',
  },
  sheetItemValueDisabled: {
    fontSize: 14,
    color: '#BBBBBB',
    marginRight: 4,
  },
  planBadge: {
    backgroundColor: '#075E54',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
    marginRight: 8,
  },
  planBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  comingSoonRow: {
    opacity: 0.55,
  },
  comingSoonItemText: {
    flex: 1,
    fontSize: 15,
    color: '#B0B0B0',
    marginLeft: 12,
  },
  comingSoonSheetText: {
    flex: 1,
    fontSize: 16,
    color: '#B0B0B0',
    marginLeft: 12,
  },
  comingSoonBadge: {
    backgroundColor: '#EEEEEE',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  comingSoonBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#999999',
    letterSpacing: 0.3,
  },
  searchBarRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchBarInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  searchResultsWrap: {
    backgroundColor: '#FFFFFF',
    maxHeight: 320,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    zIndex: 999,
  },
  searchResultsLoading: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  searchNoResults: {
    padding: 16,
    fontSize: 13,
    color: '#999999',
    textAlign: 'center',
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
  },
  searchResultName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#222222',
  },
  searchResultSub: {
    fontSize: 12,
    color: '#888888',
    marginTop: 2,
  },
  sheetDivider: {
    height: 1,
    backgroundColor: '#F0F0F0',
    marginVertical: 8,
  },
  sheetItemDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 16,
  },
  sheetItemTextDanger: {
    flex: 1,
    fontSize: 16,
    color: '#D32F2F',
    fontWeight: '600',
  },
});
