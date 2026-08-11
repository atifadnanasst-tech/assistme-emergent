#!/usr/bin/env python3
"""
Patch: Home screen frontend pagination wiring (Patch 2). See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Pagination /
Enrichment Cost" for full context. Builds on the backend pipeline reorder
(v1.3.396) which added offset/has_more/next_offset to /api/home.

4 changes to frontend/app/home.tsx:
  A. HomeData interface: adds has_more, next_offset, returned (optional --
     backend always sends them now, but kept optional so older cached
     responses / offline states don't break type-checking).
  B. New state: isLoadingMore, tracks in-flight "load more" requests
     separately from the initial/refresh loading state.
  C. New loadMoreConversations() function: fetches the next page using
     next_offset, appends to existing conversations (does NOT replace
     homeData, unlike loadHomeData/refresh), keeps filter_tabs/insight_strip
     from the current homeData since those don't change page to page.
  D. FlatList: wires onEndReached to loadMoreConversations, adds a loading
     footer (ActivityIndicator) visible only while a page fetch is in
     flight.
"""

import sys

PATH = "frontend/app/home.tsx"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# ─────────────────────────────────────────────────────────────────────────
# A. HomeData interface — add pagination fields
# ─────────────────────────────────────────────────────────────────────────
anchor_a = """interface HomeData {
  insight_strip: InsightStrip | null;
  insight_cards: InsightCard[];
  filter_tabs: FilterTab[];
  conversations: Conversation[];
  subscription_plan?: string;
  language?: string | null;
}"""

new_a = """interface HomeData {
  insight_strip: InsightStrip | null;
  insight_cards: InsightCard[];
  filter_tabs: FilterTab[];
  conversations: Conversation[];
  has_more?: boolean;
  next_offset?: number | null;
  returned?: number;
  subscription_plan?: string;
  language?: string | null;
}"""

replacements.append(("A", anchor_a, new_a))

# ─────────────────────────────────────────────────────────────────────────
# B. New loading-more state
# ─────────────────────────────────────────────────────────────────────────
anchor_b = """  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);"""

new_b = """  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Home screen pagination (v1.3.397) -- tracked separately from
  // loading/refreshing so the footer spinner only shows for "load more",
  // not for the initial load or pull-to-refresh.
  const [isLoadingMore, setIsLoadingMore] = useState(false);"""

replacements.append(("B", anchor_b, new_b))

# ─────────────────────────────────────────────────────────────────────────
# C. loadMoreConversations() -- inserted right before handleTabPress
# ─────────────────────────────────────────────────────────────────────────
anchor_c = """  const handleTabPress = (tabId: string) => {"""

new_c = """  // Home screen pagination (v1.3.397). See
  // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Pagination /
  // Enrichment Cost". Unlike loadHomeData (which replaces homeData
  // entirely -- used for initial load, refresh, and tab switches), this
  // APPENDS the next page onto the existing conversations list, since
  // filter_tabs/insight_strip/insight_cards don't change page to page.
  const loadMoreConversations = async () => {
    if (isLoadingMore || !homeData?.has_more || homeData?.next_offset == null) {
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
      const url = `${base}${filterTab ? '&' : '?'}offset=${homeData.next_offset}`;

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

      setHomeData(prev => {
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

  const handleTabPress = (tabId: string) => {"""

replacements.append(("C", anchor_c, new_c))

# ─────────────────────────────────────────────────────────────────────────
# D. FlatList -- wire onEndReached + loading footer
# ─────────────────────────────────────────────────────────────────────────
anchor_d = """      <FlatList
        data={conversations}
        renderItem={renderConversationItem}
        keyExtractor={(item) => item.customer_id}
        onScrollBeginDrag={() => setInsightExpanded(false)}
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
          </View>
        }
        contentContainerStyle={conversations.length === 0 && styles.emptyListContent}
      />"""

new_d = """      <FlatList
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
      />"""

replacements.append(("D", anchor_d, new_d))

# ─────────────────────────────────────────────────────────────────────────
# Apply with match-count validation
# ─────────────────────────────────────────────────────────────────────────
for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("All 4 patches applied successfully (A, B, C, D).")
