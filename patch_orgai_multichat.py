#!/usr/bin/env python3
"""
Patch: Org AI multi-chat parity (Task B of Org AI v1-Completion). See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI v1-Completion".

Ports the proven multi-conversation dropdown/switcher pattern from
Customer AI (chat/[customer_id].tsx) onto the Org AI screen (ai.tsx).
Backend needs NO changes -- /api/home/ai-conversations GET (list) and
POST (create) already exist and mirror the customer-level endpoints
exactly. This is purely frontend wiring.

5 changes to frontend/app/ai.tsx:
  A. State: aiConversations list, showConvDropdown, loadingConversations.
  B. loadConversation(): store the FULL conversation list (previously
     discarded everything except the first conversation's id).
  C. New functions createNewAiConversation() + switchAiConversation(),
     adapted from the customer chat donor pattern -- switching also resets
     the pagination cursor state (hasMore/oldestTimestamp) which the
     customer version doesn't have to deal with the same way. Reuses the
     existing normalizeOrgAiMessage() helper instead of duplicating the
     mapping.
  D. Header: title area becomes tappable with a chevron to toggle the
     dropdown; dropdown overlay JSX inserted after the header (New Chat
     button + conversation list, same layout as customer chat).
  E. Styles: convDropdown* styles ported verbatim from customer chat
     (identical visual language across both AI surfaces), with top offset
     adjusted for Org AI's shorter header (no tab bar below it).
"""

import sys

PATH = "frontend/app/ai.tsx"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# ─────────────────────────────────────────────────────────────────────────
# A. State additions
# ─────────────────────────────────────────────────────────────────────────
anchor_a = """  const [confirmingPlanId, setConfirmingPlanId] = useState<string | null>(null);
  const [selectingEntityId, setSelectingEntityId] = useState<string | null>(null);"""

new_a = """  const [confirmingPlanId, setConfirmingPlanId] = useState<string | null>(null);
  const [selectingEntityId, setSelectingEntityId] = useState<string | null>(null);
  // ── Multi-conversation support (Org AI v1-Completion, Task B) ──
  // Same pattern as Customer AI (chat/[customer_id].tsx). Backend
  // endpoints /api/home/ai-conversations (GET list / POST create)
  // already existed -- this is purely frontend wiring.
  const [aiConversations, setAiConversations] = useState<Array<{ id: string; title: string | null; created_at: string }>>([]);
  const [showConvDropdown, setShowConvDropdown] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);"""

replacements.append(("A", anchor_a, new_a))

# ─────────────────────────────────────────────────────────────────────────
# B. loadConversation stores the full list
# ─────────────────────────────────────────────────────────────────────────
anchor_b = """      const listData = await listRes.json();
      let convId: string | null = null;
      if (listData.conversations && listData.conversations.length > 0) {
        convId = listData.conversations[0].id;
      } else {
        // Step 2: No conversation exists — create one
        const createRes = await fetch(`${backendUrl}/api/home/ai-conversations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        const createData = await createRes.json();
        convId = createData.conversation?.id || null;
      }"""

new_b = """      const listData = await listRes.json();
      let convId: string | null = null;
      if (listData.conversations && listData.conversations.length > 0) {
        // Multi-chat: keep the full list for the dropdown switcher
        setAiConversations(listData.conversations);
        convId = listData.conversations[0].id;
      } else {
        // Step 2: No conversation exists — create one
        const createRes = await fetch(`${backendUrl}/api/home/ai-conversations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        const createData = await createRes.json();
        convId = createData.conversation?.id || null;
        if (createData.conversation) {
          setAiConversations([createData.conversation]);
        }
      }"""

replacements.append(("B", anchor_b, new_b))

# ─────────────────────────────────────────────────────────────────────────
# C. New conversation-management functions (inserted before
#    normalizeOrgAiMessage)
# ─────────────────────────────────────────────────────────────────────────
anchor_c = """  // ── normalizeOrgAiMessage — canonical message shape ─────────"""

new_c = """  // ── Multi-conversation management (Org AI v1-Completion, Task B) ──
  // Adapted from Customer AI's createNewAiConversation/switchAiConversation
  // (chat/[customer_id].tsx). Differences from the donor: switching here
  // also resets the cursor-pagination state (hasMore/oldestTimestamp),
  // and message loading reuses normalizeOrgAiMessage() rather than
  // duplicating the mapping inline.
  const loadMessagesForConversation = async (convId: string) => {
    const token = await getToken();
    if (!token) return;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const msgRes = await fetch(`${backendUrl}/api/home/ai-messages?ai_conversation_id=${convId}&limit=30`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!msgRes.ok) return;
    const msgData = await msgRes.json();
    if (msgData.messages && msgData.messages.length > 0) {
      const mapped = msgData.messages.map(normalizeOrgAiMessage);
      setMessages(mapped);
      setHasMore(msgData.has_more || false);
      if (mapped.length > 0) setOldestTimestamp(mapped[mapped.length - 1].created_at);
    } else {
      setMessages([]);
      setHasMore(false);
      setOldestTimestamp(null);
    }
  };

  const createNewAiConversation = async () => {
    if (loadingConversations) return;
    setLoadingConversations(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/home/ai-conversations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Chat' }),
      });
      if (res.ok) {
        const data = await res.json();
        const newConv = data.conversation;
        if (newConv) {
          setAiConversations(prev => [newConv, ...prev]);
          setConversationId(newConv.id);
          setShowConvDropdown(false);
          setMessages([]);
          setHasMore(false);
          setOldestTimestamp(null);
        }
      }
    } catch (err) {
      console.error('createNewAiConversation error:', err);
    } finally {
      setLoadingConversations(false);
    }
  };

  const switchAiConversation = async (convId: string) => {
    if (convId === conversationId) {
      setShowConvDropdown(false);
      return;
    }
    setConversationId(convId);
    setShowConvDropdown(false);
    setMessages([]); // clear immediately before fetch
    setHasMore(false);
    setOldestTimestamp(null);
    await loadMessagesForConversation(convId);
  };

  // ── normalizeOrgAiMessage — canonical message shape ─────────"""

replacements.append(("C", anchor_c, new_c))

# ─────────────────────────────────────────────────────────────────────────
# D. Header trigger + dropdown overlay JSX
# ─────────────────────────────────────────────────────────────────────────
anchor_d = """          <Ionicons name="sparkles" size={22} color="#FFFFFF" />
          <View style={styles.headerTextGroup}>
            <Text style={styles.headerTitle}>AI</Text>
            <Text style={styles.headerSubtitle}>Your business assistant</Text>
          </View>
          <TouchableOpacity style={styles.headerMenuBtn}>
            <Ionicons name="ellipsis-vertical" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Category tabs */}"""

new_d = """          <Ionicons name="sparkles" size={22} color="#FFFFFF" />
          <TouchableOpacity
            style={[styles.headerTextGroup, { flexDirection: 'row', alignItems: 'center' }]}
            onPress={() => setShowConvDropdown(prev => !prev)}
            activeOpacity={0.7}
          >
            <View>
              <Text style={styles.headerTitle}>AI</Text>
              <Text style={styles.headerSubtitle}>Your business assistant</Text>
            </View>
            <Ionicons
              name={showConvDropdown ? 'chevron-up' : 'chevron-down'}
              size={14}
              color="#FFFFFF"
              style={{ marginLeft: 6 }}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerMenuBtn}>
            <Ionicons name="ellipsis-vertical" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Conversation dropdown — floating overlay (ported from Customer AI) */}
      {showConvDropdown && (
        <TouchableOpacity
          style={styles.convDropdownOverlay}
          onPress={() => setShowConvDropdown(false)}
          activeOpacity={1}
        >
          <TouchableOpacity style={styles.convDropdownContainer} activeOpacity={1} onPress={() => {}}>
            <TouchableOpacity
              style={styles.convDropdownNewBtn}
              onPress={createNewAiConversation}
              disabled={loadingConversations}
            >
              <Ionicons name="create-outline" size={16} color="#075E54" />
              <Text style={styles.convDropdownNewBtnText}>New Chat</Text>
            </TouchableOpacity>
            <View style={styles.convDropdownDivider} />
            <ScrollView style={styles.convDropdownList} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {aiConversations.map((conv) => (
                <TouchableOpacity
                  key={conv.id}
                  style={[styles.convDropdownItem, conv.id === conversationId && styles.convDropdownItemActive]}
                  onPress={() => switchAiConversation(conv.id)}
                >
                  <Text style={[styles.convDropdownItemTitle, conv.id === conversationId && styles.convDropdownItemTitleActive]} numberOfLines={1} ellipsizeMode="tail">
                    {conv.title || new Date(conv.created_at).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Category tabs */}"""

replacements.append(("D", anchor_d, new_d))

# ─────────────────────────────────────────────────────────────────────────
# E. Styles (ported from Customer AI, top offset adapted for Org AI header)
# ─────────────────────────────────────────────────────────────────────────
anchor_e = """  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#FFFFFF' },
  headerSubtitle: { fontSize: 12, color: '#FFFFFFCC' },"""

new_e = """  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#FFFFFF' },
  headerSubtitle: { fontSize: 12, color: '#FFFFFFCC' },
  // Conversation dropdown styles — ported verbatim from Customer AI
  // (chat/[customer_id].tsx) for identical visual language across both AI
  // surfaces. top offset adapted: Org AI header is shorter (no tab bar).
  convDropdownOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 1000,
    elevation: 20,
  },
  convDropdownContainer: {
    position: 'absolute',
    top: 100,
    left: 8,
    width: 240,
    backgroundColor: '#FFF',
    borderRadius: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    paddingVertical: 4,
    zIndex: 1001,
  },
  convDropdownNewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  convDropdownNewBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#075E54',
    marginLeft: 8,
  },
  convDropdownDivider: {
    height: 1,
    backgroundColor: '#EEEEEE',
    marginHorizontal: 12,
  },
  convDropdownList: {
    maxHeight: 220,
  },
  convDropdownItem: {
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  convDropdownItemActive: {
    backgroundColor: '#E8F5E9',
  },
  convDropdownItemTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#333',
  },
  convDropdownItemTitleActive: {
    color: '#075E54',
    fontWeight: '600',
  },"""

replacements.append(("E", anchor_e, new_e))

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

print("All 5 patches applied successfully (A, B, C, D, E).")
