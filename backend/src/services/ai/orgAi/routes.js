/**
 * AssistMe — Org AI Routes
 *
 * Location: /services/ai/orgAi/routes.js
 * Created: 2026-05-21
 * Purpose: 4 routes for Home AI tab.
 *
 * Auth: uses authenticateChat(c) — same pattern as all existing routes.
 *       No JWT middleware assumed. Token validated per-request via Supabase.
 *
 * Routes:
 *   GET  /api/home/ai-conversations     — list org AI conversations
 *   POST /api/home/ai-conversations     — create new org AI conversation
 *   GET  /api/home/ai-messages          — messages for a conversation (ascending)
 *   POST /api/home/ai-query             — menu item dispatch OR freeform stub
 *
 * Permissions note (future):
 *   Owner + Manager roles both permitted for now.
 *   Tier-based restrictions (Dukaan/Saathi/Tajir) to be added when subscription
 *   schema columns are active. No gate added here yet.
 */

import { dispatchMenuQuery } from './index.js';

// ── Server-owned menu labels ──────────────────────────────────
// Backend owns these — never trust frontend-supplied labels.
// Used for: input validation + chat history user bubble content + AI context continuity.
// Any menu_id not in this map is rejected with 400.
// TODO: future refactor — centralize into shared menu registry { id, icon, label }
// Emoji-prefixed to ensure hydration parity with optimistic UI bubbles
const MENU_LABELS = {
  collections_today:      '📥 Collections Today',
  total_outstanding:      '🔴 Total Outstanding',
  top_customers:          '🏆 Top Customers',
  revenue_this_month:     '📊 Revenue This Month',
  invoices_due_this_week: '📋 Invoices Due This Week',
  weekly_trend:           '📈 Weekly Trend',
  follow_up_today:        '📞 Follow Up Today',
  risk_alerts:            '⚠️ Risk Alerts',
  gone_silent:            '🔇 Gone Silent',
  top_sellers:            '⭐ Top Sellers',
  low_stock:              '🔴 Low Stock',
  slow_moving:            '🐌 Slow Moving',
  deliveries_today:       '🚚 Deliveries Today',
  expiring_quotes:        '📄 Expiring Quotes',
  todays_tasks:           "✅ Today's Tasks",
  what_i_owe:             '💸 What I Owe Suppliers',
  overdue_payables:       '⏰ Overdue Payables',
  top_supplier:           '🥇 Top Supplier',
};

export function registerOrgAiRoutes(app, supabase, authenticateChat, getOpenAI) {

  // ── GET /api/home/ai-conversations ───────────────────────────
  app.get('/api/home/ai-conversations', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const { data, error } = await supabase
        .from('ai_conversations')
        .select('id, title, last_message_at, message_count, created_at')
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .is('deleted_at', null)
        .order('last_message_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return c.json({ conversations: data || [] });
    } catch (error) {
      console.error('GET /api/home/ai-conversations error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/ai-conversations ──────────────────────────
  app.post('/api/home/ai-conversations', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const { data, error } = await supabase
        .from('ai_conversations')
        .insert({
          organisation_id: organisationId,
          customer_id: null,
          scope: 'org',
          initiated_by: 'owner',
          title: 'Business Assistant',
        })
        .select('id, title, created_at')
        .single();

      if (error) throw error;
      return c.json({ conversation: data });
    } catch (error) {
      console.error('POST /api/home/ai-conversations error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── GET /api/home/ai-messages ─────────────────────────────────
  // Returns ascending (oldest first) — consistent with customer AI tab.
  app.get('/api/home/ai-messages', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const aiConversationId = c.req.query('ai_conversation_id');
      if (!aiConversationId) return c.json({ error: 'missing_ai_conversation_id' }, 400);

      const { data: convCheck } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', aiConversationId)
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .maybeSingle();

      if (!convCheck) return c.json({ error: 'conversation_not_found' }, 403);

      const { data: msgs, error } = await supabase
        .from('messages')
        .select('id, role, content, canonical_text, input_modality, metadata, created_at, ai_conversation_id')
        .eq('organisation_id', organisationId)
        .eq('ai_conversation_id', aiConversationId)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) throw error;
      return c.json({ messages: msgs || [] });
    } catch (error) {
      console.error('GET /api/home/ai-messages error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ── POST /api/home/ai-query ───────────────────────────────────
  app.post('/api/home/ai-query', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json();
      const { menu_id, message, ai_conversation_id } = body;

      if (!ai_conversation_id) return c.json({ error: 'missing_ai_conversation_id' }, 400);
      if (!menu_id && !message) return c.json({ error: 'missing_menu_id_or_message' }, 400);

      // Validate menu_id against server-owned enum — reject unknown IDs
      if (menu_id && !MENU_LABELS[menu_id]) {
        return c.json({ error: 'invalid_menu_id', valid_ids: Object.keys(MENU_LABELS) }, 400);
      }

      // Verify conversation belongs to this org and is org-scoped
      const { data: convCheck } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', ai_conversation_id)
        .eq('organisation_id', organisationId)
        .eq('scope', 'org')
        .maybeSingle();

      if (!convCheck) return c.json({ error: 'invalid_ai_conversation_id' }, 403);

      // Fetch org currency
      const { data: org } = await supabase
        .from('organisations')
        .select('currency')
        .eq('id', organisationId)
        .maybeSingle();

      const orgCurrency = org?.currency || 'INR';
      const orgLanguage = auth.primaryLanguage || 'en';

      // User bubble content — backend owns menu labels, never frontend
      const userContent = menu_id
        ? MENU_LABELS[menu_id]
        : (message || '');

      // Save user message
      const { error: userMsgError } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          ai_conversation_id,
          role: 'user',
          content: userContent,
          input_modality: 'text',
          metadata: {
            sender_type: 'owner',
            visibility: 'owner_only',
            message_type: 'ai_query',
            preview_text: userContent.substring(0, 50),
            read_by_owner: true,
            menu_id: menu_id || null,
          },
        });
      if (userMsgError) console.error('[orgAi] user message insert failed:', userMsgError.message);

      // Dispatch
      let result;
      if (menu_id) {
        const openai = getOpenAI();
        result = await dispatchMenuQuery(menu_id, supabase, organisationId, orgCurrency, openai, orgLanguage);
      } else {
        result = {
          response_text: 'Freeform business queries are coming soon. Use the menu categories above to explore your business data.',
          chart_data: null,
          next_action: null,
          message_type: 'ai_response',
        };
      }

      // Save AI response message
      const { data: savedMsg, error: aiMsgError } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          ai_conversation_id,
          role: 'assistant',
          content: result.response_text,
          canonical_text: result.response_text,
          input_modality: 'text',
          metadata: {
            sender_type: 'ai',
            visibility: 'owner_only',
            message_type: result.message_type || 'ai_response',
            chart_data: result.chart_data || null,
            next_action: result.next_action || null,
            preview_text: result.response_text.substring(0, 50),
            read_by_owner: true,
            menu_id: menu_id || null,
          },
        })
        .select('id')
        .single();
      if (aiMsgError) console.error('[orgAi] AI response insert failed:', aiMsgError.message);

      // Update conversation last_message_at only — message_count recalculated later
      const { error: convUpdateError } = await supabase
        .from('ai_conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', ai_conversation_id);
      if (convUpdateError) console.error('[orgAi] conversation update failed:', convUpdateError.message);

      return c.json({
        message_id: savedMsg?.id,
        response: result.response_text,
        chart_data: result.chart_data || null,
        next_action: result.next_action || null,
        message_type: result.message_type || 'ai_response',
      });

    } catch (error) {
      console.error('POST /api/home/ai-query error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });
}
