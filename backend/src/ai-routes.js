// AI Routes for AssistMe — Flow 2B
// Backend-controlled AI: DB queries first, AI formats results
// STRICT: tool_choice='required' for all business queries
import OpenAI from 'openai';

// ── Rate limiter (in-memory, per org) ────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(orgId) {
  const now = Date.now();
  let entry = rateLimitMap.get(orgId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimitMap.set(orgId, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ── OpenAI client ────────────────────────────────────────────
let openai = null;
function getOpenAI() {
  if (openai) return openai;
  const key = process.env.EMERGENT_LLM_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.EMERGENT_LLM_BASE_URL || 'https://api.openai.com/v1';
  if (!key) { console.warn('⚠️  No LLM key configured'); return null; }
  openai = new OpenAI({ apiKey: key, baseURL });
  return openai;
}

// ── Tool → card_type mapping (deterministic, not AI-decided) ─
const TOOL_CARD_TYPE_MAP = {
  get_daily_summary: 'daily_summary',
  get_overdue_payments: 'payment_reminder',
  search_customers: 'query_response',
  get_collection_insights: 'collection_insight',
  get_bank_summary: 'bank_summary',
  get_reorder_suggestions: 'reorder_suggestion',
};

// ── System prompt ────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a business data assistant for an Indian MSME trader.
You MUST use tools to answer any business question. NEVER answer from memory.

Available tools:
- get_daily_summary: business summary (payments, deliveries, quotes)
- get_overdue_payments: overdue invoices with customer details
- search_customers: search customers by name
- get_collection_insights: collection efficiency data
- get_bank_summary: bank account balances
- get_reorder_suggestions: low-stock products

RULES:
- ALWAYS call a tool first. Never guess financial data.
- After receiving tool results, write a plain-language summary using ONLY the data returned.
- Amounts are in INR (₹). Format Indian style: ₹1,20,000.
- Never invent numbers, names, or counts.
- If tool returns empty data, say "No records found" — do not fabricate.
- Keep responses concise and actionable.`;

// ── Tool definitions ─────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_daily_summary',
      description: 'Get today\'s business summary: pending payments total, deliveries due, expiring quotes. Call this for "summary", "how is business", "today\'s status" etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_overdue_payments',
      description: 'Get ALL overdue invoices with customer name, amount, days overdue. Call this for "overdue", "pending payments", "who owes me", "payment reminders" etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_customers',
      description: 'Search customers by name. Call this when owner mentions a specific customer name.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Customer name or partial name' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_collection_insights',
      description: 'Get collection efficiency: total outstanding, collections this week. Call for "collections", "recovery", "efficiency" etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bank_summary',
      description: 'Get bank account balances and total cash. Call for "bank", "balance", "cash position" etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reorder_suggestions',
      description: 'Get products low on stock that need reordering. Call for "reorder", "stock", "inventory" etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ── Tool execution ───────────────────────────────────────────
async function executeTool(toolName, args, supabase, organisationId) {
  try {
    switch (toolName) {
      case 'get_daily_summary': {
        // Pending payments = all customers with outstanding > 0
        const { data: customers } = await supabase
          .from('customers')
          .select('id, name, outstanding_balance')
          .eq('organisation_id', organisationId)
          .gt('outstanding_balance', 0);
        const pendingAmount = (customers || []).reduce((s, c) => s + (c.outstanding_balance || 0), 0);

        // Overdue invoices count
        const { count: overdueCount } = await supabase
          .from('invoices')
          .select('*', { count: 'exact', head: true })
          .eq('organisation_id', organisationId)
          .lt('due_date', new Date().toISOString())
          .neq('status', 'paid');

        // Draft quotes
        const { count: quoteCount } = await supabase
          .from('invoices')
          .select('*', { count: 'exact', head: true })
          .eq('organisation_id', organisationId)
          .eq('status', 'draft');

        return {
          card_type: 'daily_summary',
          data: {
            pending_amount: pendingAmount,
            pending_customers: (customers || []).length,
            overdue_count: overdueCount || 0,
            delivery_count: overdueCount || 0,
            quote_count: quoteCount || 0,
          },
        };
      }

      case 'get_overdue_payments': {
        const { data: invoices } = await supabase
          .from('invoices')
          .select('id, customer_id, total_amount, due_date, status')
          .eq('organisation_id', organisationId)
          .lt('due_date', new Date().toISOString())
          .neq('status', 'paid')
          .order('due_date', { ascending: true });

        if (!invoices || invoices.length === 0) {
          return { card_type: 'payment_reminder', data: { customers: [], total: 0 } };
        }

        const customerIds = [...new Set(invoices.map(i => i.customer_id))];
        let custs = [];
        if (customerIds.length > 0) {
          const { data: custData } = await supabase
            .from('customers')
            .select('id, name, phone, outstanding_balance')
            .in('id', customerIds);
          custs = custData || [];
        }
        const custMap = {};
        custs.forEach(c => { custMap[c.id] = c; });

        // Aggregate by customer
        const byCustomer = {};
        invoices.forEach(inv => {
          if (!byCustomer[inv.customer_id]) {
            const cust = custMap[inv.customer_id] || {};
            byCustomer[inv.customer_id] = {
              id: inv.customer_id,
              name: cust.name || 'Unknown',
              phone: cust.phone || null,
              amount: 0,
              days_overdue: 0,
            };
          }
          byCustomer[inv.customer_id].amount += inv.total_amount || 0;
          const days = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
          if (days > byCustomer[inv.customer_id].days_overdue) {
            byCustomer[inv.customer_id].days_overdue = days;
          }
        });

        const customerList = Object.values(byCustomer);
        const total = customerList.reduce((s, c) => s + c.amount, 0);

        return {
          card_type: 'payment_reminder',
          data: { customers: customerList, total, invoice_count: invoices.length },
        };
      }

      case 'search_customers': {
        const query = args?.query || '';
        const { data: results } = await supabase
          .from('customers')
          .select('id, name, phone, outstanding_balance')
          .eq('organisation_id', organisationId)
          .ilike('name', `%${query}%`)
          .limit(10);
        return { card_type: 'query_response', data: { customers: results || [] } };
      }

      case 'get_collection_insights': {
        const { data: customers } = await supabase
          .from('customers')
          .select('outstanding_balance')
          .eq('organisation_id', organisationId);
        const totalOutstanding = (customers || []).reduce((s, c) => s + (c.outstanding_balance || 0), 0);
        return {
          card_type: 'collection_insight',
          data: {
            total_outstanding: totalOutstanding,
            collected_today: 0,
            collected_this_week: 0,
            customer_count: (customers || []).length,
          },
        };
      }

      case 'get_bank_summary': {
        const { data: accounts } = await supabase
          .from('bank_accounts')
          .select('id, name, current_balance, bank_name')
          .eq('organisation_id', organisationId);
        const total = (accounts || []).reduce((s, a) => s + (a.current_balance || 0), 0);
        return {
          card_type: 'bank_summary',
          data: { accounts: (accounts || []).map(a => ({ name: a.name || a.bank_name, balance: a.current_balance || 0 })), total },
        };
      }

      case 'get_reorder_suggestions': {
        const { data: inventory } = await supabase
          .from('inventory')
          .select('product_id, quantity, reorder_point, reorder_qty')
          .eq('organisation_id', organisationId);
        const lowStock = (inventory || []).filter(i => i.quantity <= i.reorder_point);
        if (lowStock.length === 0) return { card_type: 'reorder_suggestion', data: { products: [] } };

        const productIds = lowStock.map(i => i.product_id);
        let products = [];
        if (productIds.length > 0) {
          const { data: prodData } = await supabase.from('products').select('id, name').in('id', productIds);
          products = prodData || [];
        }
        const prodMap = {};
        products.forEach(p => { prodMap[p.id] = p.name; });

        return {
          card_type: 'reorder_suggestion',
          data: {
            products: lowStock.map(i => ({
              product_name: prodMap[i.product_id] || 'Unknown',
              product_id: i.product_id,
              current_stock: i.quantity,
              reorder_point: i.reorder_point,
              suggested_qty: i.reorder_qty,
            })),
          },
        };
      }

      default:
        return { card_type: 'query_response', data: { error: `Unknown tool: ${toolName}` } };
    }
  } catch (err) {
    console.error(`Tool ${toolName} failed:`, err.message);
    return { card_type: 'query_response', data: { error: err.message } };
  }
}

// ── Register AI routes ───────────────────────────────────────
export function registerAIRoutes(app, supabase) {

  async function authenticate(c) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.split(' ')[1];
    if (!supabase) return null;
    const { data: userData, error } = await supabase.auth.getUser(token);
    if (error || !userData.user) return null;
    const authId = userData.user.id;
    const { data: userRecord } = await supabase
      .from('users').select('id, organisation_id').eq('auth_id', authId).single();
    if (!userRecord) return null;
    return { userId: userRecord.id, organisationId: userRecord.organisation_id };
  }

  // ─── GET /api/ai/conversation ────────────────────────────
  app.get('/api/ai/conversation', async (c) => {
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);

      let { data: conversation } = await supabase
        .from('conversations').select('id')
        .eq('organisation_id', auth.organisationId)
        .is('entity_type', null).eq('status', 'active').maybeSingle();

      if (!conversation) {
        const { data: newConv, error: createErr } = await supabase
          .from('conversations').insert({
            organisation_id: auth.organisationId, user_id: auth.userId,
            entity_type: null, model: 'gpt-4o-mini', status: 'active',
          }).select('id').single();
        if (createErr) return c.json({ error: 'server_error' }, 500);
        conversation = newConv;
      }

      const { data: messages } = await supabase
        .from('messages').select('id, role, content, metadata, created_at')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true }).limit(50);

      const shaped = (messages || []).map(m => ({
        id: m.id, role: m.role, content: m.content,
        card_type: m.metadata?.card_type || null,
        card_data: m.metadata?.card_data || {},
        created_at: m.created_at,
      }));

      return c.json({ conversation_id: conversation.id, messages: shaped });
    } catch (error) {
      console.error('AI conversation error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ─── POST /api/ai/message ───────────────────────────────
  app.post('/api/ai/message', async (c) => {
    const startTime = Date.now();
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { userId, organisationId } = auth;

      if (!checkRateLimit(organisationId)) return c.json({ error: 'rate_limited' }, 429);

      const body = await c.req.json();
      const userMessage = body.message?.trim();
      const conversationId = body.conversation_id;
      if (!userMessage) return c.json({ error: 'empty_message' }, 400);
      if (userMessage.length > 2000) return c.json({ error: 'message_too_long' }, 400);
      if (!conversationId) return c.json({ error: 'missing_conversation_id' }, 400);

      // 1. Save user message
      const { error: saveErr } = await supabase.from('messages').insert({
        organisation_id: organisationId, conversation_id: conversationId,
        role: 'user', content: userMessage, tokens_input: 0, tokens_output: 0,
      });
      if (saveErr) return c.json({ error: 'server_error' }, 500);

      // 2. Context assembly
      let globalContext = '';
      try {
        const { data: ctxRows } = await supabase
          .from('ai_context').select('context_key, context_value')
          .eq('organisation_id', organisationId).eq('scope', 'global')
          .eq('is_active', true).is('deleted_at', null);
        if (ctxRows?.length > 0) {
          globalContext = ctxRows.map(r => `${r.context_key}: ${r.context_value}`).join('\n');
        }
      } catch {}

      const { data: recentMsgs } = await supabase
        .from('messages').select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false }).limit(15);
      const history = (recentMsgs || []).reverse().map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant', content: m.content || '',
      }));

      const systemContent = SYSTEM_PROMPT + (globalContext ? `\n\nBusiness context:\n${globalContext}` : '');
      const aiMessages = [{ role: 'system', content: systemContent }, ...history];

      // 3. Call OpenAI — STRICT tool_choice='required'
      const client = getOpenAI();
      if (!client) return c.json({ error: 'ai_error', message: 'AI not configured' }, 500);

      let tokensInput = 0, tokensOutput = 0;
      let toolName = null;
      let toolResult = null;
      let responseText = '';
      let cardType = 'query_response';
      let cardData = {};

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: aiMessages,
          tools: TOOLS,
          tool_choice: 'required',
          temperature: 0.3,
        }, { signal: controller.signal });
        clearTimeout(timeoutId);
        tokensInput += completion.usage?.prompt_tokens || 0;
        tokensOutput += completion.usage?.completion_tokens || 0;

        const msg = completion.choices[0].message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Execute the first tool call
          const tc = msg.tool_calls[0];
          toolName = tc.function.name;
          let toolArgs = {};
          try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch {}

          console.log('🔧 [AI] Tool called:', toolName, 'args:', JSON.stringify(toolArgs));
          toolResult = await executeTool(toolName, toolArgs, supabase, organisationId);
          console.log('🔧 [AI] Tool result card_type:', toolResult.card_type);

          // Deterministic card_type from tool, not from AI
          cardType = toolResult.card_type || TOOL_CARD_TYPE_MAP[toolName] || 'query_response';
          cardData = toolResult.data || {};

          // Second call — AI formats the data into plain language
          const formatMessages = [
            ...aiMessages,
            msg,
            { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult.data) },
          ];

          const controller2 = new AbortController();
          const timeoutId2 = setTimeout(() => controller2.abort(), 8000);
          try {
            const comp2 = await client.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: formatMessages,
              temperature: 0.3,
            }, { signal: controller2.signal });
            clearTimeout(timeoutId2);
            tokensInput += comp2.usage?.prompt_tokens || 0;
            tokensOutput += comp2.usage?.completion_tokens || 0;
            responseText = comp2.choices[0].message.content || '';
          } catch {
            clearTimeout(timeoutId2);
            responseText = `Here are the results from ${toolName}.`;
          }

          // Handle multiple tool calls if present
          for (let i = 1; i < msg.tool_calls.length; i++) {
            const extraTc = msg.tool_calls[i];
            const extraName = extraTc.function.name;
            let extraArgs = {};
            try { extraArgs = JSON.parse(extraTc.function.arguments || '{}'); } catch {}
            try { await executeTool(extraName, extraArgs, supabase, organisationId); } catch {}
          }

        } else {
          // Model didn't call a tool despite required — use content as-is
          responseText = msg.content || 'I could not process that request.';
        }
      } catch (aiErr) {
        clearTimeout(timeoutId);
        console.error('OpenAI call failed:', aiErr.message);
        try {
          await supabase.from('ai_usage_log').insert({
            organisation_id: organisationId, user_id: userId, conversation_id: conversationId,
            model: 'gpt-4o-mini', operation: 'chat', tokens_input: 0, tokens_output: 0,
            cost_usd: 0, duration_ms: Date.now() - startTime, status: 'failed', error_message: aiErr.message,
          });
        } catch {}
        return c.json({ error: 'ai_error', message: 'AI temporarily unavailable' }, 500);
      }

      // Clean up response text — strip JSON wrapper if AI returned JSON
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.response_text) responseText = parsed.response_text;
        }
      } catch {}

      // 4. Save assistant message with deterministic card_type
      const { data: savedMsg } = await supabase.from('messages').insert({
        organisation_id: organisationId, conversation_id: conversationId,
        role: 'assistant', content: responseText,
        metadata: { card_type: cardType, card_data: cardData },
        tokens_input: tokensInput, tokens_output: tokensOutput,
      }).select('id').single();

      // 5. Write ai_usage_log
      const durationMs = Date.now() - startTime;
      const costUsd = (tokensInput * 0.00015 / 1000) + (tokensOutput * 0.00060 / 1000);
      try {
        await supabase.from('ai_usage_log').insert({
          organisation_id: organisationId, user_id: userId, conversation_id: conversationId,
          model: 'gpt-4o-mini', operation: 'chat', tokens_input: tokensInput, tokens_output: tokensOutput,
          cost_usd: costUsd, duration_ms: durationMs, status: 'success',
        });
      } catch {}

      return c.json({
        message_id: savedMsg?.id || null,
        response_text: responseText,
        card_type: cardType,
        card_data: cardData,
        actions: [],
      });

    } catch (error) {
      console.error('AI message error:', error);
      return c.json({ error: 'ai_error', message: error.message }, 500);
    }
  });

  // ─── POST /api/reminders/send-bulk ──────────────────────
  app.post('/api/reminders/send-bulk', async (c) => {
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const body = await c.req.json();
      const customerIds = body.customer_ids;
      if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0)
        return c.json({ error: 'invalid_request' }, 400);

      const { data: customers } = await supabase
        .from('customers').select('id, name, phone, outstanding_balance').in('id', customerIds);
      if (!customers?.length) return c.json({ sent: 0, failed: 0, whatsapp_urls: [] });

      const whatsappUrls = [];
      let sent = 0, failed = 0;
      for (const cust of customers) {
        if (cust.phone) {
          const phone = cust.phone.replace(/[^0-9]/g, '');
          const text = encodeURIComponent(
            `Hi ${cust.name}, this is a friendly reminder about your outstanding balance of ₹${(cust.outstanding_balance || 0).toLocaleString('en-IN')}. Please let us know if you have any questions.`
          );
          whatsappUrls.push({ customer_id: cust.id, customer_name: cust.name, url: `https://wa.me/${phone}?text=${text}` });
          sent++;
        } else { failed++; }
      }
      return c.json({ sent, failed, whatsapp_urls: whatsappUrls });
    } catch (error) {
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ─── GET /api/bank/summary ──────────────────────────────
  app.get('/api/bank/summary', async (c) => {
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { data: accounts } = await supabase
        .from('bank_accounts').select('id, name, current_balance, bank_name')
        .eq('organisation_id', auth.organisationId);
      const total = (accounts || []).reduce((s, a) => s + (a.current_balance || 0), 0);
      return c.json({
        accounts: (accounts || []).map(a => ({ name: a.name || a.bank_name, balance: a.current_balance || 0 })),
        total,
      });
    } catch (error) {
      return c.json({ error: 'server_error' }, 500);
    }
  });
}
