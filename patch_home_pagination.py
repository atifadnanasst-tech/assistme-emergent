#!/usr/bin/env python3
"""
Patch: Home screen pipeline reorder — sort/paginate BEFORE expensive
per-conversation enrichment. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md ->
"Home Screen Pagination / Enrichment Cost" for full context.

Problem: the old pipeline enriched EVERY conversation (an overdue-invoice
query + an unread-count query per conversation) before slicing to `limit`.
Enrichment cost scaled with total conversation count, not with what's
actually shown -- expensive and it made the hardcoded limit=50 the only
thing standing between a fast response and a slow/timing-out one.

Fix: reorder into explicit stages (per audit review):
  Stage 1 — load base data (conversations, latest-message RPC, customers)
            [unchanged, already above this block]
  Stage 2 — build a lightweight, unenriched view model per conversation
            (no queries — uses data already in memory)
  Stage 3 — sort by getConversationSortTimestamp()
  Stage 4 — paginate via offset/limit, compute has_more/next_offset
  Stage 5 — enrich ONLY the page slice (the expensive queries now run on
            at most `limit` conversations, not all of them)
  Stage 6 — return response with pagination metadata

Also adds:
  - offset query param (default 0)
  - getConversationSortTimestamp() helper — single place to update when v2
    introduces conversations.last_message_at as a maintained summary field
  - has_more / next_offset / returned in the response, for frontend
    pagination and observability
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# ─────────────────────────────────────────────────────────────────────────
# A. Add offset param alongside limit
# ─────────────────────────────────────────────────────────────────────────
anchor_a = """    const filterTagId = c.req.query('filter');
    const limit = parseInt(c.req.query('limit') || '50', 10);"""

new_a = """    const filterTagId = c.req.query('filter');
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);"""

replacements.append(("A", anchor_a, new_a))

# ─────────────────────────────────────────────────────────────────────────
# B. Replace assemble-everything-then-sort-then-slice with staged pipeline
# ─────────────────────────────────────────────────────────────────────────
anchor_b = """    // Assemble conversation list with UI-ready fields
    const conversationList = [];

    for (const conv of conversations || []) {
      const customer = customers.find(c => c.id === conv.entity_id);
      if (!customer) continue;

      // v1.3.395: messageless conversations are no longer dropped -- see
      // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md "Home Screen Message
      // Truncation Bug" for why (badge/list count parity).
      const latestMsg = latestMessages.find(m => m.conversation_id === conv.id) || null;

      // Compute avatar initials
      const nameParts = customer.name.trim().split(/\s+/);
      const initials = nameParts
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase();

      // Get avatar color from custom_fields
      let avatarColor = '#075E54'; // default
      try {
        if (customer.custom_fields && typeof customer.custom_fields === 'object') {
          avatarColor = customer.custom_fields.avatar_color || '#075E54';
        }
      } catch (err) {
        console.warn('Failed to parse custom_fields:', err);
      }

      // Check if overdue
      let isOverdue = false;
      if (customer.outstanding_balance && customer.outstanding_balance > 0) {
        const { data: overdueInvoices, error: invoiceError } = await supabase
          .from('invoices')
          .select('id')
          .eq('customer_id', customer.id)
          .eq('organisation_id', organisationId)
          .neq('status', 'paid')
          .lt('due_date', new Date().toISOString())
          .limit(1);

        if (!invoiceError && overdueInvoices && overdueInvoices.length > 0) {
          isOverdue = true;
        }
      }

      // Payable overdue — any purchase bill past due date for this entity?
      const isPayableOverdue = payableOverdueSet.has(customer.id);

      // Count unread messages
      let unreadCount = 0;
      try {
        const { data: userMsgs, error: unreadError } = await supabase
          .from('messages')
          .select('metadata')
          .eq('conversation_id', conv.id)
          .eq('role', 'user');

        if (!unreadError && userMsgs) {
          unreadCount = userMsgs.filter(m => {
            const rbo = m.metadata?.read_by_owner;
            // Unread = only explicitly false (boolean or string) — ignore null/absent (old messages)
            return rbo === false || rbo === 'false';
          }).length;
        }

        console.log('🔍 [HOME] Unread for conv', conv.id.slice(-4), ':', unreadCount, '/', (userMsgs?.length || 0));
      } catch (err) {
        console.warn('Unread count query failed:', err);
      }

      // Get health score
      let healthScore = null;
      try {
        if (customer.custom_fields && typeof customer.custom_fields === 'object') {
          healthScore = customer.custom_fields.health_score || null;
        }
      } catch (err) {
        console.warn('Failed to get health_score:', err);
      }

      conversationList.push({
        customer_id: customer.id,
        name: customer.name,
        initials: initials,
        avatar_color: avatarColor,
        last_message: latestMsg ? (latestMsg.content || '') : 'No messages yet',
        last_message_at: latestMsg ? latestMsg.created_at : customer.created_at,
        outstanding_amount: customer.outstanding_balance || null,
        is_overdue: isOverdue,
        unread_count: unreadCount,
        health_score: healthScore,
        payable_amount: payableMap[customer.id] || null,
        is_payable_overdue: isPayableOverdue,
        net_position: Math.round(((customer.outstanding_balance || 0) - (payableMap[customer.id] || 0)) * 100) / 100,
        net_direction: ((customer.outstanding_balance || 0) - (payableMap[customer.id] || 0)) > 0.01 ? 'receivable' : ((payableMap[customer.id] || 0) - (customer.outstanding_balance || 0)) > 0.01 ? 'payable' : 'settled',
      });
    }

    // Sort by last_message_at DESC
    conversationList.sort((a, b) => {
      return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
    });

    // Limit results
    const limitedConversations = conversationList.slice(0, limit);"""

new_b = """    // ── Home Screen Pipeline — staged (v1.3.396) ───────────────────────
    // See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Pagination /
    // Enrichment Cost". Sort/paginate BEFORE enrichment so the expensive
    // per-conversation queries (overdue-invoice check, unread count) run on
    // at most `limit` conversations, not the entire list. This is possible
    // now because the get_latest_messages_per_conversation RPC gives every
    // conversation a timestamp to sort by without touching every message.

    // Single place to update when v2 introduces conversations.last_message_at
    // as a maintained summary field -- only this function needs to change.
    function getConversationSortTimestamp(latestMsg, customer) {
      return latestMsg ? latestMsg.created_at : customer.created_at;
    }

    // Stage 2 — lightweight, unenriched view model (no queries — everything
    // here is already in memory from conversations/customers/latestMessages).
    const lightweightList = [];
    for (const conv of conversations || []) {
      const customer = customers.find(c => c.id === conv.entity_id);
      if (!customer) continue;

      // v1.3.395: messageless conversations are no longer dropped -- see
      // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md "Home Screen Message
      // Truncation Bug" for why (badge/list count parity).
      const latestMsg = latestMessages.find(m => m.conversation_id === conv.id) || null;

      lightweightList.push({
        conv,
        customer,
        latestMsg,
        sort_timestamp: getConversationSortTimestamp(latestMsg, customer),
      });
    }

    // Stage 3 — sort
    lightweightList.sort((a, b) => {
      return new Date(b.sort_timestamp).getTime() - new Date(a.sort_timestamp).getTime();
    });

    // Stage 4 — paginate
    const totalCount = lightweightList.length;
    const pageSlice = lightweightList.slice(offset, offset + limit);
    const hasMore = offset + limit < totalCount;
    const nextOffset = hasMore ? offset + limit : null;

    // Stage 5 — enrich ONLY the page slice
    const conversationList = [];

    for (const { conv, customer, latestMsg } of pageSlice) {
      // Compute avatar initials
      const nameParts = customer.name.trim().split(/\s+/);
      const initials = nameParts
        .slice(0, 2)
        .map(part => part[0])
        .join('')
        .toUpperCase();

      // Get avatar color from custom_fields
      let avatarColor = '#075E54'; // default
      try {
        if (customer.custom_fields && typeof customer.custom_fields === 'object') {
          avatarColor = customer.custom_fields.avatar_color || '#075E54';
        }
      } catch (err) {
        console.warn('Failed to parse custom_fields:', err);
      }

      // Check if overdue
      let isOverdue = false;
      if (customer.outstanding_balance && customer.outstanding_balance > 0) {
        const { data: overdueInvoices, error: invoiceError } = await supabase
          .from('invoices')
          .select('id')
          .eq('customer_id', customer.id)
          .eq('organisation_id', organisationId)
          .neq('status', 'paid')
          .lt('due_date', new Date().toISOString())
          .limit(1);

        if (!invoiceError && overdueInvoices && overdueInvoices.length > 0) {
          isOverdue = true;
        }
      }

      // Payable overdue — any purchase bill past due date for this entity?
      const isPayableOverdue = payableOverdueSet.has(customer.id);

      // Count unread messages
      let unreadCount = 0;
      try {
        const { data: userMsgs, error: unreadError } = await supabase
          .from('messages')
          .select('metadata')
          .eq('conversation_id', conv.id)
          .eq('role', 'user');

        if (!unreadError && userMsgs) {
          unreadCount = userMsgs.filter(m => {
            const rbo = m.metadata?.read_by_owner;
            // Unread = only explicitly false (boolean or string) — ignore null/absent (old messages)
            return rbo === false || rbo === 'false';
          }).length;
        }

        console.log('🔍 [HOME] Unread for conv', conv.id.slice(-4), ':', unreadCount, '/', (userMsgs?.length || 0));
      } catch (err) {
        console.warn('Unread count query failed:', err);
      }

      // Get health score
      let healthScore = null;
      try {
        if (customer.custom_fields && typeof customer.custom_fields === 'object') {
          healthScore = customer.custom_fields.health_score || null;
        }
      } catch (err) {
        console.warn('Failed to get health_score:', err);
      }

      conversationList.push({
        customer_id: customer.id,
        name: customer.name,
        initials: initials,
        avatar_color: avatarColor,
        last_message: latestMsg ? (latestMsg.content || '') : 'No messages yet',
        last_message_at: latestMsg ? latestMsg.created_at : customer.created_at,
        outstanding_amount: customer.outstanding_balance || null,
        is_overdue: isOverdue,
        unread_count: unreadCount,
        health_score: healthScore,
        payable_amount: payableMap[customer.id] || null,
        is_payable_overdue: isPayableOverdue,
        net_position: Math.round(((customer.outstanding_balance || 0) - (payableMap[customer.id] || 0)) * 100) / 100,
        net_direction: ((customer.outstanding_balance || 0) - (payableMap[customer.id] || 0)) > 0.01 ? 'receivable' : ((payableMap[customer.id] || 0) - (customer.outstanding_balance || 0)) > 0.01 ? 'payable' : 'settled',
      });
    }

    // Kept for response compatibility below (Stage 6) — same conversations,
    // already in sorted-page order from Stage 3/4.
    const limitedConversations = conversationList;"""

replacements.append(("B", anchor_b, new_b))

# ─────────────────────────────────────────────────────────────────────────
# C. Response — add pagination metadata
# ─────────────────────────────────────────────────────────────────────────
anchor_c = """    return c.json({
      insight_strip: insightStrip,
      insight_cards: insightCards,
      filter_tabs: filterTabs,
      conversations: limitedConversations,
      subscription_plan: subscriptionPlan,
      language: primaryLanguage,
    });"""

new_c = """    return c.json({
      insight_strip: insightStrip,
      insight_cards: insightCards,
      filter_tabs: filterTabs,
      conversations: limitedConversations,
      has_more: hasMore,
      next_offset: nextOffset,
      returned: limitedConversations.length,
      subscription_plan: subscriptionPlan,
      language: primaryLanguage,
    });"""

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
