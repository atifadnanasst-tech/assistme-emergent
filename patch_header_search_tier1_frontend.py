#!/usr/bin/env python3
"""
Patch: Header Search Tier 1 frontend. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
-> "Home Menu Audit" -> Header Search.

WhatsApp-style interaction: tapping the (previously inert) search icon
expands the header into a search input, replacing the "AssistMe" title.
Typing (debounced 350ms, same pattern as the Tutorials & Help screen)
calls GET /api/customers/search and shows matching customers in a dropdown
below the header. Tapping a result navigates to /chat/[customer_id].
Tapping the close (X) or clearing the query collapses back to normal.

Tier 1 scope only -- customer name/phone/company search. Tier 2 (full
message-content search across all chats) is documented separately as its
own future scoped session (needs a new tsvector index on the write-heavy
messages table -- deliberately not rushed here).
"""

import sys

PATH = "frontend/app/home.tsx"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

anchor_a = """  const [showThreeDotMenu, setShowThreeDotMenu] = useState(false);"""

new_a = """  const [showThreeDotMenu, setShowThreeDotMenu] = useState(false);
  // ── Header Search, Tier 1 (Home Menu Audit) ──
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; name: string; phone: string | null; company: string | null; outstanding_balance: number }>>([]);
  const [searching, setSearching] = useState(false);"""

replacements.append(("A", anchor_a, new_a))

anchor_b = """  const insightStrip = homeData?.insight_strip;
  const insightCards = homeData?.insight_cards || [];

  return ("""

new_b = """  const insightStrip = homeData?.insight_strip;
  const insightCards = homeData?.insight_cards || [];

  // Header Search, Tier 1 — debounced customer search (350ms, same pattern
  // as the Tutorials & Help screen). Empty query clears results without a
  // network call.
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

  return ("""

replacements.append(("B", anchor_b, new_b))

anchor_c = """      {/* Header SafeAreaView */}
      <SafeAreaView style={styles.headerSafeArea} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>AssistMe</Text>
          <View style={styles.headerIcons}>
            {/* Search: build item (near-term) — left visible/inert per audit decision (a) */}
            <TouchableOpacity style={styles.headerIcon}>
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
              <Ionicons name="ellipsis-vertical" size={24} color="#FFFFFF" />"""

new_c = """      {/* Header SafeAreaView */}
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
              <Text style={styles.headerTitle}>AssistMe</Text>
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
                  <Ionicons name="ellipsis-vertical" size={24} color="#FFFFFF" />"""

replacements.append(("C", anchor_c, new_c))

anchor_c2 = """            </TouchableOpacity>
          </View>
        </View>

        {/* Filter Tabs */}"""

new_c2 = """                </TouchableOpacity>
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

        {/* Filter Tabs */}"""

replacements.append(("C2", anchor_c2, new_c2))

anchor_d = """  comingSoonBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#999999',
    letterSpacing: 0.3,
  },"""

new_d = """  comingSoonBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#999999',
    letterSpacing: 0.3,
  },
  // Header Search, Tier 1 (Home Menu Audit).
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
  },"""

replacements.append(("D", anchor_d, new_d))

for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Header Search Tier 1 frontend patch applied successfully (A, B, C, C2, D).")
