#!/usr/bin/env python3
"""
Patch: Messageless conversations no longer dropped from Home screen.
See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Message Truncation
Bug" for why this matters: a conversation with zero messages could still
count toward a system pill badge (e.g. Dues, via resolveSystemFilter, which
checks customers/quotations directly) while never appearing in the actual
rendered card list -- the same badge/list divergence risk this session has
been eliminating everywhere else.

3 changes to backend/src/index.js:
  A. Adds created_at to the customers select, used as a sensible fallback
     sort timestamp for messageless conversations (so they don't render
     with an epoch-1970 date).
  B. Removes the `if (!latestMsg) continue` that silently dropped
     messageless conversations.
  C. Card fields fall back gracefully: last_message becomes "No messages
     yet" (frontend type is already `string`, no frontend change needed),
     last_message_at falls back to customer.created_at so sort order stays
     sensible (messageless customers sort by how long they've been a
     customer, not thrown to a hardcoded date).
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# A. Add created_at to customers select
anchor_a = """        .select('id, name, outstanding_balance, custom_fields')"""
new_a = """        .select('id, name, outstanding_balance, custom_fields, created_at')"""
replacements.append(("A", anchor_a, new_a))

# B. Stop dropping messageless conversations
anchor_b = """      const latestMsg = latestMessages.find(m => m.conversation_id === conv.id);
      if (!latestMsg) continue;"""
new_b = """      // v1.3.395: messageless conversations are no longer dropped -- see
      // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md "Home Screen Message
      // Truncation Bug" for why (badge/list count parity).
      const latestMsg = latestMessages.find(m => m.conversation_id === conv.id) || null;"""
replacements.append(("B", anchor_b, new_b))

# C. Graceful fallback fields
anchor_c = """        last_message: latestMsg.content || '',
        last_message_at: latestMsg.created_at,"""
new_c = """        last_message: latestMsg ? (latestMsg.content || '') : 'No messages yet',
        last_message_at: latestMsg ? latestMsg.created_at : customer.created_at,"""
replacements.append(("C", anchor_c, new_c))

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
