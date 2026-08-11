#!/usr/bin/env python3
"""
Patch: Org AI conversation title parity (companion to the ai.tsx
multi-chat port — Task B of Org AI v1-Completion). See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI v1-Completion".

Problem: the org-level POST /api/home/ai-conversations hardcodes
title: 'Business Assistant' and there is no auto-title mechanism — so with
the new multi-chat dropdown, every conversation would display the exact
same name, making them indistinguishable. The customer-level surface
solves this with title: null at creation + auto-title from the first
query (backend/src/index.js ~line 5084). This patch ports that exact
behavior to the org surface.

3 changes to backend/src/services/ai/orgAi/routes.js:
  A. POST /api/home/ai-conversations: title null at creation (dropdown
     falls back to created-at datetime until auto-titled — same as
     Customer AI).
  B. ai-query convCheck: also select title (needed by C; zero extra query).
  C. ai-query: after saving the user message, auto-title the conversation
     from the first meaningful query if title is still empty/default —
     ported from the customer-level implementation, including treating
     legacy 'Business Assistant' titles as auto-titleable so existing
     conversations get real names on their next query.
"""

import sys

PATH = "backend/src/services/ai/orgAi/routes.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# ─────────────────────────────────────────────────────────────────────────
# A. POST: title null at creation
# ─────────────────────────────────────────────────────────────────────────
anchor_a = """          title: 'Business Assistant',"""

new_a = """          // Title parity with Customer AI: null at creation, auto-titled
          // from the first query in the ai-query handler. Dropdown shows
          // created-at datetime until then.
          title: null,"""

replacements.append(("A", anchor_a, new_a))

# ─────────────────────────────────────────────────────────────────────────
# B. convCheck: also fetch title
# ─────────────────────────────────────────────────────────────────────────
anchor_b = """      const { data: convCheck } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', ai_conversation_id)
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .maybeSingle();

      if (!convCheck) return c.json({ error: 'invalid_ai_conversation_id' }, 403);"""

new_b = """      const { data: convCheck } = await supabase
        .from('ai_conversations')
        .select('id, title')
        .eq('id', ai_conversation_id)
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .maybeSingle();

      if (!convCheck) return c.json({ error: 'invalid_ai_conversation_id' }, 403);"""

replacements.append(("B", anchor_b, new_b))

# ─────────────────────────────────────────────────────────────────────────
# C. Auto-title from first query (ported from customer-level index.js)
# ─────────────────────────────────────────────────────────────────────────
anchor_c = """      if (userMsgError) console.error('[orgAi] user message insert failed:', userMsgError.message);"""

new_c = """      if (userMsgError) console.error('[orgAi] user message insert failed:', userMsgError.message);

      // Auto-title parity with Customer AI (backend/src/index.js): if the
      // conversation has no real title yet, name it from the first query
      // (max 40 chars). 'Business Assistant' and 'New Chat' are treated as
      // default/empty so legacy conversations also get real names on
      // their next query. Fire-and-forget: title failure never blocks the
      // query itself.
      try {
        const currentTitle = (convCheck.title || '').trim();
        if (!currentTitle || currentTitle === 'Business Assistant' || currentTitle === 'New Chat') {
          const firstQuery = userContent.substring(0, 40).trim();
          const autoTitle = firstQuery.length < userContent.length ? firstQuery + '...' : firstQuery;
          if (autoTitle) {
            await supabase
              .from('ai_conversations')
              .update({ title: autoTitle })
              .eq('id', ai_conversation_id)
              .eq('organisation_id', organisationId);
          }
        }
      } catch (titleErr) {
        console.warn('[orgAi] auto-title failed (non-blocking):', titleErr.message);
      }"""

replacements.append(("C", anchor_c, new_c))

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

print("All 3 patches applied successfully (A, B, C).")
