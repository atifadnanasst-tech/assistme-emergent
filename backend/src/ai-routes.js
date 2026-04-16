// AI Routes for AssistMe — Flow 2B
// Backend-controlled AI: DB queries first, AI formats results
import OpenAI from 'openai';

// ── Rate limiter (in-memory, per org) ────────────────────────
const rateLimitMap = new Map(); // orgId → { count, windowStart }
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
  if (!key) {
    console.warn('⚠️  No LLM key configured');
    return null;
  }
  openai = new OpenAI({ apiKey: key, baseURL });
  return openai;
}

// ── System prompt ────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a business data assistant for an Indian MSME trader.
You have access to these tools to query the owner's live business database:
- get_daily_summary: Get today's business summary (pending payments, deliveries, quotes)
- get_overdue_payments: Get list of overdue invoices with customer details
- search_customers: Search customers by name
- get_collection_insights: Get collection efficiency data
- get_bank_summary: Get bank account balances
- get_reorder_suggestions: Get products that need reordering

When the owner asks a question:
1. Use the appropriate tool to fetch real data
2. Format your response using ONLY the data returned by the tool
3. Output ONLY this JSON — no other text:
{
  "response_text": "plain language answer using ONLY the data provided",
  "card_type": "query_response",
  "card_data": {}
}

HARD RULES:
- Never invent amounts, names, or counts
- Only use numbers from the tool results
- If no data is available, say so honestly
- Always respond in JSON format with response_text, card_type, card_data
- For financial queries, ALWAYS use a tool — never guess
- Amounts are in INR (₹)`;

// ── Tool definitions for function calling ────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_daily_summary',
      description: 'Get today\'s business summary including pending payments, deliveries due, and expiring quotes',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_overdue_payments',
      description: 'Get list of overdue invoices with customer names, amounts, and days overdue',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_customers',
      description: 'Search customers by name. Use when the owner asks about a specific customer.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Customer name or partial name to search for' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_collection_insights',
      description: 'Get collection efficiency data — how much has been recovered and efficiency trends',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bank_summary',
      description: 'Get bank account balances and total cash position',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reorder_suggestions',
      description: 'Get products that are low on stock and need reordering',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ── Tool execution functions ─────────────────────────────────
async function executeTool(toolName, args, supabase, organisationId) {
  try {
    switch (toolName) {
      case 'get_daily_summary': {
        const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        // Pending payments
        const { data: customers } = await supabase
          .from('customers')
          .select('id, name, outstanding_balance')
          .eq('organisation_id', organisationId)
          .gt('outstanding_balance', 0);
        const pendingAmount = (customers || []).reduce((s, c) => s + (c.outstanding_balance || 0), 0);

        // Deliveries due (invoices created today with status sent)
        const { count: deliveryCount } = await supabase
          .from('invoices')
          .select('*', { count: 'exact', head: true })
          .eq('organisation_id', organisationId)
          .eq('status', 'sent')
          .gte('created_at', todayIST + 'T00:00:00+05:30')
          .lte('created_at', todayIST + 'T23:59:59+05:30');

        // Expiring quotes
        const { count: quoteCount } = await supabase
          .from('invoices')
          .select('*', { count: 'exact', head: true })
          .eq('organisation_id', organisationId)
          .eq('status', 'draft');

        return {
          pending_amount: pendingAmount,
          pending_customers: (customers || []).length,
          delivery_count: deliveryCount || 0,
          quote_count: quoteCount || 0,
          date: todayIST,
        };
      }

      case 'get_overdue_payments': {
        const { data: invoices } = await supabase
          .from('invoices')
          .select('customer_id, total_amount, due_date, status')
          .eq('organisation_id', organisationId)
          .lt('due_date', new Date().toISOString())
          .neq('status', 'paid');

        if (!invoices || invoices.length === 0) return { overdue: [] };

        const customerIds = [...new Set(invoices.map(i => i.customer_id))];
        const { data: custs } = await supabase
          .from('customers')
          .select('id, name, phone')
          .in('id', customerIds);

        const custMap = {};
        (custs || []).forEach(c => { custMap[c.id] = c; });

        const overdue = invoices.map(inv => {
          const cust = custMap[inv.customer_id] || {};
          const daysOverdue = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
          return {
            customer_name: cust.name || 'Unknown',
            customer_id: inv.customer_id,
            phone: cust.phone || null,
            amount: inv.total_amount,
            days_overdue: daysOverdue,
          };
        });

        return { overdue };
      }

      case 'search_customers': {
        const query = args?.query || '';
        const { data: results } = await supabase
          .from('customers')
          .select('id, name, phone, outstanding_balance')
          .eq('organisation_id', organisationId)
          .ilike('name', `%${query}%`)
          .limit(10);
        return { customers: results || [] };
      }

      case 'get_collection_insights': {
        const { data: customers } = await supabase
          .from('customers')
          .select('outstanding_balance')
          .eq('organisation_id', organisationId);
        const totalOutstanding = (customers || []).reduce((s, c) => s + (c.outstanding_balance || 0), 0);

        // No payments table — collected = 0 per spec
        return {
          total_outstanding: totalOutstanding,
          collected_today: 0,
          collected_this_week: 0,
          customer_count: (customers || []).length,
        };
      }

      case 'get_bank_summary': {
        const { data: accounts } = await supabase
          .from('bank_accounts')
          .select('id, name, current_balance, bank_name')
          .eq('organisation_id', organisationId);
        const total = (accounts || []).reduce((s, a) => s + (a.current_balance || 0), 0);
        return { accounts: accounts || [], total };
      }

      case 'get_reorder_suggestions': {
        const { data: inventory } = await supabase
          .from('inventory')
          .select('product_id, quantity, reorder_point, reorder_qty')
          .eq('organisation_id', organisationId);

        const lowStock = (inventory || []).filter(i => i.quantity <= i.reorder_point);
        if (lowStock.length === 0) return { products: [] };

        const productIds = lowStock.map(i => i.product_id);
        const { data: products } = await supabase
          .from('products')
          .select('id, name')
          .in('id', productIds);

        const prodMap = {};
        (products || []).forEach(p => { prodMap[p.id] = p.name; });

        return {
          products: lowStock.map(i => ({
            product_name: prodMap[i.product_id] || 'Unknown',
            product_id: i.product_id,
            current_stock: i.quantity,
            reorder_point: i.reorder_point,
            suggested_qty: i.reorder_qty,
          })),
        };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`Tool ${toolName} failed:`, err.message);
    return { error: err.message };
  }
}

// ── Allowed card types ───────────────────────────────────────
const ALLOWED_CARD_TYPES = [
  'daily_summary', 'payment_reminder', 'reorder_suggestion',
  'bank_summary', 'collection_insight', 'query_response',
];

// ── Parse AI response safely ─────────────────────────────────
function parseAIResponse(text) {
  let parsed;
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    parsed = null;
  }

  const responseText = parsed?.response_text || text || 'I could not process that.';
  let cardType = parsed?.card_type || 'query_response';
  if (!ALLOWED_CARD_TYPES.includes(cardType)) cardType = 'query_response';
  const cardData = (parsed?.card_data && typeof parsed.card_data === 'object') ? parsed.card_data : {};

  return { responseText, cardType, cardData };
}

// ── Register AI routes ───────────────────────────────────────
export function registerAIRoutes(app, supabase) {

  // ─── Auth helper ─────────────────────────────────────────
  async function authenticate(c) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.split(' ')[1];
    if (!supabase) return null;

    const { data: userData, error } = await supabase.auth.getUser(token);
    if (error || !userData.user) return null;

    const authId = userData.user.id;
    const { data: userRecord } = await supabase
      .from('users')
      .select('id, organisation_id')
      .eq('auth_id', authId)
      .single();
    if (!userRecord) return null;

    return { userId: userRecord.id, organisationId: userRecord.organisation_id };
  }

  // ─── GET /api/ai/conversation ────────────────────────────
  app.get('/api/ai/conversation', async (c) => {
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);

      const { organisationId } = auth;

      // Find global AI conversation (entity_type IS NULL)
      let { data: conversation } = await supabase
        .from('conversations')
        .select('id')
        .eq('organisation_id', organisationId)
        .is('entity_type', null)
        .eq('status', 'active')
        .maybeSingle();

      // Create if not found
      if (!conversation) {
        const { data: newConv, error: createErr } = await supabase
          .from('conversations')
          .insert({
            organisation_id: organisationId,
            user_id: auth.userId,
            entity_type: null,
            model: 'gpt-4o-mini',
            status: 'active',
          })
          .select('id')
          .single();
        if (createErr) {
          console.error('Failed to create AI conversation:', createErr);
          return c.json({ error: 'server_error' }, 500);
        }
        conversation = newConv;
      }

      // Fetch messages (latest 50, chronological)
      const { data: messages, error: msgError } = await supabase
        .from('messages')
        .select('id, role, content, metadata, created_at')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .limit(50);

      if (msgError) {
        console.error('Messages fetch error:', msgError);
        return c.json({ error: 'server_error' }, 500);
      }

      // Shape messages for frontend
      const shaped = (messages || []).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        card_type: m.metadata?.card_type || null,
        card_data: m.metadata?.card_data || {},
        created_at: m.created_at,
      }));

      return c.json({
        conversation_id: conversation.id,
        messages: shaped,
      });

    } catch (error) {
      console.error('AI conversation error:', error);
      return c.json({ error: 'server_error', message: error.message }, 500);
    }
  });

  // ─── POST /api/ai/message ───────────────────────────────
  app.post('/api/ai/message', async (c) => {
    const startTime = Date.now();
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);

      const { userId, organisationId } = auth;

      // Rate limit
      if (!checkRateLimit(organisationId)) {
        return c.json({ error: 'rate_limited' }, 429);
      }

      const body = await c.req.json();
      const userMessage = body.message?.trim();
      const conversationId = body.conversation_id;

      if (!userMessage || userMessage.length === 0) {
        return c.json({ error: 'empty_message' }, 400);
      }
      if (userMessage.length > 2000) {
        return c.json({ error: 'message_too_long' }, 400);
      }
      if (!conversationId) {
        return c.json({ error: 'missing_conversation_id' }, 400);
      }

      // 1. Save user message to DB
      const { data: savedUserMsg, error: saveErr } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          conversation_id: conversationId,
          role: 'user',
          content: userMessage,
          tokens_input: 0,
          tokens_output: 0,
        })
        .select('id')
        .single();

      if (saveErr) {
        console.error('Failed to save user message:', saveErr);
        return c.json({ error: 'server_error' }, 500);
      }

      // 2. Assemble context — 3 layers
      // Layer 1: Global ai_context
      let globalContext = '';
      try {
        const { data: ctxRows } = await supabase
          .from('ai_context')
          .select('context_key, context_value')
          .eq('organisation_id', organisationId)
          .eq('scope', 'global')
          .eq('is_active', true)
          .is('deleted_at', null);
        if (ctxRows && ctxRows.length > 0) {
          globalContext = ctxRows.map(r => {
            try { return `${r.context_key}: ${r.context_value}`; }
            catch { return ''; }
          }).filter(Boolean).join('\n');
        }
      } catch (err) {
        console.warn('ai_context fetch failed:', err.message);
      }

      // Layer 3: Last 15 messages from conversation
      const { data: recentMsgs } = await supabase
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(15);

      const history = (recentMsgs || []).reverse().map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
      }));

      // 3. Build OpenAI messages
      const systemContent = SYSTEM_PROMPT +
        (globalContext ? `\n\nBusiness context:\n${globalContext}` : '');

      const aiMessages = [
        { role: 'system', content: systemContent },
        ...history,
      ];

      // 4. Call OpenAI with function calling
      const client = getOpenAI();
      if (!client) {
        return c.json({ error: 'ai_error', message: 'AI not configured' }, 500);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      let completion;
      let tokensInput = 0;
      let tokensOutput = 0;

      try {
        completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: aiMessages,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.3,
        }, { signal: controller.signal });
        clearTimeout(timeoutId);

        tokensInput = completion.usage?.prompt_tokens || 0;
        tokensOutput = completion.usage?.completion_tokens || 0;
      } catch (aiErr) {
        clearTimeout(timeoutId);
        console.error('OpenAI call failed:', aiErr.message);

        // Log failure
        try {
          await supabase.from('ai_usage_log').insert({
            organisation_id: organisationId,
            user_id: userId,
            conversation_id: conversationId,
            model: 'gpt-4o-mini',
            operation: 'chat',
            tokens_input: 0,
            tokens_output: 0,
            cost_usd: 0,
            duration_ms: Date.now() - startTime,
            status: 'failed',
            error_message: aiErr.message,
          });
        } catch {}

        return c.json({ error: 'ai_error', message: 'AI temporarily unavailable' }, 500);
      }

      // 5. Handle tool calls if any
      let assistantMessage = completion.choices[0].message;
      let finalContent = assistantMessage.content || '';

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        // Execute each tool
        const toolMessages = [
          ...aiMessages,
          assistantMessage,
        ];

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs = {};
          try { toolArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch {}

          const result = await executeTool(toolName, toolArgs, supabase, organisationId);

          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }

        // Second call — AI formats the tool results
        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), 8000);

        try {
          const completion2 = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: toolMessages,
            temperature: 0.3,
          }, { signal: controller2.signal });
          clearTimeout(timeoutId2);

          tokensInput += completion2.usage?.prompt_tokens || 0;
          tokensOutput += completion2.usage?.completion_tokens || 0;
          finalContent = completion2.choices[0].message.content || '';
        } catch (err2) {
          clearTimeout(timeoutId2);
          console.error('OpenAI formatting call failed:', err2.message);
          finalContent = '{"response_text":"I retrieved the data but couldn\'t format it. Please try again.","card_type":"query_response","card_data":{}}';
        }
      }

      // 6. Parse AI response
      const { responseText, cardType, cardData } = parseAIResponse(finalContent);

      // 7. Save assistant message to DB
      const { data: savedAssistantMsg } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          conversation_id: conversationId,
          role: 'assistant',
          content: responseText,
          metadata: { card_type: cardType, card_data: cardData },
          tokens_input: tokensInput,
          tokens_output: tokensOutput,
        })
        .select('id')
        .single();

      // 8. Write ai_usage_log
      const durationMs = Date.now() - startTime;
      const costUsd = (tokensInput * 0.00015 / 1000) + (tokensOutput * 0.00060 / 1000);

      try {
        await supabase.from('ai_usage_log').insert({
          organisation_id: organisationId,
          user_id: userId,
          conversation_id: conversationId,
          model: 'gpt-4o-mini',
          operation: 'chat',
          tokens_input: tokensInput,
          tokens_output: tokensOutput,
          cost_usd: costUsd,
          duration_ms: durationMs,
          status: 'success',
        });
      } catch (logErr) {
        console.warn('ai_usage_log write failed:', logErr.message);
      }

      // 9. Return response
      return c.json({
        message_id: savedAssistantMsg?.id || null,
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

      if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
        return c.json({ error: 'invalid_request' }, 400);
      }

      const { data: customers } = await supabase
        .from('customers')
        .select('id, name, phone, outstanding_balance')
        .in('id', customerIds);

      if (!customers || customers.length === 0) {
        return c.json({ sent: 0, failed: 0, whatsapp_urls: [] });
      }

      const whatsappUrls = [];
      let sent = 0;
      let failed = 0;

      for (const cust of customers) {
        if (cust.phone) {
          const phone = cust.phone.replace(/[^0-9]/g, '');
          const text = encodeURIComponent(
            `Hi ${cust.name}, this is a friendly reminder about your outstanding balance of ₹${(cust.outstanding_balance || 0).toLocaleString('en-IN')}. Please let us know if you have any questions.`
          );
          whatsappUrls.push({
            customer_id: cust.id,
            customer_name: cust.name,
            url: `https://wa.me/${phone}?text=${text}`,
          });
          sent++;
        } else {
          failed++;
        }
      }

      return c.json({ sent, failed, whatsapp_urls: whatsappUrls });

    } catch (error) {
      console.error('Send bulk reminders error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  // ─── GET /api/bank/summary ──────────────────────────────
  app.get('/api/bank/summary', async (c) => {
    try {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);

      const { data: accounts } = await supabase
        .from('bank_accounts')
        .select('id, name, current_balance, bank_name')
        .eq('organisation_id', auth.organisationId);

      const total = (accounts || []).reduce((s, a) => s + (a.current_balance || 0), 0);

      return c.json({
        accounts: (accounts || []).map(a => ({
          name: a.name || a.bank_name,
          balance: a.current_balance || 0,
        })),
        total,
      });

    } catch (error) {
      console.error('Bank summary error:', error);
      return c.json({ error: 'server_error' }, 500);
    }
  });
}
