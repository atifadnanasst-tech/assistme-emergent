#!/usr/bin/env python3
"""
Patch: get_latest_messages_per_conversation() RPC — Home Screen message
truncation fix. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen
Message Truncation Bug" for full diagnosis.

PREREQUISITE: the get_latest_messages_per_conversation() Postgres function
and its supporting index must already exist in Supabase (already done and
verified against real org data — 28 rows returned, matching device count).

Replaces the fetch-all-messages-then-group-in-JS block in /api/home with a
single RPC call that returns at most one row per conversation, so the
result size scales with conversation count, never with total message
volume. Eliminates the silent PostgREST db-max-rows truncation that was
dropping conversations from every filter pill's rendered list (not just
"All"), regardless of their resolveSystemFilter badge count being correct.
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

anchor = """    // Query 3: Get latest message per conversation (DISTINCT ON pattern)
    const conversationIds = conversations?.map(c => c.id) || [];
    
    console.log('🔍 [HOME] Step 3: Conversation IDs for messages query');
    console.log('  - Count:', conversationIds.length);
    console.log('  - IDs:', conversationIds);
    
    let latestMessages = [];
    if (conversationIds.length > 0) {
      console.log('🔍 [HOME] Step 4: Executing messages query...');
      
      const { data: messages, error: messagesError } = await supabase
        .from('messages')
        .select('conversation_id, content, created_at, role, metadata')
        .in('conversation_id', conversationIds)
        .order('conversation_id')
        .order('created_at', { ascending: false });

      console.log('  - Messages error:', messagesError ? messagesError.message : 'none');
      console.log('  - Messages count:', messages?.length || 0);
      console.log('  - Sample messages:', messages?.slice(0, 3));

      if (!messagesError && messages) {
        // Group by conversation_id and take first (most recent)
        const messagesByConv = {};
        messages.forEach(msg => {
          if (!messagesByConv[msg.conversation_id]) {
            messagesByConv[msg.conversation_id] = msg;
          }
        });
        latestMessages = Object.values(messagesByConv);
        
        console.log('🔍 [HOME] Step 5: Latest messages grouped');
        console.log('  - Unique conversations with messages:', latestMessages.length);
        console.log('  - Mapping:', Object.keys(messagesByConv));
      }
    }"""

new = """    // Query 3: Get latest message per conversation
    // v2 fix: uses get_latest_messages_per_conversation() RPC (DISTINCT ON,
    // one row per conversation) instead of fetching ALL messages and
    // grouping in JS. The old approach was silently truncated by
    // PostgREST's db-max-rows cap, sorted by conversation_id (a UUID --
    // unrelated to recency), so some conversations lost ALL their messages
    // from the result set even though they had real chat history -- this
    // dropped them from every filter pill's rendered list, not just "All".
    // RPC result size scales with conversation count, never with total
    // message volume, so the row cap can no longer truncate it. See
    // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Message
    // Truncation Bug" for full diagnosis, and the v2 WhatsApp-style
    // conversation-summary direction noted there for the next evolution.
    const conversationIds = conversations?.map(c => c.id) || [];

    console.log('🔍 [HOME] Step 3: Conversation IDs for latest-message RPC');
    console.log('  - Count:', conversationIds.length);

    let latestMessages = [];
    if (conversationIds.length > 0) {
      const { data: rpcMessages, error: rpcError } = await supabase
        .rpc('get_latest_messages_per_conversation', {
          p_organisation_id: organisationId,
          p_conversation_ids: conversationIds,
        });

      console.log('  - RPC error:', rpcError ? rpcError.message : 'none');
      console.log('  - RPC result count:', rpcMessages?.length || 0);

      if (!rpcError && rpcMessages) {
        latestMessages = rpcMessages;
      } else if (rpcError) {
        console.error('get_latest_messages_per_conversation RPC failed:', rpcError);
      }
    }"""

count = content.count(anchor)
if count != 1:
    print(f"ABORT: anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("get_latest_messages_per_conversation RPC patch applied successfully.")
