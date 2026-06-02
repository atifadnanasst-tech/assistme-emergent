import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerAIRoutes, getOpenAI } from './ai-routes.js';
import { registerOrgAiRoutes } from './services/ai/orgAi/routes.js';
import { registerSupplierRoutes } from './services/business/supplierRoutes.js';
import { recordPayment } from './services/business/recordPayment.js';
import { extractVisualization } from './services/ai/visualizationParser.js';
import PDFDocument from 'pdfkit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config(); // loads .env from current working directory - works on all environments

// Initialize Supabase client with service role key (backend only)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (!supabaseUrl || !supabaseServiceKey || supabaseUrl.includes('your_supabase')) {
  console.warn('⚠️  Supabase credentials not configured. Some features will be unavailable.');
  console.warn('⚠️  Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file');
} else {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log('✅ Supabase client initialized');
}


// ─── Realtime Broadcast Helper ────────────────────────────
async function broadcastNewMessage(orgId, payload) {
  try {
    await supabase.channel('org-' + orgId).send({
      type: 'broadcast',
      event: 'message_created',
      payload: payload,
    });
    console.log('[BROADCAST] Sent to org:', orgId);
  } catch (err) {
    console.warn('[BROADCAST] Failed (non-fatal):', err.message);
  }
}

// ─── Cross-Org Card Mirror Helper ────────────────────────────
async function mirrorCardToReceiverOrg({ supabase, senderOrgId, senderUserId, customerPhone, originalMetadata, originalContent }) {
  try {
    if (!customerPhone) return;
    const normalizePhone = (p) => p ? p.replace(/\D/g, '').padStart(12, '').slice(-12).replace(/^0+/, '') : null;
    const normalizedCustomerPhone = normalizePhone(customerPhone);

    const { data: allUsers } = await supabase.from('users').select('id, organisation_id, phone').neq('organisation_id', senderOrgId);
    const receiverUser = (allUsers || []).find(u => normalizePhone(u.phone) === normalizedCustomerPhone) || null;
    if (!receiverUser) return;

    const { data: senderUser } = await supabase.from('users').select('phone').eq('id', senderUserId).maybeSingle();
    if (!senderUser?.phone) return;
    const normalizedSenderPhone = normalizePhone(senderUser.phone);

    const { data: allReceiverCustomers } = await supabase.from('customers').select('id, phone').eq('organisation_id', receiverUser.organisation_id);
    let senderAsCustomer = (allReceiverCustomers || []).find(c => normalizePhone(c.phone) === normalizedSenderPhone) || null;

    if (!senderAsCustomer) {
      const avatarColors = ['#E53935','#8E24AA','#1E88E5','#43A047','#F57C00','#00897B'];
      const { data: newCust } = await supabase.from('customers').insert({
        organisation_id: receiverUser.organisation_id,
        name: senderUser.phone,
        phone: normalizedSenderPhone,
        currency: 'INR',
        outstanding_balance: 0,
        status: 'active',
        custom_fields: { avatar_color: avatarColors[Math.floor(Math.random() * avatarColors.length)], cross_org: true },
      }).select('id').single();
      if (newCust) senderAsCustomer = newCust;
    }
    if (!senderAsCustomer) return;

    let { data: receiverConv } = await supabase.from('conversations').select('id')
      .eq('organisation_id', receiverUser.organisation_id)
      .eq('entity_type', 'customer')
      .eq('entity_id', senderAsCustomer.id)
      .eq('status', 'active').maybeSingle();

    if (!receiverConv) {
      const { data: newConv } = await supabase.from('conversations').insert({
        organisation_id: receiverUser.organisation_id,
        user_id: receiverUser.id,
        entity_type: 'customer',
        entity_id: senderAsCustomer.id,
        model: 'gpt-4o-mini',
        status: 'active',
      }).select('id').single();
      receiverConv = newConv;
    }
    if (!receiverConv) return;

    await supabase.from('messages').insert({
      organisation_id: receiverUser.organisation_id,
      conversation_id: receiverConv.id,
      role: 'tool',
      content: originalContent,
      metadata: {
        ...originalMetadata,
        cross_org: true,
        read_by_owner: false,
        sender_org_id: senderOrgId,
      },
      tokens_input: 0,
      tokens_output: 0,
    });

    console.log('[MIRROR] Card mirrored to org:', receiverUser.organisation_id);
    await broadcastNewMessage(receiverUser.organisation_id, { conversation_id: receiverConv.id });

  } catch (err) {
    console.warn('[MIRROR] Card mirror failed (non-fatal):', err?.message);
  }
}

// Create Hono app
const app = new Hono();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', message: 'AssistMe Backend Running' });
});

// Auth route: Setup session after OTP verification
app.post('/api/auth/setup-session', async (c) => {
  try {
    // Get token from Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'invalid_token' }, 401);
    }

    const token = authHeader.split(' ')[1];

    // Check if Supabase is configured
    if (!supabase) {
      console.error('Supabase not configured - cannot validate token');
      return c.json({ error: 'invalid_token' }, 401);
    }

    // Validate token with Supabase Admin SDK
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData.user) {
      console.error('Token validation failed:', userError);
      return c.json({ error: 'invalid_token' }, 401);
    }

    const authId = userData.user.id;
    const rawPhone = userData.user.phone;

    if (!rawPhone) {
      return c.json({ error: 'setup_failed', message: 'Phone number not found in token' }, 500);
    }
    // Normalize to full number without + (E.164 without plus)
    let phone = rawPhone.replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;

    // Check if user already exists
    const { data: existingUser, error: userCheckError } = await supabase
      .from('users')
      .select('id, organisation_id, role')
      .eq('auth_id', authId)
      .single();

    if (userCheckError && userCheckError.code !== 'PGRST116') {
      // PGRST116 is "not found" error, which is expected for new users
      console.error('User check error:', userCheckError);
      return c.json({ error: 'setup_failed', message: 'Database error' }, 500);
    }

    // If user exists, return existing data
    if (existingUser) {
      return c.json({
        organisation_id: existingUser.organisation_id,
        user_id: existingUser.id,
        role: existingUser.role,
        is_new_user: false,
      });
    }

    // New user - create organisation and user
    let organisationId;
    let userId;
    let attempt = 0;
    const maxAttempts = 10;

    while (attempt < maxAttempts) {
      try {
        // Generate slug from phone number
        const phoneDigits = phone.replace(/\\D/g, '');
        const baseSlug = `org_${phoneDigits.slice(-6)}`;
        const slug = attempt === 0 ? baseSlug : `${baseSlug}${attempt.toString().padStart(2, '0')}`;

        // Create organisation
        const { data: newOrg, error: orgError } = await supabase
          .from('organisations')
          .insert({
            name: 'My Business',
            slug: slug,
            subscription_plan: 'free',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
          })
          .select('id')
          .single();

        if (orgError) {
          if (orgError.code === '23505') {
            // Unique constraint violation - try next slug
            attempt++;
            continue;
          }
          throw orgError;
        }

        organisationId = newOrg.id;

        // Create user
        const { data: newUser, error: createUserError } = await supabase
          .from('users')
          .insert({
            organisation_id: organisationId,
            auth_id: authId,
            phone: phone,
            role: 'owner',
            is_active: true,
          })
          .select('id')
          .single();

        if (createUserError) {
          // Rollback: delete organisation and auth user
          await supabase.from('organisations').delete().eq('id', organisationId);
          await supabase.auth.admin.deleteUser(authId);
          console.error('User creation failed, rolled back organisation:', createUserError);
          return c.json({ error: 'setup_failed', message: 'User creation failed' }, 500);
        }

        userId = newUser.id;

        // Create system tags
        const systemTags = [
          { name: 'All', color: '#6366f1', is_system: true },
          { name: 'Dues', color: '#D32F2F', is_system: true },
          { name: 'Quotes', color: '#F57C00', is_system: true },
          { name: 'Invoiced', color: '#388E3C', is_system: true },
          { name: 'To Deliver', color: '#1976D2', is_system: true },
          { name: 'Challans', color: '#7B1FA2', is_system: true },
        ];

        const tagsToInsert = systemTags.map(tag => ({
          ...tag,
          organisation_id: organisationId,
        }));

        const { error: tagsError } = await supabase
          .from('tags')
          .upsert(tagsToInsert, { onConflict: 'organisation_id,name', ignoreDuplicates: true });

        if (tagsError) {
          // Rollback: delete user, organisation and auth user
          await supabase.from('users').delete().eq('id', userId);
          await supabase.from('organisations').delete().eq('id', organisationId);
          await supabase.auth.admin.deleteUser(authId);
          console.error('Tags creation failed, rolled back:', tagsError);
          return c.json({ error: 'setup_failed', message: 'Tags creation failed' }, 500);
        }

        // Success!
        return c.json({
          organisation_id: organisationId,
          user_id: userId,
          role: 'owner',
          is_new_user: true,
        });

      } catch (err) {
        console.error('Setup attempt error:', err);
        // Rollback everything on unexpected error
        if (userId) await supabase.from('users').delete().eq('id', userId);
        if (organisationId) await supabase.from('organisations').delete().eq('id', organisationId);
        await supabase.auth.admin.deleteUser(authId);
        attempt++;
      }
    }

    // If we get here, all attempts failed
    return c.json({ error: 'setup_failed', message: 'Could not generate unique organisation slug' }, 500);

  } catch (error) {
    console.error('Setup session error:', error);
    return c.json({ error: 'setup_failed', message: 'Internal server error' }, 500);
  }
});

// Home Screen Data Endpoint
app.get('/api/home', async (c) => {
  try {
    // Validate token
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const token = authHeader.split(' ')[1];

    if (!supabase) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Validate token and get user
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData.user) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const authId = userData.user.id;

    // Get organisation_id from user record
    const { data: userRecord, error: userRecordError } = await supabase
      .from('users')
      .select('organisation_id, preferences')
      .eq('auth_id', authId)
      .single();

    if (userRecordError || !userRecord) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const organisationId = userRecord.organisation_id;
    const filterTagId = c.req.query('filter');
    const limit = parseInt(c.req.query('limit') || '50', 10);

    // Fetch organisation-level fields (subscription_plan)
    let subscriptionPlan = 'free';
    let primaryLanguage = 'en';
    try {
      const { data: orgRecord } = await supabase
        .from('organisations')
        .select('subscription_plan, primary_language')
        .eq('id', organisationId)
        .single();
      if (orgRecord) {
        subscriptionPlan = orgRecord.subscription_plan || 'free';
        primaryLanguage = orgRecord.primary_language || 'en';
      }
    } catch (err) {
      console.warn('Failed to fetch organisation:', err);
    }

    // Extract language preference
    const language = (userRecord.preferences && typeof userRecord.preferences === 'object')
      ? userRecord.preferences.language || null
      : null;

    console.log('🔍 [HOME] Step 1: Organisation ID extracted:', organisationId);
    console.log('🔍 [HOME] Plan:', subscriptionPlan, '| Language:', language);
    console.log('🔍 [HOME] Filter tag:', filterTagId || 'none (all)');

    // Query 1: Get filter tabs (tags)
    const { data: tags, error: tagsError } = await supabase
      .from('tags')
      .select('id, name, color, is_system')
      .eq('organisation_id', organisationId)
      .is('deleted_at', null)
      .order('is_system', { ascending: false })
      .order('created_at', { ascending: true });

    console.log('🔍 [HOME] Tags query result');
    console.log('  - Error:', tagsError ? tagsError.message : 'none');
    console.log('  - Count:', tags?.length || 0);

    const filterTabs = [];
    
    if (!tagsError && tags) {
      // Compute counts for each tag
      for (const tag of tags) {
        let count = null;
        
        // Get count of customers with this tag
        const { count: tagCount, error: countError } = await supabase
          .from('entity_tags')
          .select('*', { count: 'exact', head: true })
          .eq('organisation_id', organisationId)
          .eq('tag_id', tag.id)
          .eq('entity_type', 'customer');

        if (!countError) {
          count = tagCount;
        }

        filterTabs.push({
          id: tag.id,
          name: tag.name,
          count: count,
          is_custom: !tag.is_system,
        });
      }
    }

    // Query 2: Get conversations
    let conversationsQuery = supabase
      .from('conversations')
      .select('id, entity_type, entity_id')
      .eq('organisation_id', organisationId)
      .eq('status', 'active')
      .eq('entity_type', 'customer');

    // Apply filter if specified (not 'all')
    let filteredCustomerIds = [];
    if (filterTagId && filterTagId !== 'all') {
      const { data: entityTags, error: entityTagsError } = await supabase
        .from('entity_tags')
        .select('entity_id')
        .eq('organisation_id', organisationId)
        .eq('tag_id', filterTagId)
        .eq('entity_type', 'customer');

      if (!entityTagsError && entityTags) {
        filteredCustomerIds = entityTags.map(et => et.entity_id);
      }

      // Guard: skip query if array is empty
      if (filteredCustomerIds.length === 0) {
        return c.json({
          insight_strip: null,
          filter_tabs: filterTabs,
          conversations: [],
        });
      }

      conversationsQuery = conversationsQuery.in('entity_id', filteredCustomerIds);
    }

    const { data: conversations, error: conversationsError } = await conversationsQuery;

    console.log('🔍 [HOME] Step 2: Conversations query result');
    console.log('  - Error:', conversationsError ? conversationsError.message : 'none');
    console.log('  - Count:', conversations?.length || 0);
    console.log('  - Sample:', conversations?.slice(0, 2));

    if (conversationsError) {
      console.error('Conversations query error:', conversationsError);
      return c.json({ error: 'server_error' }, 500);
    }

    // Query 3: Get latest message per conversation (DISTINCT ON pattern)
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
    }

    // Query 4: Get customer data
    const customerIds = conversations?.map(c => c.entity_id).filter(id => id !== null) || [];
    console.log('🔍 [HOME] Step 6: Customer IDs to fetch');
    console.log('  - Count:', customerIds.length);
    console.log('  - IDs:', customerIds);
    
    let customers = [];
    let payableMap = {};           // what owner owes each entity (purchase_bills)
    let payableOverdueSet = new Set(); // entities with overdue purchase bills

    if (customerIds.length > 0) {
      const { data: customersData, error: customersError } = await supabase
        .from('customers')
        .select('id, name, outstanding_balance, custom_fields')
        .in('id', customerIds);

      console.log('🔍 [HOME] Step 7: Customers query result');
      console.log('  - Error:', customersError ? customersError.message : 'none');
      console.log('  - Count:', customersData?.length || 0);
      console.log('  - Sample:', customersData?.slice(0, 2));

      if (!customersError && customersData) {
        customers = customersData;
      }

      // Query 4b: payable_balance + overdue from purchase_bills
      try {
        const today = new Date().toISOString().split('T')[0];
        const { data: pbRows } = await supabase
          .from('purchase_bills')
          .select('customer_id, amount_due, due_date')
          .in('customer_id', customerIds)
          .eq('organisation_id', organisationId)
          .eq('is_historical', false)
          .is('deleted_at', null)
          .not('status', 'in', '("paid","cancelled")')
          .gt('amount_due', 0);
        for (const row of pbRows || []) {
          const cid = row.customer_id;
          payableMap[cid] = Math.round(((payableMap[cid] || 0) + Number(row.amount_due)) * 100) / 100;
          if (row.due_date && row.due_date < today) payableOverdueSet.add(cid);
        }
      } catch (pbErr) {
        console.warn('[HOME] payable query failed (non-fatal):', pbErr.message);
      }
    }

    // Query 5: Get insight strip
    let insightStrip = null;
    try {
      const { data: aiContext, error: aiContextError } = await supabase
        .from('ai_context')
        .select('context_value, updated_at')
        .eq('organisation_id', organisationId)
        .eq('context_key', 'daily_insight')
        .eq('scope', 'global')
        .single();

      if (!aiContextError && aiContext) {
        // Parse context_value (stored as TEXT)
        try {
          const parsedValue = JSON.parse(aiContext.context_value);
          insightStrip = {
            content: parsedValue.content || '',
            items: parsedValue.items || [],
          };
        } catch (parseError) {
          console.warn('Failed to parse ai_context.context_value:', parseError);
        }
      }
    } catch (err) {
      // Non-critical query failure - continue without insight
      console.warn('Insight strip query failed:', err);
    }

    // Assemble conversation list with UI-ready fields
    const conversationList = [];

    for (const conv of conversations || []) {
      const customer = customers.find(c => c.id === conv.entity_id);
      if (!customer) continue;

      const latestMsg = latestMessages.find(m => m.conversation_id === conv.id);
      if (!latestMsg) continue;

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
        last_message: latestMsg.content || '',
        last_message_at: latestMsg.created_at,
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
    const limitedConversations = conversationList.slice(0, limit);

    return c.json({
      insight_strip: insightStrip,
      filter_tabs: filterTabs,
      conversations: limitedConversations,
      subscription_plan: subscriptionPlan,
      language: primaryLanguage,
    });

  } catch (error) {
    console.error('Home endpoint error:', error);
    return c.json({ error: 'server_error', message: error.message }, 500);
  }
});

// Sign Out Endpoint
app.post('/api/auth/sign-out', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const token = authHeader.split(' ')[1];

    if (!supabase) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Validate and sign out
    await supabase.auth.admin.signOut(token);

    return c.json({ success: true });
  } catch (error) {
    console.error('Sign out error:', error);
    return c.json({ success: true }); // Return success even on error
  }
});
// ─── GET /api/organisations ────────────────────────────────
// Returns current org settings needed by settings screens
// Used by: language settings screen, future settings screens
app.get('/api/organisations', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const { data, error } = await supabase
      .from('organisations')
      .select('id, primary_language, customer_language_auto, timezone, currency')
      .eq('id', organisationId)
      .single();
    if (error) {
      console.error('[GET /api/organisations] Error:', error);
      return c.json({ error: 'fetch_failed' }, 500);
    }
    return c.json(data);
  } catch (err) {
    console.error('[GET /api/organisations] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── PATCH /api/organisations ───────────────────────────────
// Update organisation settings — language preferences and future config
// Allowed fields: primary_language, customer_language_auto
// All other org fields are immutable via this endpoint
app.patch('/api/organisations', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const body = await c.req.json();

    // Whitelist — only these fields may be updated via this endpoint
    const allowed = ['primary_language', 'customer_language_auto'];
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'no_valid_fields' }, 400);
    }

    // Validate primary_language — ISO 639-1 format (e.g. 'en', 'hi', 'pt-br')
    // Regex allows 2-5 letter codes with optional region subtag — no hardcoded whitelist
    if (updates.primary_language) {
      const lang = updates.primary_language.trim().toLowerCase();
      if (!/^[a-z]{2,5}(-[a-z]{2,5})?$/.test(lang)) {
        return c.json({ error: 'invalid_language' }, 400);
      }
      updates.primary_language = lang;
    }

    // Validate customer_language_auto — must be boolean
    if (updates.customer_language_auto !== undefined && typeof updates.customer_language_auto !== 'boolean') {
      return c.json({ error: 'invalid_customer_language_auto' }, 400);
    }

    const { data, error } = await supabase
      .from('organisations')
      .update(updates)
      .eq('id', organisationId)
      .select('id, primary_language, customer_language_auto')
      .single();

    if (error) {
      console.error('[PATCH /api/organisations] Error:', error);
      return c.json({ error: 'update_failed' }, 500);
    }
    return c.json({ success: true, organisation: data });
  } catch (err) {
    console.error('[PATCH /api/organisations] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});


// ─── POST /api/customers ────────────────────────────────────
app.post('/api/customers', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;

    const body = await c.req.json().catch(() => ({}));
    const { name, phone, business_name, opening_balance } = body;

    if (!name?.trim()) return c.json({ error: 'validation', message: 'Name is required' }, 400);
    if (!phone) return c.json({ error: 'validation', message: 'Phone is required' }, 400);

    let normalizedPhone = String(phone).replace(/\D/g, '');
    if (normalizedPhone.length < 10) return c.json({ error: 'validation', message: 'Invalid phone number' }, 400);
    if (normalizedPhone.length === 10) normalizedPhone = '91' + normalizedPhone;

    // Check for duplicate
    const { data: existing } = await supabase
      .from('customers')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (existing) {
      console.log('[ADD CUSTOMER] Duplicate found:', existing.id);
      return c.json({ error: 'duplicate', customer_id: existing.id }, 409);
    }

    // Generate avatar color
    const colors = ['#E53935','#8E24AA','#1E88E5','#43A047','#F57C00','#00897B'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];

    // Create customer
    const { data: newCustomer, error: customerError } = await supabase
      .from('customers')
      .insert({
        organisation_id: organisationId,
        name: name.trim(),
        phone: normalizedPhone,
        company: business_name || null,
        currency: 'INR',
        outstanding_balance: opening_balance || 0,
        status: 'active',
        custom_fields: { avatar_color }
      })
      .select('id')
      .single();

    if (customerError) {
      console.error('[ADD CUSTOMER] Insert error:', customerError);
      return c.json({ error: 'server_error' }, 500);
    }

    // Create conversation
    await supabase.from('conversations').insert({
      organisation_id: organisationId,
      user_id: userId,
      entity_type: 'customer',
      entity_id: newCustomer.id,
      model: 'gpt-4o-mini',
      status: 'active'
    });

    console.log('[ADD CUSTOMER] Created:', newCustomer.id);
    return c.json({ success: true, customer_id: newCustomer.id }, 201);
  } catch (err) {
    console.error('[ADD CUSTOMER] Error:', err);
    return c.json({ error: 'server_error' }, 500);
  }
});

// Create Custom Filter Tab
app.post('/api/tags', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const token = authHeader.split(' ')[1];

    if (!supabase) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Validate token
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData.user) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const authId = userData.user.id;

    // Get organisation_id
    const { data: userRecord } = await supabase
      .from('users')
      .select('organisation_id, id')
      .eq('auth_id', authId)
      .single();

    if (!userRecord) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const body = await c.req.json();
    const { name, color } = body;

    // Validate
    if (!name || name.length === 0 || name.length > 20) {
      return c.json({ error: 'name_too_long' }, 400);
    }

    // Check for duplicate
    const { data: existing } = await supabase
      .from('tags')
      .select('id')
      .eq('organisation_id', userRecord.organisation_id)
      .eq('name', name)
      .single();

    if (existing) {
      return c.json({ error: 'duplicate_name' }, 400);
    }

    // Create tag
    const { data: newTag, error: createError } = await supabase
      .from('tags')
      .insert({
        organisation_id: userRecord.organisation_id,
        name: name,
        color: color || '#6366f1',
        is_system: false,
        created_by: userRecord.id,
      })
      .select('id, name, color')
      .single();

    if (createError) {
      console.error('Tag creation error:', createError);
      return c.json({ error: 'server_error' }, 500);
    }

    return c.json(newTag);

  } catch (error) {
    console.error('Create tag error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
// FLOW 3A — CUSTOMER CHAT ROUTES
// ══════════════════════════════════════════════════════════════

// Auth + org helper (reusable for chat routes)
async function authenticateChat(c) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  if (!supabase) return null;
  const { data: userData, error } = await supabase.auth.getUser(token);
  if (error || !userData.user) return null;
  const { data: userRecord } = await supabase
    .from('users').select('id, organisation_id, organisations(primary_language, customer_language_auto)').eq('auth_id', userData.user.id).single();
  if (!userRecord) return null;
  return {
    userId: userRecord.id,
    organisationId: userRecord.organisation_id,
    primaryLanguage: userRecord.organisations?.primary_language || 'en',
    customerLanguageAuto: userRecord.organisations?.customer_language_auto || false,
  };
}

// Validate customer belongs to org
async function validateCustomer(customerId, organisationId) {
  const { data: customer, error } = await supabase
    .from('customers')
    .select('id, name, phone, outstanding_balance, status, custom_fields')
    .eq('id', customerId)
    .eq('organisation_id', organisationId)
    .maybeSingle();
  if (error || !customer) return null;
  return customer;
}

// ─── GET /api/chat/:customer_id ────────────────────────────
app.get('/api/chat/:customer_id', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const customerId = c.req.param('customer_id');

    // 1. Validate customer belongs to org
    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    // Shape customer header data
    const nameParts = (customer.name || '').split(' ').filter(Boolean);
    const initials = nameParts.map(p => p[0]).join('').toUpperCase().slice(0, 2);
    const avatarColor = customer.custom_fields?.avatar_color || '#075E54';
    const healthScore = customer.custom_fields?.health_score ?? null;
    const outstandingBalance = (customer.outstanding_balance && customer.outstanding_balance > 0)
      ? customer.outstanding_balance : null;

    // Compute payable_balance and net_position for correct chat header display
    // Net position = receivable (they owe us) - payable (we owe them)
    // Positive = they owe us, Negative = we owe them
    let payableBalance = 0;
    try {
      const { data: pbRows } = await supabase
        .from('purchase_bills')
        .select('amount_due')
        .eq('organisation_id', organisationId)
        .eq('customer_id', customerId)
        .eq('is_historical', false)
        .is('deleted_at', null)
        .not('status', 'in', '("paid","cancelled")')
        .gt('amount_due', 0);
      payableBalance = (pbRows || []).reduce((s, r) => s + Number(r.amount_due), 0);
      payableBalance = Math.round(payableBalance * 100) / 100;
    } catch (pbErr) {
      console.warn('[CHAT] payable_balance query failed (non-fatal):', pbErr.message);
    }
    const netPosition = Math.round(((customer.outstanding_balance || 0) - payableBalance) * 100) / 100;
    const netDirection = netPosition > 0.01 ? 'receivable' : payableBalance - (customer.outstanding_balance || 0) > 0.01 ? 'payable' : 'settled';

    // 2. Fetch or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('entity_type', 'customer')
      .eq('entity_id', customerId)
      .eq('status', 'active')
      .maybeSingle();

    if (!conversation) {
      const { data: newConv, error: createErr } = await supabase
        .from('conversations')
        .insert({
          organisation_id: organisationId,
          user_id: userId,
          entity_type: 'customer',
          entity_id: customerId,
          model: 'gpt-4o-mini',
          status: 'active',
        })
        .select('id')
        .single();
      if (createErr) {
        console.error('Create conversation error:', createErr);
        return c.json({ error: 'server_error' }, 500);
      }
      conversation = newConv;
    }

    // 3. Fetch messages (only if conversation exists)
    let messages = [];
    let hasMore = false;
    if (conversation?.id) {
      const before = c.req.query('before');
      let query = supabase
        .from('messages')
        .select('id, role, content, metadata, created_at')
        .eq('conversation_id', conversation.id)
        .or('metadata->>message_type.is.null,metadata->>message_type.not.in.(ai_query,ai_response,action_card)')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(31);

      if (before) {
        query = query.lt('created_at', before);
      }

      const { data: msgData, error: msgErr } = await query;

      if (!msgErr && msgData) {
        hasMore = msgData.length === 31;
        const slice = hasMore ? msgData.slice(0, 30) : msgData;
        messages = slice.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          sender_type: m.metadata?.sender_type || null,
          visibility: m.metadata?.visibility || 'both',
          message_type: m.metadata?.message_type || 'text',
          card_type: m.metadata?.card_type || null,
          card_data: m.metadata?.card_data || {},
          preview_text: m.metadata?.preview_text || null,
          metadata: m.metadata || {},
        })).reverse();
      }

      // 4. Mark unread messages as read using jsonb_set
      const markRead = c.req.query('mark_read') !== 'false';
      if (markRead) try {
        const { data: unreadMsgs } = await supabase
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .eq('metadata->>read_by_owner', 'false');

        if (unreadMsgs && unreadMsgs.length > 0) {
          const unreadIds = unreadMsgs.map(m => m.id);
          // Update read_by_owner per row using Supabase client
          for (const uid of unreadIds) {
            const { data: row } = await supabase.from('messages').select('metadata').eq('id', uid).single();
            if (row) {
              await supabase.from('messages').update({
                metadata: { ...(row.metadata || {}), read_by_owner: true }
              }).eq('id', uid);
            }
          }
        }
      } catch (err) {
        console.warn('Mark messages read failed:', err.message);
      }
    }

    return c.json({
      conversation_id: conversation.id,
      customer: {
        id: customer.id,
        name: customer.name,
        initials,
        avatar_color: avatarColor,
        outstanding_balance: outstandingBalance,
        payable_balance: payableBalance > 0 ? payableBalance : null,
        net_position: netPosition,
        net_direction: netDirection,
        health_score: healthScore,
        status: customer.status || 'active',
        phone: customer.phone || null,
      },
      messages,
      has_more: hasMore,
    });

  } catch (error) {
    console.error('GET /api/chat error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/chat/:customer_id/message ───────────────────
app.post('/api/upload', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    const formData = await c.req.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return c.json({ error: 'no_file', message: 'No file provided' }, 400);
    }

    const mimeType = file.type || 'application/octet-stream';
    const originalName = file.name || 'upload';

    const allowed = ['image/', 'audio/', 'application/pdf'];
    if (!allowed.some(prefix => mimeType.startsWith(prefix))) {
      return c.json({ error: 'invalid_mime', message: 'File type not allowed' }, 400);
    }

    const ext = originalName.split('.').pop() || 'bin';
    const timestamp = Date.now();
    const fileName = `${timestamp}-${crypto.randomUUID()}.${ext}`;
    const storagePath = `${organisationId}/${fileName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > 10 * 1024 * 1024) {
      return c.json({ error: 'file_too_large', message: 'File exceeds 10MB limit' }, 400);
    }

    const { error: uploadErr } = await supabase.storage
      .from('chat-attachments')
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadErr) {
      console.error('Storage upload error:', uploadErr);
      return c.json({ error: 'upload_failed', message: uploadErr.message }, 500);
    }

    const { data: publicUrlData } = supabase.storage
      .from('chat-attachments')
      .getPublicUrl(storagePath);

    return c.json({
      url: publicUrlData.publicUrl,
      mime_type: mimeType,
      storage_path: storagePath,
      size: buffer.length,
      name: originalName,
    });

  } catch (err) {
    console.error('POST /api/upload error:', err);
    return c.json({ error: 'server_error' }, 500);
  }
});

app.post('/api/chat/:customer_id/message', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId, userId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const content = body.content?.trim();
    const conversationId = body.conversation_id;
    const frontendMetadata = body.metadata || {};

    if (!content || content.length === 0) return c.json({ error: 'empty_message' }, 400);
    if (content.length > 2000) return c.json({ error: 'message_too_long' }, 400);
    if (!conversationId) return c.json({ error: 'missing_conversation_id' }, 400);

    // Validate conversation belongs to org
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('organisation_id', organisationId)
      .maybeSingle();
    if (!conv) return c.json({ error: 'conversation_not_found' }, 404);

    const previewText = frontendMetadata.message_type === 'image' ? '📷 Photo' :
      frontendMetadata.message_type === 'audio' ? '🎵 Voice message' :
      frontendMetadata.message_type === 'file' ? '📄 Document' :
      content.length > 50 ? content.substring(0, 50) + '...' : content;

    const { data: savedMsg, error: saveErr } = await supabase
      .from('messages')
      .insert({
        organisation_id: organisationId,
        conversation_id: conversationId,
        role: 'assistant',
        content,
        metadata: {
          ...frontendMetadata,
          sender_type: 'owner',
          visibility: 'both',
          read_by_owner: true,
          preview_text: previewText,
        },
        tokens_input: 0,
        tokens_output: 0,
      })
      .select('id, created_at, metadata')
      .single();

    if (saveErr) {
      console.error('Save owner message error:', saveErr);
      return c.json({ error: 'server_error' }, 500);
    }

    // Broadcast to sender's org
    await broadcastNewMessage(organisationId, { conversation_id: conversationId });

    // ─── CROSS-ORG ROUTING ────────────────────────────────────────
    // After saving message to sender's org, check if receiver is also an AssistMe user
    const customerPhone = customer?.phone;
    const savedMessageId = savedMsg.id;
    const normalizePhone = (p) => p ? p.replace(/\D/g, '').padStart(12, '').slice(-12).replace(/^0+/, '') : null;

    if (customerPhone) {
      try {
        const normalizedCustomerPhone = normalizePhone(customerPhone);
        // Look up if any AssistMe user has this phone number
        const { data: allUsers } = await supabase
          .from('users')
          .select('id, organisation_id, phone, push_token')
          .neq('organisation_id', organisationId);
        const receiverUser = (allUsers || []).find(u => normalizePhone(u.phone) === normalizedCustomerPhone) || null;

        if (receiverUser && receiverUser.organisation_id !== organisationId) {
          // Receiver is an AssistMe user in a different org
          // Find or create a conversation in their org for the sender's phone
          
          // Get sender's phone to identify them in receiver's org
          const { data: senderUser } = await supabase
            .from('users')
            .select('phone')
            .eq('id', userId)
            .maybeSingle();

          if (senderUser?.phone) {
            const normalizedSenderPhone = normalizePhone(senderUser.phone);
            // Find the customer record in receiver's org that matches sender's phone
            const { data: allReceiverCustomers } = await supabase
              .from('customers')
              .select('id, name, phone')
              .eq('organisation_id', receiverUser.organisation_id);
            let senderAsCustomer = (allReceiverCustomers || []).find(c => normalizePhone(c.phone) === normalizedSenderPhone) || null;

            // Auto-create sender as customer in receiver's org if not exists (WhatsApp behaviour)
            if (!senderAsCustomer) {
              const senderName = senderUser.phone || 'Unknown';
              const avatarColors = ['#E53935','#8E24AA','#1E88E5','#43A047','#F57C00','#00897B'];
              const avatarColor = avatarColors[Math.floor(Math.random() * avatarColors.length)];
              const { data: newCustomer } = await supabase
                .from('customers')
                .insert({
                  organisation_id: receiverUser.organisation_id,
                  name: senderName,
                  phone: normalizedSenderPhone,
                  currency: 'INR',
                  outstanding_balance: 0,
                  status: 'active',
                  custom_fields: { avatar_color: avatarColor, cross_org: true },
                })
                .select('id')
                .single();
              if (newCustomer) {
                senderAsCustomer = newCustomer;
                console.log('[CROSS-ORG] Auto-created customer in receiver org:', newCustomer.id);
              }
            }

            if (senderAsCustomer) {
              // Find or create conversation in receiver's org
              let { data: receiverConversation } = await supabase
                .from('conversations')
                .select('id')
                .eq('organisation_id', receiverUser.organisation_id)
                .eq('entity_type', 'customer')
                .eq('entity_id', senderAsCustomer.id)
                .eq('status', 'active')
                .maybeSingle();

              // Auto-create conversation if not exists (WhatsApp behaviour)
              if (!receiverConversation) {
                const { data: newConv } = await supabase
                  .from('conversations')
                  .insert({
                    organisation_id: receiverUser.organisation_id,
                    user_id: receiverUser.id,
                    entity_type: 'customer',
                    entity_id: senderAsCustomer.id,
                    model: 'gpt-4o-mini',
                    status: 'active',
                  })
                  .select('id')
                  .single();
                receiverConversation = newConv;
                console.log('[CROSS-ORG] Auto-created conversation in receiver org:', newConv?.id);
              }

              if (receiverConversation) {
                await supabase.from('messages').insert({
                  organisation_id: receiverUser.organisation_id,
                  conversation_id: receiverConversation.id,
                  role: 'user',
                  content,
                  metadata: {
                    ...frontendMetadata,
                    sender_type: 'customer',
                    message_type: frontendMetadata.message_type || 'text',
                    visibility: 'both',
                    preview_text: previewText,
                    read_by_owner: false,
                    cross_org: true,
                    sender_org_id: organisationId,
                  },
                  delivery_status: 'delivered',
                  tokens_input: 0,
                  tokens_output: 0,
                });

                console.log('[CROSS-ORG] Message routed to org:', receiverUser.organisation_id);
                await broadcastNewMessage(receiverUser.organisation_id, { conversation_id: receiverConversation.id });
                // Push notification to receiver
                if (receiverUser.push_token) {
                  try {
                    const senderDisplayName = senderAsCustomer?.name || senderUser?.phone || 'Someone';
                    // Count total unread messages for receiver org
                    const { count: unreadCount } = await supabase
                      .from('messages')
                      .select('*', { count: 'exact', head: true })
                      .eq('organisation_id', receiverUser.organisation_id)
                      .eq('role', 'user')
                      .eq('metadata->>read_by_owner', 'false');
                    const badgeCount = (unreadCount || 0) + 1;
                    await fetch('https://exp.host/--/api/v2/push/send', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                      },
                      body: JSON.stringify({
                        to: receiverUser.push_token,
                        title: senderDisplayName,
                        body: content.length > 100 ? content.substring(0, 100) + '...' : content,
                        data: { conversation_id: receiverConversation.id },
                        sound: 'default',
                        channelId: 'messages_v2',
                        badge: badgeCount,
                      }),
                    });
                    console.log('[PUSH] Notification sent to:', receiverUser.push_token);
                  } catch (pushError) {
                    console.error('[PUSH] Failed (non-fatal):', pushError.message);
                  }
                }

                await supabase
                  .from('messages')
                  .update({ delivery_status: 'delivered' })
                  .eq('id', savedMessageId);
              }
            }
          }
        }
      } catch (crossOrgError) {
        // Cross-org routing failure must NEVER break the main message flow
        console.error('[CROSS-ORG] Routing error (non-fatal):', crossOrgError);
      }
    }

    return c.json({ message_id: savedMsg.id, created_at: savedMsg.created_at });

  } catch (error) {
    console.error('POST /api/chat/message error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/chat/:customer_id/reminder ──────────────────
app.post('/api/chat/:customer_id/reminder', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const invoiceId = body.invoice_id;
    if (!invoiceId) return c.json({ error: 'missing_invoice_id' }, 400);

    // Fetch invoice
    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, total_amount, due_date, status, amount_paid')
      .eq('id', invoiceId)
      .eq('organisation_id', organisationId)
      .maybeSingle();

    if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);
    if (invoice.status === 'paid') return c.json({ error: 'invoice_already_paid' }, 400);

    // Build WhatsApp reminder link
    const phone = (customer.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return c.json({ error: 'no_phone_number' }, 400);

    const amountDue = (invoice.total_amount || 0) - (invoice.amount_paid || 0);
    const reminderText = encodeURIComponent(
      `Hi ${customer.name}, this is a reminder about your pending invoice of ₹${amountDue.toLocaleString('en-IN')} (due: ${new Date(invoice.due_date).toLocaleDateString('en-IN')}). Please arrange payment at your earliest convenience.`
    );
    const whatsappUrl = `https://wa.me/${phone}?text=${reminderText}`;

    // Save reminder message to conversation
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('entity_type', 'customer')
      .eq('entity_id', customerId)
      .eq('status', 'active')
      .maybeSingle();

    let messageId = null;
    if (conv) {
      const { data: savedMsg } = await supabase
        .from('messages')
        .insert({
          organisation_id: organisationId,
          conversation_id: conv.id,
          role: 'assistant',
          content: `Payment reminder sent for ₹${amountDue.toLocaleString('en-IN')}`,
          metadata: {
            sender_type: 'owner',
            visibility: 'both',
            message_type: 'text',
            read_by_owner: true,
            preview_text: `Reminder sent for ₹${amountDue.toLocaleString('en-IN')}`,
          },
          tokens_input: 0,
          tokens_output: 0,
        })
        .select('id')
        .single();
      messageId = savedMsg?.id;
    }

    return c.json({ sent: true, message_id: messageId, whatsapp_url: whatsappUrl });

  } catch (error) {
    console.error('POST /api/chat/reminder error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/payments ────────────────────────────────────
app.post('/api/payments', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    const body = await c.req.json();
    const { customer_id, invoice_id, amount, payment_date } = body;

    if (!customer_id || !invoice_id || !amount) {
      return c.json({ error: 'missing_fields' }, 400);
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return c.json({ error: 'invalid_amount' }, 400);
    }

    // Validate customer
    const customer = await validateCustomer(customer_id, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    // Validate invoice
    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, total_amount, amount_paid, status')
      .eq('id', invoice_id)
      .eq('organisation_id', organisationId)
      .maybeSingle();

    if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);
    if (invoice.status === 'paid') return c.json({ error: 'invoice_already_paid' }, 400);

    const maxPayable = (invoice.total_amount || 0) - (invoice.amount_paid || 0);
    if (amount > maxPayable) {
      return c.json({ error: 'amount_exceeds_due', max_payable: maxPayable }, 400);
    }

    // Step 1: Update invoice (MUST succeed before touching customer balance)
    const newAmountPaid = (invoice.amount_paid || 0) + amount;
    const newStatus = newAmountPaid >= (invoice.total_amount || 0) ? 'paid' : 'partial';

    const { error: invoiceErr } = await supabase
      .from('invoices')
      .update({ amount_paid: newAmountPaid, status: newStatus })
      .eq('id', invoice_id)
      .eq('organisation_id', organisationId);

    if (invoiceErr) {
      console.error('Invoice update failed:', invoiceErr);
      return c.json({ error: 'server_error', message: 'Failed to update invoice' }, 500);
    }

    // Step 2: Update customer balance (only after invoice update succeeds)
    let balanceWarning = null;
    const newBalance = Math.max(0, (customer.outstanding_balance || 0) - amount);

    const { error: balanceErr } = await supabase
      .from('customers')
      .update({ outstanding_balance: newBalance })
      .eq('id', customer_id)
      .eq('organisation_id', organisationId);

    if (balanceErr) {
      console.error('Customer balance update failed:', balanceErr);
      balanceWarning = 'Invoice updated but customer balance sync failed. Please verify manually.';
    }

    // Step 3: Record payment pattern in entity_memory
    try {
      await supabase.from('entity_memory').insert({
        organisation_id: organisationId,
        entity_type: 'customer',
        entity_id: customer_id,
        memory_key: 'last_payment_amount',
        memory_value: amount.toString(),
        confidence: 1.0,
      });
    } catch (memErr) {
      console.warn('entity_memory write failed:', memErr.message);
    }

    return c.json({
      payment_id: invoice_id,
      new_status: newStatus,
      new_balance: newBalance,
      warning: balanceWarning,
    });

  } catch (error) {
    console.error('POST /api/payments error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});


// ──────────────────────────────────────────────────────────────
// calculateInvoiceTotals — SINGLE SOURCE OF TRUTH FOR ALL FINANCIAL MATH
// Called by: spark confirm, form invoice, quote creation, photo invoice,
//            convert quote to invoice.
// NEVER compute totals inline anywhere. Always call this function.
// Does NOT write to DB. Pure async calculation only.
// ──────────────────────────────────────────────────────────────
async function calculateInvoiceTotals(supabaseClient, organisationId, customerId, items, options = {}) {
  /*
   * items: array of {
   *   product_id: uuid or null,
   *   product_name: string,
   *   quantity: number,
   *   unit_price: number or null,   // if null, fetched from products table
   *   tax_rate: number or null,     // if null, fetched from products table
   *   discount_pct: number,         // 0 if none
   * }
   * options: {
   *   freight: number,              // additional freight/packing charge
   *   freight_taxable: boolean,     // whether freight attracts GST
   *   freight_tax_rate: number,     // GST rate on freight (default 18)
   *   apply_gst: boolean,           // false for Bill of Supply / unregistered
   *   overall_discount: number,     // flat discount on subtotal
   *   invoice_type: string,         // 'Tax Invoice' | 'Bill of Supply' | 'Export Invoice'
   * }
   * Returns: {
   *   line_items, subtotal, total_discount, taxable_amount,
   *   cgst, sgst, igst, total_tax, freight_amount, freight_tax,
   *   round_off, grand_total, is_interstate
   * }
   */

  // invoice_type drives GST application
  const invoiceType = options.invoice_type || 'Tax Invoice';
  const applyGST = options.apply_gst !== false &&
                   invoiceType !== 'Bill of Supply';

  // Determine intra/interstate from org settings and customer billing address
  let supplierState = null;
  let customerState = null;
  try {
    const { data: orgData } = await supabaseClient
      .from('organisations').select('settings')
      .eq('id', organisationId).single();
    supplierState = orgData?.settings?.gstin_state || null;
  } catch {}
  try {
    const { data: addrs } = await supabaseClient
      .from('customer_addresses').select('state')
      .eq('customer_id', customerId)
      .eq('organisation_id', organisationId)
      .eq('type', 'billing')
      .limit(1);
    customerState = addrs?.[0]?.state || null;
  } catch {}

  // Both states known and different = interstate = IGST
  // Same states or either unknown = intrastate = CGST+SGST
  const isInterstate = !!(supplierState && customerState &&
    supplierState.toLowerCase() !== customerState.toLowerCase());

  let subtotal = 0;
  let cgst = 0, sgst = 0, igst = 0, totalTax = 0;
  const lineItems = [];

  for (const item of items) {
    const qty = Number(item.quantity) || 1;
    let unitPrice = item.unit_price != null ? Number(item.unit_price) : null;
    let taxRate = item.tax_rate != null ? Number(item.tax_rate) : null;
    let productId = item.product_id || null;
    let productName = item.product_name || 'Item';

    // Fetch price and tax rate from products table if not supplied
    if ((unitPrice === null || taxRate === null) && productId) {
      try {
        const { data: product } = await supabaseClient
          .from('products').select('id, name, selling_price, tax_rate')
          .eq('id', productId)
          .eq('organisation_id', organisationId)
          .eq('is_active', true)
          .single();
        if (product) {
          if (unitPrice === null) unitPrice = Number(product.selling_price) || 0;
          if (taxRate === null) taxRate = Number(product.tax_rate) || 0;
          productName = product.name;
        }
      } catch {}
    }

    unitPrice = unitPrice || 0;
    taxRate = taxRate || 0;
    const discountPct = Number(item.discount_pct) || 0;

    const grossLine = Math.round(qty * unitPrice * 100) / 100;
    const discountAmount = Math.round(grossLine * (discountPct / 100) * 100) / 100;
    const taxableLine = Math.round((grossLine - discountAmount) * 100) / 100;
    const taxAmount = applyGST
      ? Math.round(taxableLine * (taxRate / 100) * 100) / 100
      : 0;

    subtotal += taxableLine;
    totalTax += taxAmount;

    if (applyGST && taxAmount > 0) {
      if (isInterstate) {
        igst += taxAmount;
      } else {
        cgst += Math.round(taxAmount / 2 * 100) / 100;
        sgst += Math.round(taxAmount / 2 * 100) / 100;
      }
    }

    lineItems.push({
      product_id: productId,
      product_name: productName,
      quantity: qty,
      unit_price: unitPrice,
      discount_pct: discountPct,
      tax_rate: applyGST ? taxRate : 0,
      taxable_amount: taxableLine,
      tax_amount: taxAmount,
      line_total: Math.round((taxableLine + taxAmount) * 100) / 100,
    });
  }

  const overallDiscount = Number(options.overall_discount) || 0;
  const adjustedSubtotal = Math.round((subtotal - overallDiscount) * 100) / 100;

  // Freight and its GST
  const freightAmount = Math.round((Number(options.freight) || 0) * 100) / 100;
  let freightTax = 0;
  if (freightAmount > 0 && options.freight_taxable && applyGST) {
    const freightTaxRate = Number(options.freight_tax_rate) || 18;
    freightTax = Math.round(freightAmount * (freightTaxRate / 100) * 100) / 100;
    totalTax += freightTax;
    if (isInterstate) {
      igst += freightTax;
    } else {
      cgst += Math.round(freightTax / 2 * 100) / 100;
      sgst += Math.round(freightTax / 2 * 100) / 100;
    }
  }

  const preRoundTotal = adjustedSubtotal + totalTax + freightAmount;
  const grandTotal = Math.round(preRoundTotal);
  const roundOff = Math.round((grandTotal - preRoundTotal) * 100) / 100;

  return {
    line_items: lineItems,
    subtotal: Math.round(adjustedSubtotal * 100) / 100,
    total_discount: Math.round(overallDiscount * 100) / 100,
    taxable_amount: Math.round(adjustedSubtotal * 100) / 100,
    cgst: Math.round(cgst * 100) / 100,
    sgst: Math.round(sgst * 100) / 100,
    igst: Math.round(igst * 100) / 100,
    total_tax: Math.round(totalTax * 100) / 100,
    freight_amount: freightAmount,
    freight_tax: freightTax,
    round_off: roundOff,
    grand_total: grandTotal,
    is_interstate: isInterstate,
    invoice_type: invoiceType,
    apply_gst: applyGST,
  };
}

// ─── generateDocumentPDF ─────────────────────────────────────
// Unified PDF generator for invoices and quotations.
// documentType: 'invoice' | 'quotation'
async function generateDocumentPDF({ documentId, organisationId, documentType, documentNumber, title, storageBucket, entityType }) {
  try {
    // Fetch document data
    const itemsTable = documentType === 'invoice' ? 'invoice_items' : 'quotation_items';
    const itemsForeignKey = documentType === 'invoice' ? 'invoice_id' : 'quotation_id';
    const { data: doc } = await supabase.from(documentType === 'invoice' ? 'invoices' : 'quotations')
      .select('*').eq('id', documentId).single();
    if (!doc) { console.error(`[PDF] ${documentType} not found:`, documentId); return null; }

    const { data: items } = await supabase.from(itemsTable).select('*')
      .eq(itemsForeignKey, documentId).order('sort_order');
    const { data: customer } = await supabase.from('customers')
      .select('name, phone, tax_id').eq('id', doc.customer_id).single();
    const { data: org } = await supabase.from('organisations')
      .select('name').eq('id', organisationId).single();

    // Fetch business profile header_cache
    const { data: bizProfile } = await supabase.from('business_profiles')
      .select('business_name, gstin, address_line1, address_line2, city, state, postal_code, phone, email, terms_text, header_cache')
      .eq('organisation_id', organisationId).eq('is_default', true).eq('is_active', true)
      .is('deleted_at', null).maybeSingle();

    // Fetch footer promo from system_config
    let footerPromo = '';
    try {
      const { data: sysConfig } = await supabase.from('system_config')
        .select('value').eq('key', 'pdf_footer_promo').eq('is_active', true).maybeSingle();
      if (sysConfig) footerPromo = sysConfig.value || '';
    } catch {}

    const PDFDocument = (await import('pdfkit')).default;
    const doc2 = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc2.on('data', chunk => chunks.push(chunk));
    const pdfReady = new Promise((resolve) => doc2.on('end', resolve));

    // ── Header: Business Profile
    const biz = bizProfile || {};
    const businessName = biz.business_name || org?.name || 'Business';
    doc2.fontSize(18).font('Helvetica-Bold').text(businessName, { align: 'center' });
    if (biz.gstin) doc2.fontSize(9).font('Helvetica').text(`GSTIN: ${biz.gstin}`, { align: 'center' });
    const addressParts = [biz.address_line1, biz.address_line2, biz.city, biz.state, biz.postal_code].filter(Boolean);
    if (addressParts.length > 0) doc2.fontSize(9).text(addressParts.join(', '), { align: 'center' });
    if (biz.phone) doc2.fontSize(9).text(`Phone: ${biz.phone}`, { align: 'center' });
    doc2.moveDown(0.5);
    doc2.moveTo(50, doc2.y).lineTo(545, doc2.y).stroke();
    doc2.moveDown(0.3);

    // ── Document title and number
    doc2.fontSize(14).font('Helvetica-Bold').text(title, { align: 'center' });
    doc2.moveDown(0.3);
    doc2.fontSize(10).font('Helvetica').text(`${documentType === 'invoice' ? 'Invoice' : 'Quote'} #: ${documentNumber}`, { align: 'right' });
    doc2.text(`Date: ${doc.issue_date}`, { align: 'right' });
    if (doc.due_date) doc2.text(`${documentType === 'invoice' ? 'Due' : 'Valid Until'}: ${doc.due_date || doc.expiry_date}`, { align: 'right' });
    doc2.moveDown(0.5);

    // ── Bill To
    doc2.fontSize(11).font('Helvetica-Bold').text('BILL TO:');
    doc2.font('Helvetica').fontSize(10).text(customer?.name || '');
    if (customer?.tax_id) doc2.text(`GSTIN: ${customer.tax_id}`);
    doc2.moveDown(1);

    // ── Items table header
    const tableTop = doc2.y;
    doc2.font('Helvetica-Bold').fontSize(9);
    doc2.text('#', 50, tableTop, { width: 20 });
    doc2.text('Item', 75, tableTop, { width: 200 });
    doc2.text('Qty', 280, tableTop, { width: 40, align: 'right' });
    doc2.text('Rate', 330, tableTop, { width: 70, align: 'right' });
    doc2.text('Tax', 405, tableTop, { width: 40, align: 'right' });
    doc2.text('Amount', 450, tableTop, { width: 95, align: 'right' });
    doc2.moveDown(0.3);
    doc2.moveTo(50, doc2.y).lineTo(545, doc2.y).stroke();
    doc2.moveDown(0.3);

    // ── Items
    doc2.font('Helvetica').fontSize(9);
    (items || []).forEach((item, i) => {
      const y = doc2.y;
      doc2.text(`${i + 1}`, 50, y, { width: 20 });
      doc2.text(item.description || '', 75, y, { width: 200 });
      doc2.text(`${item.quantity}`, 280, y, { width: 40, align: 'right' });
      doc2.text(`₹${(item.unit_price || 0).toFixed(2)}`, 330, y, { width: 70, align: 'right' });
      doc2.text(`${item.tax_rate || 0}%`, 405, y, { width: 40, align: 'right' });
      doc2.text(`₹${(item.line_total || 0).toFixed(2)}`, 450, y, { width: 95, align: 'right' });
      doc2.moveDown(0.5);
    });

    doc2.moveDown(0.3);
    doc2.moveTo(50, doc2.y).lineTo(545, doc2.y).stroke();
    doc2.moveDown(0.5);

    // ── Totals
    const totalsX = 380;
    doc2.font('Helvetica').fontSize(10);
    doc2.text('Subtotal:', totalsX, doc2.y, { width: 70 });
    doc2.text(`₹${(doc.subtotal || 0).toFixed(2)}`, 450, doc2.y - 12, { width: 95, align: 'right' });
    doc2.moveDown(0.3);
    if (doc.tax_amount > 0) {
      doc2.text('GST:', totalsX, doc2.y, { width: 70 });
      doc2.text(`₹${(doc.tax_amount || 0).toFixed(2)}`, 450, doc2.y - 12, { width: 95, align: 'right' });
      doc2.moveDown(0.3);
    }
    if (doc.custom_fields?.freight_amount > 0) {
      doc2.text('Freight:', totalsX, doc2.y, { width: 70 });
      doc2.text(`₹${doc.custom_fields.freight_amount.toFixed(2)}`, 450, doc2.y - 12, { width: 95, align: 'right' });
      doc2.moveDown(0.3);
    }
    doc2.moveDown(0.2);
    doc2.font('Helvetica-Bold').fontSize(12);
    doc2.text('TOTAL:', totalsX, doc2.y, { width: 70 });
    doc2.text(`₹${(doc.total_amount || 0).toFixed(2)}`, 450, doc2.y - 14, { width: 95, align: 'right' });

    // ── Footer
    if (biz.terms_text || footerPromo) {
      doc2.moveDown(2);
      doc2.moveTo(50, doc2.y).lineTo(545, doc2.y).stroke();
      doc2.moveDown(0.3);
      if (biz.terms_text) {
        doc2.fontSize(8).font('Helvetica').text(biz.terms_text, { align: 'left' });
        doc2.moveDown(0.3);
      }
      if (footerPromo) {
        doc2.fontSize(8).font('Helvetica').fillColor('#888888').text(footerPromo, { align: 'center' });
        doc2.fillColor('#000000');
      }
    }

    doc2.end();
    await pdfReady;

    const pdfBuffer = Buffer.concat(chunks);
    const fileName = `${documentNumber}_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0,15)}.pdf`;
    const storagePath = `${organisationId}/${fileName}`;

    const { error: uploadErr } = await supabase.storage.from(storageBucket).upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf', upsert: true,
    });
    if (uploadErr) { console.error(`[PDF] Upload error:`, uploadErr); return null; }

    const { data: publicUrl } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
    const pdfUrl = publicUrl.publicUrl;

    // Save to attachments
    try {
      await supabase.from('attachments').insert({
        organisation_id: organisationId,
        entity_type: entityType,
        entity_id: documentId,
        file_name: fileName,
        mime_type: 'application/pdf',
        storage_path: storagePath,
        public_url: pdfUrl,
      });
    } catch (attErr) {
      console.warn('[PDF] Attachment record failed:', attErr);
    }

    console.log(`[PDF] Generated: ${pdfUrl}`);
    return pdfUrl;
  } catch (err) {
    console.error('[PDF] generateDocumentPDF error:', err);
    return null;
  }
}


// ══════════════════════════════════════════════════════════════
// FLOW 3A — AI SPARK ROUTES
// ══════════════════════════════════════════════════════════════

const SPARK_SYSTEM_PROMPT = `You are an action extraction assistant for an Indian MSME trader.
The customer is already identified from context — do not ask who.
Today's date: ${new Date().toISOString().split('T')[0]}

Extract ALL actions from the owner's instruction. Output ONLY this JSON — no other text:
{
  "actions": [
    {
      "action_type": "create_invoice | create_quote | convert_quote_to_invoice | schedule_delivery | update_delivery_status | set_reminder | record_payment | goods_returned | record_expense | create_purchase_bill | record_supplier_payment",
      "entities": {
        "items": [{"product_name": "string", "quantity": number, "unit_price": number or null, "discount_pct": number}],
        "amount": number or null,
        "freight": number or null,
        "packing": number or null,
        "freight_taxable": true or false,
        "overall_discount": number or null,
        "invoice_type": "Tax Invoice | Bill of Supply | null",
        "due_date": "YYYY-MM-DD or null",
        "delivery_date": "YYYY-MM-DD or null",
        "bank_account_name": "string or null",
        "payment_mode": "cash | upi | neft | cheque | null",
        "status": "completed | in_progress | cancelled or null",
        "category": "string or null",
        "description": "string or null",
        "quote_number": "string or null",
        "reason": "string or null"
      }
    }
  ],
  "confidence_score": 0.0 to 1.0,
  "reasoning": "one sentence"
}

Action rules:
- create_invoice: ALL products in entities.items as ONE action. Extract freight separately into entities.freight — never put freight in amount. Extract discount_pct per item if mentioned.
- STRICT product rule: Only extract products the owner explicitly names with a quantity. Never infer, add, or suggest products from chat history, context, or memory. Extract exactly what was said, nothing more.
- create_quote: same structure as create_invoice but output is a quote. Use when owner says quote, quotation, estimate, bhav batao.
- convert_quote_to_invoice: use when owner says convert quote to invoice. Set quote_number if mentioned.
- schedule_delivery: one action, set delivery_date.
- update_delivery_status: use when owner says maal pahunch gaya, delivered, delivery complete. Set status=completed.
- set_reminder: one action, set due_date.
- record_payment: extract amount AND bank_account_name if owner mentions a bank name. Extract payment_mode if mentioned. Extract payment_date if owner mentions when payment was received (kal/yesterday = previous day, aaj/today = current date, parso/day before yesterday, weekday references like Monday/last Friday/pichle hafte, or specific dates = YYYY-MM-DD). Default null if not mentioned — backend will use today's date.
- goods_returned: use when owner says maal wapis aaya, return, goods returned. Extract items and reason.
- record_expense: use when owner says kharcha hua, expense, paid for. Extract amount, category, description.
- create_purchase_bill: use when owner says maal aya, goods received, purchase bill, maal mila, stock aya, supplier se maal. Extract items with quantity and unit_price into entities.items. Same structure as create_invoice. due_date auto-calculated from payment terms if not specified.
- record_supplier_payment: use when owner says supplier ko diya, supplier ko payment, paid supplier, outgoing payment to supplier. Extract amount, payment_mode, bank_account_name. Same extraction as record_payment but direction is outgoing.
- invoice_type: set Bill of Supply if owner says bina GST, without GST, composition. Default is Tax Invoice.
- freight_taxable: set true only if owner explicitly says freight has GST. Default false.
- freight notation examples: "freight 50", "freight rupees 50", "freight Rs 50", "freight 50/-", "dhulai 50", "transport 50" — all mean freight=50. Always extract as number only into entities.freight.
- packing notation examples: "bundle 150", "packing 150", "box 150", "packet 150" — all mean packing=150. Always extract as number only into entities.packing.
- unit_price: if owner or image provides a per-unit price for a product, set it in the item's unit_price field. If not provided, set null — backend will fetch from catalog.
- Resolve relative dates: tomorrow or kal = next day, 7 din baad = plus 7 days from today.
- If intent is truly unclear return empty actions array with confidence_score below 0.50.
- No markdown. No preamble. JSON only.`;

const FINANCIAL_INTENTS = ['create_invoice', 'create_quote', 'record_payment', 'set_reminder', 'goods_returned', 'record_expense', 'convert_quote_to_invoice', 'create_purchase_bill', 'record_supplier_payment'];
const ALLOWED_INTENTS = ['create_invoice', 'create_quote', 'convert_quote_to_invoice', 'schedule_delivery', 'update_delivery_status', 'set_reminder', 'record_payment', 'goods_returned', 'record_expense', 'create_purchase_bill', 'record_supplier_payment', 'query', 'ambiguous'];

function parseSparkResponse(text) {
  try {
    const jsonMatch = text.match(/{[\s\S]*}/);
    if (!jsonMatch) return { actions: [], confidence_score: 0.0, reasoning: 'Could not parse response' };
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.actions)) {
      const validActions = parsed.actions
        .filter(a => a && ALLOWED_INTENTS.includes(a.action_type))
        .map(a => ({
          action_type: a.action_type,
          entities: (typeof a.entities === 'object' && a.entities) ? a.entities : {},
        }));
      return {
        actions: validActions,
        confidence_score: Math.min(1.0, Math.max(0, parseFloat(parsed.confidence_score) || 0.0)),
        reasoning: parsed.reasoning || '',
      };
    }
    let intent = parsed.intent || 'ambiguous';
    if (!ALLOWED_INTENTS.includes(intent)) intent = 'ambiguous';
    let confidence = parseFloat(parsed.confidence_score) || 0.0;
    if (confidence < 0 || confidence > 1) confidence = 0.0;
    return {
      actions: intent !== 'ambiguous' ? [{
        action_type: intent,
        entities: (typeof parsed.entities === 'object' && parsed.entities) ? parsed.entities : {},
      }] : [],
      confidence_score: confidence,
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return { actions: [], confidence_score: 0.0, reasoning: 'Parse error' };
  }
}

// ─── Vocabulary normalisation helper (module level) ─────────
// Single source of truth for all read/write paths
// Must match exactly how values are stored in product_vocabularies.normalised
function normaliseVocabulary(v) {
  return (v || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '');
}

// ─────────────────────────────────────────────────────────────
// Product Intelligence Engine
// Pure deterministic resolver — single source of truth for all
// product matching. Screens and routes call this only via API.
// Never implement custom matching elsewhere. (INV-9)
// ─────────────────────────────────────────────────────────────

async function resolveProduct({ productName, customerId, organisationId }) {
  if (!productName) return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };

  // Clamp input length to prevent pathological fuzzy scans
  const cleanName = productName.trim().slice(0, 120);
  const nameLower = normaliseVocabulary(cleanName);

  // Step 1: exact match
  const { data: exact } = await supabase
    .from('products').select('id, name, selling_price, tax_rate, sku')
    .eq('organisation_id', organisationId).eq('is_active', true)
    .ilike('name', cleanName).limit(1);
  if (exact?.length > 0) {
    return { resolved: exact[0], alternatives: [], confidence: 1.0, resolution_type: 'exact' };
  }

  // Step 2: vocabulary table lookup (owner-confirmed aliases)
  const { data: vocabRows } = await supabase
    .from('product_vocabularies')
    .select('product_id, match_strength, confirmed_count, products:product_id (id, name, selling_price, tax_rate, sku)')
    .eq('organisation_id', organisationId)
    .eq('normalised', nameLower)
    .eq('is_active', true)
    .order('confirmed_count', { ascending: false })
    .order('match_strength', { ascending: false })
    .limit(1);
  if (vocabRows?.length > 0 && vocabRows[0].products) {
    return { resolved: vocabRows[0].products, alternatives: [], confidence: 0.9, resolution_type: 'vocabulary' };
  }

  // Step 3: fuzzy/partial match with stable ordering + behavioral ranking
  const { data: fuzzy, error: fuzzyErr } = await supabase
    .rpc('search_products_fuzzy', {
      p_organisation_id: organisationId,
      p_search_term: cleanName,
      p_limit: 10,
      p_threshold: 0.15,
    });
  if (fuzzyErr) {
    console.error('[RESOLVE_PRODUCT] fuzzy rpc error:', fuzzyErr.message);
    return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };
  }
  if (!fuzzy || fuzzy.length === 0) {
    return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };
  }

  const productIds = fuzzy.map(p => p.id);

  // Guard: skip .in() query if productIds is empty (prevents Supabase error)
  if (productIds.length === 0) {
    return { resolved: null, alternatives: [], confidence: 0, resolution_type: 'unresolved' };
  }

  // TODO Phase 5: Replace live invoice aggregation below with precomputed
  // customer_product_stats and organisation_product_stats tables
  // to keep resolver latency deterministic at scale.

  // Customer purchase history via invoices (capped at 50 for v1)
  const { data: custInvoices } = await supabase
    .from('invoices')
    .select('id, invoice_items(product_id, quantity)')
    .eq('organisation_id', organisationId)
    .eq('customer_id', customerId)
    .limit(50);

  // Org-wide sales volume
  const { data: orgItems } = await supabase
    .from('invoice_items').select('product_id, quantity')
    .eq('organisation_id', organisationId)
    .in('product_id', productIds);

  // Score: customer history 3x, org volume 1x
  const custCounts = {};
  (custInvoices || []).forEach(inv => {
    (inv.invoice_items || []).forEach(item => {
      if (productIds.includes(item.product_id))
        custCounts[item.product_id] = (custCounts[item.product_id] || 0) + item.quantity;
    });
  });
  const orgCounts = {};
  (orgItems || []).forEach(r => {
    orgCounts[r.product_id] = (orgCounts[r.product_id] || 0) + r.quantity;
  });

  const scored = fuzzy.map(p => ({
    ...p,
    score: (custCounts[p.id] || 0) * 3 + (orgCounts[p.id] || 0) * 1
  })).sort((a, b) => b.score - a.score);

  const confidence = scored.length === 1 ? 0.6 : 0.4;
  return {
    resolved: scored[0],
    alternatives: scored.slice(1, 3),
    confidence,
    resolution_type: 'fuzzy'
  };
}


// ─── POST /api/chat/:customer_id/spark ─────────────────────
app.post('/api/chat/:customer_id/spark', async (c) => {
  const startTime = Date.now();
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const query = body.query?.trim() || (body.forwarded_attachment ? 'Owner shared an attachment. Determine the appropriate business action from the attachment and conversation context. Default to create_invoice if unclear.' : '');
    const conversationId = body.conversation_id;
    const forwardedAttachment = body.forwarded_attachment || null;
    if (!query) return c.json({ error: 'empty_query' }, 400);
    if (!conversationId) return c.json({ error: 'missing_conversation_id' }, 400);

    // Validate conversation belongs to org
    const { data: conv } = await supabase
      .from('conversations').select('id')
      .eq('id', conversationId).eq('organisation_id', organisationId).maybeSingle();
    if (!conv) return c.json({ error: 'conversation_not_found' }, 404);

    // Layer 1: ai_context (global)
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

    // Layer 2: entity_memory for this customer
    let customerMemory = '';
    try {
      const { data: memories } = await supabase
        .from('entity_memory').select('memory_key, memory_value')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer')
        .eq('entity_id', customerId).is('deleted_at', null);
      if (memories?.length > 0) {
        customerMemory = memories.map(m => `${m.memory_key}: ${m.memory_value}`).join('\n');
      }
    } catch {}

    // Layer 3: last 15 messages
    const { data: recentMsgs } = await supabase
      .from('messages').select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(15);
    const recentText = (recentMsgs || []).reverse()
      .map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`).join('\n');

    // Build OpenAI messages
    let attachmentContext = '';
    if (forwardedAttachment) {
      if (forwardedAttachment.type === 'text') {
        attachmentContext = `\nForwarded message: ${forwardedAttachment.text || ''}`;
      } else if (forwardedAttachment.type === 'image') {
        const mime = forwardedAttachment.mime_type || '';
        const url = forwardedAttachment.url || '';
        const supabaseHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : '';
        const isValidMime = mime.startsWith('image/');
        let isValidUrl = false;
        try { const parsedUrl = new URL(url); isValidUrl = supabaseHost && parsedUrl.hostname === supabaseHost; } catch {}
        if (isValidMime && isValidUrl) {
          try {
            const fetchController = new AbortController();
            const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
            const imgRes = await fetch(url, { signal: fetchController.signal });
            clearTimeout(fetchTimeout);
            if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
            const imgBuffer = await imgRes.arrayBuffer();
            if (imgBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Image too large');
            const base64Image = Buffer.from(imgBuffer).toString('base64');
            const visionClient = getOpenAI();
            if (!visionClient) throw new Error('AI client not available');
            const visionController = new AbortController();
            const visionTimeout = setTimeout(() => visionController.abort(), 15000);
            const visionRes = await visionClient.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: 'You are reading a handwritten or printed business document from an Indian MSME trader.\n\nExtract clearly visible business information and return it in this exact readable structure:\n\nCustomer: [name and address if visible]\nDate: [date if visible]\n\nItems:\n- Product: [name as written] | Qty: [number] | Unit Price: [number] | Total: [number]\n\nFreight:\n- [name] | Amount: [number]\n\nPacking:\n- [name] | Amount: [number]\n\nGrand Total: [number]\n\nNotes: [any other relevant text]\n\nRules:\n- In Indian trader notes format is typically: ProductName = Qty x UnitPrice = LineTotal. Extract quantity and unit price separately. Never confuse price with quantity.\n- Bilti, Dhulai, Transport, Hamali, Bhada, Freight = freight charges, go under Freight section\n- Bundle, Packing, Box, Packet = packing charges, go under Packing section\n- All actual goods being sold go under Items section\n- Do not guess unclear text — omit if unreadable\n- Do not infer or add products not explicitly written\n- Return only the structured text above. No JSON. No explanation. No markdown.' },
                  { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Image}`, detail: 'low' } }
                ]
              }],
              max_tokens: 500,
            }, { signal: visionController.signal });
            clearTimeout(visionTimeout);
            const visionText = visionRes.choices?.[0]?.message?.content?.trim() || '';
            console.log('Vision extraction success:', { bytes: imgBuffer.byteLength, filename: forwardedAttachment.name, extractedChars: visionText.length });
            if (visionText) {
              attachmentContext = `\nForwarded image: ${forwardedAttachment.name || 'image'}`;
              if (forwardedAttachment.caption) attachmentContext += `\nCaption: ${forwardedAttachment.caption}`;
              attachmentContext += `\nImage content extracted:\n${visionText}`;
            } else {
              attachmentContext = `\nForwarded image: ${forwardedAttachment.name || 'image'}`;
              attachmentContext += `\nImage not clear. Tell me what it is instead (voice/text) or try again.`;
            }
          } catch (visionErr) {
            console.error('Vision extraction failed:', visionErr.message);
            attachmentContext = `\nForwarded image: ${forwardedAttachment.name || 'image'}`;
            attachmentContext += `\nImage not clear. Tell me what it is instead (voice/text) or try again.`;
          }
        } else {
          attachmentContext = `\nForwarded image: ${forwardedAttachment.name || 'image'}`;
          attachmentContext += `\nImage not clear. Tell me what it is instead (voice/text) or try again.`;
        }
      } else if (forwardedAttachment.type === 'audio') {
        const mime = forwardedAttachment.mime_type || '';
        const url = forwardedAttachment.url || '';
        const name = forwardedAttachment.name || 'audio';
        const ext = name.split('.').pop()?.toLowerCase() || '';
        const supabaseHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : '';
        const isValidMime = mime.startsWith('audio/');
        const isValidExt = ['m4a', 'mp3', 'wav', 'ogg', 'webm'].includes(ext);
        let isValidUrl = false;
        try { const parsedUrl = new URL(url); isValidUrl = supabaseHost && parsedUrl.hostname === supabaseHost; } catch {}
        if (isValidMime && isValidExt && isValidUrl) {
          let fetchController2, fetchTimeout2;
          try {
            fetchController2 = new AbortController();
            fetchTimeout2 = setTimeout(() => fetchController2.abort(), 10000);
            const audioRes = await fetch(url, { signal: fetchController2.signal });
            if (!audioRes.ok) throw new Error('Audio fetch failed');
            const audioBuffer = await audioRes.arrayBuffer();
            if (audioBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Audio too large');
            const { toFile } = await import('openai');
            const audioFile = await toFile(Buffer.from(audioBuffer), name, { type: mime });
            const whisperClient = getOpenAI();
            if (!whisperClient) throw new Error('AI client not available');
            let whisperTimeout2;
            try {
              const whisperController = new AbortController();
              whisperTimeout2 = setTimeout(() => whisperController.abort(), 30000);
              const transcription = await whisperClient.audio.transcriptions.create({
                model: 'whisper-1',
                file: audioFile,
              }, { signal: whisperController.signal });
              const transcript = transcription.text?.trim() || '';
              if (transcript) {
                attachmentContext = `\nForwarded audio: ${name}`;
                if (forwardedAttachment.caption) attachmentContext += `\nCaption: ${forwardedAttachment.caption}`;
                attachmentContext += `\nTranscript: ${transcript}`;
              } else {
                attachmentContext = `\nForwarded audio: ${name}`;
                attachmentContext += `\nVoice not clear. Send again or type message.`;
              }
            } finally {
              clearTimeout(whisperTimeout2);
            }
          } catch (whisperErr) {
            console.error('Whisper transcription failed');
            attachmentContext = `\nForwarded audio: ${name}`;
            attachmentContext += `\nVoice not clear. Send again or type message.`;
          } finally {
            clearTimeout(fetchTimeout2);
          }
        } else {
          attachmentContext = `\nForwarded audio: ${name}`;
          attachmentContext += `\nVoice not clear. Send again or type message.`;
        }
      } else {
        attachmentContext = `\nForwarded ${forwardedAttachment.type}: ${forwardedAttachment.name || forwardedAttachment.type}`;
        attachmentContext += `\nMIME type: ${forwardedAttachment.mime_type || 'unknown'}`;
        if (forwardedAttachment.caption) attachmentContext += `\nCaption: ${forwardedAttachment.caption}`;
      }
    }
    const userMessage = `Entity: ${customer.name}\nOwner instruction: ${query}${attachmentContext}\nRecent context: ${recentText}\nCustomer memory: ${customerMemory || 'none'}`;
    const primaryLanguage = auth.primaryLanguage || 'en';
    const systemContent = SPARK_SYSTEM_PROMPT
      + (globalContext ? `\n\nBusiness context:\n${globalContext}` : '')
      + `\n\nLanguage instructions: The owner may communicate in any language. Understand multilingual and mixed-language business input correctly. Always return all JSON fields and product names in English. If clarification is absolutely required, respond using language code: ${primaryLanguage}.`;

    const client = getOpenAI();
    if (!client) return c.json({ error: 'ai_error', message: 'AI not configured' }, 500);

    let tokensInput = 0, tokensOutput = 0;
    let parsed = { intent: 'ambiguous', confidence_score: 0.0, entities: {}, reasoning: '' };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
      }, { signal: controller.signal });
      clearTimeout(timeoutId);
      tokensInput = completion.usage?.prompt_tokens || 0;
      tokensOutput = completion.usage?.completion_tokens || 0;
      parsed = parseSparkResponse(completion.choices[0].message.content || '');
    } catch (aiErr) {
      clearTimeout(timeoutId);
      console.error('Spark OpenAI call failed:', aiErr.message);
      // Log failure
      try {
        await supabase.from('ai_usage_log').insert({
          organisation_id: organisationId, user_id: userId, conversation_id: conversationId,
          model: 'gpt-4o-mini', operation: 'spark', tokens_input: 0, tokens_output: 0,
          cost_usd: 0, duration_ms: Date.now() - startTime, status: 'failed', error_message: aiErr.message,
        });
      } catch {}
      return c.json({ error: 'ai_error', message: 'AI temporarily unavailable' }, 500);
    }

    // Write ai_usage_log (success)
    const durationMs = Date.now() - startTime;
    const costUsd = (tokensInput * 0.00015 / 1000) + (tokensOutput * 0.00060 / 1000);
    try {
      await supabase.from('ai_usage_log').insert({
        organisation_id: organisationId, user_id: userId, conversation_id: conversationId,
        model: 'gpt-4o-mini', operation: 'spark', tokens_input: tokensInput, tokens_output: tokensOutput,
        cost_usd: costUsd, duration_ms: durationMs, status: 'success',
      });
    } catch {}

    // resolveProduct() is module-level — see Product Intelligence Engine section above

    // Routing: if we have ANY valid actions → always preview. Only clarify when zero actions.
    const hasActions = parsed.actions.length > 0;
    let routing = hasActions ? 'preview' : 'clarify';

    // If no actions extracted, return clarification (no DB insert)
    if (routing === 'clarify') {
      return c.json({
        routing: 'clarify',
        message: parsed.reasoning || "I'm not sure what you'd like me to do. Could you be more specific?",
        confidence_score: parsed.confidence_score,
        actions: [],
      });
    }

    // Build and save each action as a separate ai_actions record
    const responseActions = [];
    let draftId = null;

    for (const action of parsed.actions) {
      const ent = action.entities || {};

      if (action.action_type === 'create_invoice' || action.action_type === 'create_quote') {
        // Handle items[] array for invoice
        const items = Array.isArray(ent.items) ? ent.items : (ent.product_name ? [{ product_name: ent.product_name, quantity: ent.quantity }] : []);
        const resolvedItems = [];
        let totalAmount = 0;

        for (const item of items) {
          const { resolved, alternatives } = await resolveProduct({ productName: item.product_name, customerId, organisationId });
          const unitPrice = resolved?.selling_price || item.unit_price || null;
          const qty = item.quantity || 1;
          const lineTotal = unitPrice ? unitPrice * qty : null;
          if (lineTotal) totalAmount += lineTotal;

          resolvedItems.push({
            raw_product_name: item.product_name,
            product_name: resolved?.name || item.product_name,
            product_id: resolved?.id || null,
            quantity: qty,
            unit_price: unitPrice,
            tax_rate: resolved?.tax_rate || 0,
            line_total: lineTotal,
            alternatives: alternatives.map(a => ({ id: a.id, name: a.name, selling_price: a.selling_price, tax_rate: a.tax_rate ?? 0 })),
          });
        }

        const actionParams = {
          customer_id: customerId,
          customer_name: customer.name,
          items: resolvedItems,
          amount: ent.amount || totalAmount || null,
          due_date: ent.due_date || null,
          delivery_date: ent.delivery_date || null,
          freight: (ent.freight || 0) + (ent.packing || 0),
          freight_taxable: ent.freight_taxable || false,
          freight_tax_rate: ent.freight_tax_rate || 18,
        };

        const { data: savedAction, error: actionErr } = await supabase
          .from('ai_actions').insert({
            organisation_id: organisationId,
            action_name: `${action.action_type === 'create_quote' ? 'create quote' : 'create invoice'} for ${customer.name}`,
            action_type: action.action_type,
            prompt_template: query,
            parameters: actionParams,
            confidence_score: parsed.confidence_score,
            status: 'pending',
          }).select('id').single();

        if (actionErr) { console.error('Save ai_action failed:', actionErr); continue; }
        if (!draftId) draftId = savedAction.id;

        // Build details for each item
        const itemLines = resolvedItems.map(it =>
          `${it.quantity} × ${it.product_name}${it.unit_price ? ` @ ₹${it.unit_price.toLocaleString('en-IN')}` : ''}`
        );
        const totalStr = (ent.amount || totalAmount) ? `₹${(ent.amount || totalAmount).toLocaleString('en-IN')}` : null;

        responseActions.push({
          action_id: savedAction.id,
          action_type: action.action_type,
          details: itemLines.join('\n') + (totalStr ? `\nTotal: ${totalStr}` : '') + (ent.due_date ? `\nDue: ${ent.due_date}` : ''),
          parameters: actionParams,
          items: resolvedItems,
          editable: true,
        });

      } else if (action.action_type === 'create_purchase_bill') {
        // CENTRALIZED: prepareTransactionDocument() — equivalence proven May 2026
        // Invoice and quote paths remain on inline branch above (untouched).
        const { prepareTransactionDocument } = await import('./services/business/prepareTransactionDocument.js');
        const rawItems = Array.isArray(ent.items) ? ent.items : (ent.product_name ? [{ product_name: ent.product_name, quantity: ent.quantity, unit_price: ent.unit_price }] : []);
        const prepared = await prepareTransactionDocument({
          supabase, organisationId, customerId, customerName: customer.name,
          actionType: 'create_purchase_bill', rawItems, entities: ent,
        });
        const { data: savedAction, error: actionErr } = await supabase
          .from('ai_actions').insert({
            organisation_id: organisationId,
            action_name: prepared.actionName,
            action_type: 'create_purchase_bill',
            prompt_template: query,
            parameters: prepared.actionParams,
            confidence_score: parsed.confidence_score,
            status: 'pending',
          }).select('id').single();
        if (actionErr) { console.error('Save ai_action (purchase_bill) failed:', actionErr); continue; }
        if (!draftId) draftId = savedAction.id;
        responseActions.push({
          action_id: savedAction.id,
          action_type: 'create_purchase_bill',
          details: prepared.details,
          parameters: prepared.actionParams,
          items: prepared.resolvedItems,
          editable: true,
        });

      } else {
        // Non-invoice actions (delivery, reminder, payment)
        const actionParams = {
          customer_id: customerId,
          customer_name: customer.name,
          amount: ent.amount || null,
          due_date: ent.due_date || null,
          delivery_date: ent.delivery_date || null,
          description: action.action_type === 'schedule_delivery'
            ? `Delivery for ${customer.name}`
            : action.action_type === 'set_reminder'
            ? `Payment reminder for ${customer.name}`
            : `Payment from ${customer.name}`,
        };

        const { data: savedAction, error: actionErr } = await supabase
          .from('ai_actions').insert({
            organisation_id: organisationId,
            action_name: `${action.action_type.replace(/_/g, ' ')} for ${customer.name}`,
            action_type: action.action_type,
            prompt_template: query,
            parameters: actionParams,
            confidence_score: parsed.confidence_score,
            status: 'pending',
          }).select('id').single();

        if (actionErr) { console.error('Save ai_action failed:', actionErr); continue; }
        if (!draftId) draftId = savedAction.id;

        let details = '';
        if (action.action_type === 'schedule_delivery') {
          details = `Schedule: ${ent.delivery_date || 'TBD'}`;
        } else if (action.action_type === 'set_reminder') {
          details = `Send on: ${ent.due_date || 'TBD'}`;
        } else if (action.action_type === 'record_payment') {
          details = ent.amount ? `₹${ent.amount.toLocaleString('en-IN')}` : 'Amount TBD';
        }

        responseActions.push({
          action_id: savedAction.id,
          action_type: action.action_type,
          details: details || `${action.action_type.replace(/_/g, ' ')} for ${customer.name}`,
          parameters: actionParams,
          editable: true,
        });
      }
    }

    if (responseActions.length === 0) {
      return c.json({ routing: 'clarify', message: 'Could not create actions. Try again.', confidence_score: 0, actions: [] });
    }

    // Post-processing: if create_invoice has delivery_date or due_date, ensure separate delivery/reminder actions exist
    const hasDelivery = responseActions.some(a => a.action_type === 'schedule_delivery');
    const hasReminder = responseActions.some(a => a.action_type === 'set_reminder');
    const invoiceAction = responseActions.find(a => a.action_type === 'create_invoice');

    if (invoiceAction && !hasDelivery && invoiceAction.parameters?.delivery_date) {
      const delParams = { customer_id: customerId, customer_name: customer.name, delivery_date: invoiceAction.parameters.delivery_date, description: `Delivery for ${customer.name}` };
      const { data: delAction } = await supabase.from('ai_actions').insert({
        organisation_id: organisationId, action_name: `schedule delivery for ${customer.name}`,
        action_type: 'schedule_delivery', prompt_template: query, parameters: delParams,
        confidence_score: parsed.confidence_score, status: 'pending',
      }).select('id').single();
      if (delAction) {
        responseActions.push({ action_id: delAction.id, action_type: 'schedule_delivery', details: `Schedule: ${invoiceAction.parameters.delivery_date}`, parameters: delParams, editable: true });
      }
    }

    if (invoiceAction && !hasReminder && invoiceAction.parameters?.due_date) {
      const remParams = { customer_id: customerId, customer_name: customer.name, due_date: invoiceAction.parameters.due_date, description: `Payment reminder for ${customer.name}` };
      const { data: remAction } = await supabase.from('ai_actions').insert({
        organisation_id: organisationId, action_name: `set reminder for ${customer.name}`,
        action_type: 'set_reminder', prompt_template: query, parameters: remParams,
        confidence_score: parsed.confidence_score, status: 'pending',
      }).select('id').single();
      if (remAction) {
        responseActions.push({ action_id: remAction.id, action_type: 'set_reminder', details: `Send on: ${invoiceAction.parameters.due_date}`, parameters: remParams, editable: true });
      }
    }

    // Get entity_memory insight for preview — format in natural language
    let aiInsight = null;
    try {
      const { data: insights } = await supabase
        .from('entity_memory').select('memory_key, memory_value')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer')
        .eq('entity_id', customerId).is('deleted_at', null).limit(5);
      if (insights?.length > 0) {
        const parts = [];
        for (const i of insights) {
          const key = i.memory_key;
          const val = i.memory_value;
          if (key === 'task_completed_on_time' && val === 'true') parts.push(`${customer.name} usually completes tasks on time`);
          else if (key === 'task_completed_on_time' && val === 'false') parts.push(`${customer.name} sometimes delays tasks`);
          else if (key === 'last_delivery_alert_date') parts.push(`Last delivery alert was on ${new Date(val).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
          else if (key === 'last_reminder_alert_date') parts.push(`Last payment reminder sent ${new Date(val).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
          else if (key === 'payment_behavior') parts.push(`Payment behavior: ${val}`);
          else if (key === 'avg_payment_days') parts.push(`${customer.name} usually pays within ${val} days`);
          else if (key.includes('preferred')) parts.push(`Preferred: ${val}`);
          else parts.push(`${key.replace(/_/g, ' ')}: ${val}`);
        }
        if (parts.length > 0) aiInsight = parts.join('. ') + '.';
      }
    } catch {}

    return c.json({
      draft_id: draftId,
      confidence_score: parsed.confidence_score,
      routing: 'preview',
      actions: responseActions,
      ai_insight: aiInsight,
    });

  } catch (error) {
    console.error('POST /api/chat/spark error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/chat/:customer_id/spark/confirm ─────────────
app.post('/api/chat/:customer_id/spark/confirm', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const { draft_id, action_ids } = body;
    if (!draft_id || !action_ids?.length) return c.json({ error: 'missing_fields' }, 400);

    const executed = [];
    const failed = [];

    for (const actionId of action_ids) {
      // Fetch action
      const { data: action } = await supabase
        .from('ai_actions').select('*')
        .eq('id', actionId).eq('organisation_id', organisationId).maybeSingle();

      if (!action || (action.status !== 'pending' && action.status !== 'approved')) {
        failed.push(actionId);
        continue;
      }

      const params = action.parameters || {};

      try {
        switch (action.action_type) {
          case 'create_invoice': {
            // Get next invoice number
            const { count: invCount } = await supabase
              .from('invoices').select('*', { count: 'exact', head: true })
              .eq('organisation_id', organisationId);
            const invoiceNumber = 'INV-' + ((invCount || 0) + 1).toString().padStart(3, '0');

            const itemsArr = Array.isArray(params.items) ? params.items : [];

            // Build items array for calculateInvoiceTotals
            const itemsForCalc = itemsArr.length > 0
              ? itemsArr.map(i => ({
                  product_id: i.product_id || null,
                  product_name: i.product_name || 'Item',
                  quantity: i.quantity || 1,
                  unit_price: i.unit_price != null ? i.unit_price : null,
                  tax_rate: i.tax_rate != null ? i.tax_rate : null,
                  discount_pct: i.discount_pct || 0,
                }))
              : params.product_name
                ? [{ product_id: null, product_name: params.product_name, quantity: params.quantity || 1, unit_price: params.unit_price || null, tax_rate: null, discount_pct: 0 }]
                : [];

            // Single source of truth for all financial math
            const totals = await calculateInvoiceTotals(
              supabase,
              organisationId,
              customerId,
              itemsForCalc,
              {
                freight: params.freight || 0,
                freight_taxable: params.freight_taxable || false,
                freight_tax_rate: params.freight_tax_rate || 18,
                apply_gst: params.apply_gst !== false,
                overall_discount: params.overall_discount || 0,
                invoice_type: params.invoice_type || 'Tax Invoice',
              }
            );

            const { data: newInvoice, error: invErr } = await supabase
              .from('invoices').insert({
                organisation_id: organisationId,
                customer_id: customerId,
                invoice_number: invoiceNumber,
                status: 'sent',
                issue_date: new Date().toISOString().split('T')[0],
                due_date: params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                currency: 'INR',
                subtotal: totals.subtotal,
                tax_amount: totals.total_tax,
                total_amount: totals.grand_total,
                discount_amount: totals.total_discount,
                amount_due: totals.grand_total,
                amount_paid: 0,
                custom_fields: {
                  invoice_type: totals.invoice_type,
                  cgst_amount: totals.cgst,
                  sgst_amount: totals.sgst,
                  igst_amount: totals.igst,
                  freight_amount: totals.freight_amount,
                  freight_tax: totals.freight_tax,
                  round_off: totals.round_off,
                  is_interstate: totals.is_interstate,
                },
              }).select('id').single();
            if (invErr) { console.error('Create invoice failed:', invErr); failed.push(actionId); continue; }

            // Insert invoice items using calculated line items
            for (let idx = 0; idx < totals.line_items.length; idx++) {
              const li = totals.line_items[idx];
              await supabase.from('invoice_items').insert({
                organisation_id: organisationId,
                invoice_id: newInvoice.id,
                product_id: li.product_id || null,
                description: li.product_name || 'Item',
                quantity: li.quantity,
                unit_price: li.unit_price,
                discount_pct: li.discount_pct,
                tax_rate: li.tax_rate,
                line_total: li.line_total,
                sort_order: idx + 1,
              });
            }
            // Alias learning — silent, behavioral, backend-owned
            // Uses raw_product_name (original OCR/input) vs product_name (resolved catalog name)
            // No extra DB fetch needed — raw signal preserved from Spark pipeline
            for (const item of itemsArr) {
              try {
                if (!item.product_id || !item.raw_product_name || !item.product_name) continue;
                const rawNormalised = normaliseVocabulary(item.raw_product_name);
                const catalogNormalised = normaliseVocabulary(item.product_name);
                if (rawNormalised === catalogNormalised) continue; // identical — no alias needed
                // Upsert into product_vocabularies
                const { data: existing } = await supabase
                  .from('product_vocabularies')
                  .select('id, usage_count, confirmed_count')
                  .eq('organisation_id', organisationId)
                  .eq('product_id', item.product_id)
                  .eq('normalised', rawNormalised)
                  .maybeSingle();
                if (existing) {
                  await supabase.from('product_vocabularies').update({
                    usage_count: existing.usage_count + 1,
                    confirmed_count: existing.confirmed_count + 1,
                    last_confirmed_at: new Date().toISOString(),
                  }).eq('id', existing.id);
                } else {
                  await supabase.from('product_vocabularies').insert({
                    organisation_id: organisationId,
                    product_id: item.product_id,
                    vocabulary: item.raw_product_name.trim(),
                    normalised: rawNormalised,
                    source_type: 'owner_correction',
                    match_strength: 0.5,
                    usage_count: 1,
                    confirmed_count: 1,
                    first_seen_at: new Date().toISOString(),
                    last_confirmed_at: new Date().toISOString(),
                  });
                }
              } catch (aliasErr) {
                console.warn('[VOCAB] vocabulary write failed silently:', aliasErr.message);
              }
            }

            // Build items summary for card
            const itemsSummary = itemsArr.length > 0
              ? itemsArr.map(i => `${i.product_name} × ${i.quantity || 1}`).join(', ')
              : params.product_name ? `${params.product_name} × ${params.quantity || 1}` : 'Items';

            // Insert invoice card message in chat (visible to customer)
            const { data: conv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();


            // Generate PDF at confirm time
            let invoicePdfUrl = null;
            try {
              invoicePdfUrl = await generateDocumentPDF({
                documentId: newInvoice.id,
                organisationId,
                documentType: 'invoice',
                documentNumber: invoiceNumber,
                title: totals.invoice_type === 'Bill of Supply' ? 'BILL OF SUPPLY' : 'TAX INVOICE',
                storageBucket: 'invoices',
                entityType: 'invoice',
              });
            } catch (pdfErr) {
              console.warn('[PDF] Invoice PDF generation failed:', pdfErr.message);
            }

            if (conv) {
              const { data: cardMsg } = await supabase.from('messages').insert({
                organisation_id: organisationId,
                conversation_id: conv.id,
                role: 'tool',
                content: `Invoice #${invoiceNumber} created`,
                metadata: {
                  sender_type: 'system',
                  visibility: 'both',
                  message_type: 'invoice_card',
                  read_by_owner: true,
                  preview_text: `Invoice #${invoiceNumber} created`,
                  card_type: 'invoice_card',
                  card_data: {
                    invoice_id: newInvoice.id,
                    invoice_number: invoiceNumber,
                    total_amount: totals.grand_total,
                    due_date: params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                    status: 'sent',
                    items_summary: itemsSummary,
                    pdf_url: invoicePdfUrl,
                  },
                },
                tokens_input: 0, tokens_output: 0,
              }).select('id, metadata, content').single();

              await mirrorCardToReceiverOrg({
                supabase,
                senderOrgId: organisationId,
                senderUserId: userId,
                customerPhone: customer?.phone,
                originalMetadata: cardMsg?.metadata || {},
                originalContent: cardMsg?.content || '',
              });
            }

            // Update customer outstanding balance
            await supabase.from('customers')
              .update({ outstanding_balance: (customer.outstanding_balance || 0) + totals.grand_total })
              .eq('id', customerId).eq('organisation_id', organisationId);

            executed.push(actionId);
            break;
          }

          case 'schedule_delivery': {
            await supabase.from('tasks').insert({
              organisation_id: organisationId,
              title: `Delivery for ${customer.name}`,
              description: params.description || (params.product_name ? `Deliver ${params.quantity || ''} ${params.product_name}` : 'Scheduled delivery'),
              status: 'pending',
              priority: 'medium',
              created_by: userId,
              due_date: params.delivery_date || params.due_date || new Date(Date.now() + 86400000).toISOString().split('T')[0],
              entity_type: 'delivery',
              entity_id: customerId,
            });
            // Confirmation as owner-only system message
            const { data: delConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (delConv) {
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: delConv.id,
                role: 'system', content: `✓ Delivery scheduled for ${customer.name} on ${params.delivery_date || 'TBD'}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Delivery scheduled for ${customer.name}` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            executed.push(actionId);
            break;
          }

          case 'set_reminder': {
            // Create a task in tasks table (so it shows in My Tasks)
            const reminderDate = params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
            await supabase.from('tasks').insert({
              organisation_id: organisationId,
              title: `Payment reminder for ${customer.name}`,
              description: params.description || `Send payment reminder to ${customer.name}`,
              status: 'pending',
              priority: 'medium',
              created_by: userId,
              due_date: reminderDate,
              entity_type: 'reminder',
              entity_id: customerId,
            });
            // Confirmation as owner-only system message (pink strip)
            const { data: remConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (remConv) {
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: remConv.id,
                role: 'system', content: `✓ Payment reminder set for ${customer.name} on ${reminderDate}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Reminder set for ${customer.name}` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            executed.push(actionId);
            break;
          }

          case 'record_payment': {
            let payResult = { status: 'failed', events: [], error: 'invalid_amount' };
            if (params.amount && params.amount > 0) {
              const istNow = () => {
                const now = new Date();
                return new Date(now.getTime() + (5.5 * 60 * 60 * 1000)).toISOString().split('T')[0];
              };
              const paymentDate = params.payment_date || istNow();
              const paymentMethod = params.payment_mode || null;

              payResult = await recordPayment(
                supabase, organisationId, customerId,
                params.amount, paymentDate, paymentMethod, null
              );

              const payEvents = payResult.events || [];
              const recorded = payEvents.filter(e => e.type === 'payment_recorded');
              const remindersResolved = payEvents.find(e => e.type === 'reminders_resolved');
              const unlinkedReminders = payEvents.find(e => e.type === 'unlinked_reminders_pending');
              const reminderSuggestion = payEvents.find(e => e.type === 'reminder_suggestion');

              let ackText = '';
              if (payResult.status === 'success' && recorded.length > 0) {
                const ackLines = recorded.map(e => {
                  const base = `✓ ₹${e.amount_applied.toLocaleString('en-IN')} recorded against ${e.invoice_number} on ${e.payment_date}`;
                  return e.remaining_due > 0.01
                    ? `${base} — ₹${e.remaining_due.toLocaleString('en-IN')} still pending`
                    : `${base} — fully paid`;
                });
                if (remindersResolved) ackLines.push(`✓ ${remindersResolved.count} payment reminder(s) marked complete`);
                if (unlinkedReminders) ackLines.push(`⚠️ ${unlinkedReminders.message}`);
                if (reminderSuggestion) {
                  ackLines.push(`₹${reminderSuggestion.remaining_due.toLocaleString('en-IN')} still pending. Set a reminder for ${reminderSuggestion.suggested_date} (${reminderSuggestion.suggested_days} days, based on ${customer.name}’s payment pattern)?`);
                }
                ackText = ackLines.join('\n');
              } else if (payResult.status === 'partial_success') {
                ackText = `⚠️ Payment partially recorded. Some invoices updated but reconciliation needs review. Reference: ${payResult.operation_id}`;
                console.warn('[Spark record_payment] partial_success op:', payResult.operation_id, 'error:', payResult.error);
              } else {
                ackText = `⚠️ Payment could not be recorded. ${payResult.error === 'no_unpaid_invoices' ? 'No unpaid invoices found for ' + customer.name + '.' : 'Please try again or record manually.'}`;
                console.warn('[Spark record_payment] failed op:', payResult.operation_id, 'error:', payResult.error);
              }

              if (ackText) {
                const { data: ackConv } = await supabase
                  .from('conversations').select('id')
                  .eq('organisation_id', organisationId).eq('entity_type', 'customer')
                  .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
                if (ackConv) {
                  await supabase.from('messages').insert({
                    organisation_id: organisationId, conversation_id: ackConv.id,
                    role: 'system', content: ackText,
                    metadata: {
                      sender_type: 'system', visibility: 'owner_only',
                      message_type: 'system_alert', read_by_owner: true,
                      preview_text: `Payment recorded for ${customer.name}`,
                      operation_id: payResult.operation_id,
                    },
                    tokens_input: 0, tokens_output: 0,
                  });
                }
              }

              if (payResult.status === 'success' && params.bank_account_name && recorded.length > 0) {
                try {
                  const { data: bankAcc } = await supabase
                    .from('bank_accounts').select('id')
                    .eq('organisation_id', organisationId)
                    .ilike('name', `%${params.bank_account_name}%`)
                    .eq('is_active', true).limit(1).maybeSingle();
                  if (bankAcc) {
                    await supabase.from('bank_transactions').insert({
                      organisation_id: organisationId,
                      bank_account_id: bankAcc.id,
                      type: 'credit',
                      amount: params.amount,
                      currency: 'INR',
                      description: `Payment from ${customer.name}`,
                      transaction_date: paymentDate,
                      reference: recorded.length === 1
                        ? recorded[0].invoice_number
                        : `MULTI-${payResult.operation_id.slice(0, 8)}`,
                      reference_type: recorded.length === 1 ? 'invoice' : 'multi_invoice_payment',
                      reference_id: recorded.length === 1 ? recorded[0].invoice_id : null,
                    });
                  }
                } catch (btErr) {
                  console.warn('bank_transactions write failed:', btErr.message);
                }
              }
            }
            if (payResult.status === 'success' || payResult.status === 'partial_success') {
              executed.push(actionId);
            } else {
              failed.push(actionId);
            }
            break;
          }

          case 'create_quote': {
            // Same financial math as create_invoice, writes to quotations + quotation_items
            const { count: qtCount } = await supabase
              .from('quotations').select('*', { count: 'exact', head: true })
              .eq('organisation_id', organisationId);
            const quoteNumber = `Q-${((qtCount || 0) + 1).toString().padStart(3, '0')}`;

            const itemsArr = Array.isArray(params.items) ? params.items : [];
            const itemsForCalc = itemsArr.length > 0
              ? itemsArr.map(i => ({
                  product_id: i.product_id || null,
                  product_name: i.product_name || 'Item',
                  quantity: i.quantity || 1,
                  unit_price: i.unit_price != null ? i.unit_price : null,
                  tax_rate: i.tax_rate != null ? i.tax_rate : null,
                  discount_pct: i.discount_pct || 0,
                }))
              : [];

            const totals = await calculateInvoiceTotals(
              supabase, organisationId, customerId, itemsForCalc,
              {
                freight: params.freight || 0,
                freight_taxable: params.freight_taxable || false,
                freight_tax_rate: params.freight_tax_rate || 18,
                apply_gst: params.apply_gst !== false,
                overall_discount: params.overall_discount || 0,
                invoice_type: params.invoice_type || 'Tax Invoice',
              }
            );

            const { data: newQuote, error: qtErr } = await supabase
              .from('quotations').insert({
                organisation_id: organisationId,
                customer_id: customerId,
                quote_number: quoteNumber,
                status: 'sent',
                issue_date: new Date().toISOString().split('T')[0],
                expiry_date: params.due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
                currency: 'INR',
                subtotal: totals.subtotal,
                discount_amount: totals.total_discount,
                tax_amount: totals.total_tax,
                total_amount: totals.grand_total,
              }).select('id').single();

            if (qtErr) { console.error('Create quote failed:', qtErr); failed.push(actionId); continue; }

            for (let idx = 0; idx < totals.line_items.length; idx++) {
              const li = totals.line_items[idx];
              await supabase.from('quotation_items').insert({
                organisation_id: organisationId,
                quotation_id: newQuote.id,
                product_id: li.product_id || null,
                description: li.product_name || 'Item',
                quantity: li.quantity,
                unit_price: li.unit_price,
                discount_pct: li.discount_pct,
                tax_rate: li.tax_rate,
                line_total: li.line_total,
                sort_order: idx + 1,
              });
            }

            // Confirmation message
            const { data: qtConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            // Generate PDF at confirm time
            let quotePdfUrl = null;
            try {
              quotePdfUrl = await generateDocumentPDF({
                documentId: newQuote.id,
                organisationId,
                documentType: 'quotation',
                documentNumber: quoteNumber,
                title: 'QUOTATION',
                storageBucket: 'quotes',
                entityType: 'quotation',
              });
            } catch (pdfErr) {
              console.warn('[PDF] Quote PDF generation failed:', pdfErr.message);
            }
            if (qtConv) {
              const { data: cardMsg } = await supabase.from('messages').insert({
                organisation_id: organisationId,
                conversation_id: qtConv.id,
                role: 'tool',
                content: `Quote ${quoteNumber} created`,
                metadata: {
                  sender_type: 'system',
                  visibility: 'both',
                  message_type: 'invoice_card',
                  read_by_owner: true,
                  preview_text: `Quote ${quoteNumber} created`,
                  card_type: 'invoice_card',
                  card_data: {
                    invoice_id: newQuote.id,
                    invoice_number: quoteNumber,
                    total_amount: totals.grand_total,
                    due_date: params.due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
                    status: 'sent',
                    items_summary: itemsArr.map(i => `${i.product_name} × ${i.quantity || 1}`).join(', '),
                    pdf_url: quotePdfUrl,
                    is_quote: true,
                  },
                },
                tokens_input: 0, tokens_output: 0,
              }).select('id, metadata, content').single();

              await mirrorCardToReceiverOrg({
                supabase,
                senderOrgId: organisationId,
                senderUserId: userId,
                customerPhone: customer?.phone,
                originalMetadata: cardMsg?.metadata || {},
                originalContent: cardMsg?.content || '',
              });
            }
            executed.push(actionId);
            break;
          }

          case 'convert_quote_to_invoice': {
            // Find the quote by quote_number if provided, else latest sent quote for this customer
            let quoteId = params.quote_id || null;
            if (!quoteId && params.quote_number) {
              const { data: qt } = await supabase
                .from('quotations').select('id')
                .eq('organisation_id', organisationId).eq('quote_number', params.quote_number).maybeSingle();
              if (qt) quoteId = qt.id;
            }
            if (!quoteId) {
              const { data: qt } = await supabase
                .from('quotations').select('id')
                .eq('organisation_id', organisationId).eq('customer_id', customerId)
                .eq('status', 'sent').order('created_at', { ascending: false }).limit(1).maybeSingle();
              if (qt) quoteId = qt.id;
            }
            if (!quoteId) { failed.push(actionId); break; }

            // Fetch quote and its items
            const { data: quote } = await supabase
              .from('quotations').select('*').eq('id', quoteId).maybeSingle();
            const { data: quoteItems } = await supabase
              .from('quotation_items').select('*').eq('quotation_id', quoteId).is('deleted_at', null);

            if (!quote) { failed.push(actionId); break; }

            const { count: invCount } = await supabase
              .from('invoices').select('*', { count: 'exact', head: true })
              .eq('organisation_id', organisationId);
            const invoiceNumber = 'INV-' + ((invCount || 0) + 1).toString().padStart(3, '0');

            const { data: newInv, error: convErr } = await supabase
              .from('invoices').insert({
                organisation_id: organisationId,
                customer_id: customerId,
                quotation_id: quoteId,
                invoice_number: invoiceNumber,
                status: 'sent',
                issue_date: new Date().toISOString().split('T')[0],
                due_date: params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                currency: 'INR',
                subtotal: quote.subtotal,
                discount_amount: quote.discount_amount,
                tax_amount: quote.tax_amount,
                total_amount: quote.total_amount,
                amount_paid: 0,
                amount_due: quote.total_amount,
              }).select('id').single();

            if (convErr) { console.error('Convert quote failed:', convErr); failed.push(actionId); continue; }

            // Copy quote items to invoice items
            for (let idx = 0; idx < (quoteItems || []).length; idx++) {
              const qi = quoteItems[idx];
              await supabase.from('invoice_items').insert({
                organisation_id: organisationId,
                invoice_id: newInv.id,
                product_id: qi.product_id || null,
                description: qi.description,
                quantity: qi.quantity,
                unit_price: qi.unit_price,
                discount_pct: qi.discount_pct,
                tax_rate: qi.tax_rate,
                line_total: qi.line_total,
                sort_order: qi.sort_order,
              });
            }

            // Mark quote as converted
            await supabase.from('quotations').update({ status: 'converted' }).eq('id', quoteId);

            // Invoice card message
            const { data: convConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (convConv) {
              const { data: cardMsg } = await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: convConv.id,
                role: 'tool', content: `Invoice #${invoiceNumber} created`,
                metadata: {
                  sender_type: 'system', visibility: 'both', message_type: 'invoice_card',
                  read_by_owner: true, preview_text: `Invoice #${invoiceNumber} created`,
                  card_type: 'invoice_card',
                  card_data: {
                    invoice_id: newInv.id, invoice_number: invoiceNumber,
                    total_amount: quote.total_amount,
                    due_date: params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                    status: 'sent', items_summary: `Converted from ${quote.quote_number}`,
                  },
                },
                tokens_input: 0, tokens_output: 0,
              }).select('id, metadata, content').single();

              await mirrorCardToReceiverOrg({
                supabase,
                senderOrgId: organisationId,
                senderUserId: userId,
                customerPhone: customer?.phone,
                originalMetadata: cardMsg?.metadata || {},
                originalContent: cardMsg?.content || '',
              });
            }
            executed.push(actionId);
            break;
          }

          case 'update_delivery_status': {
            // Update task status for this customer's delivery task
            await supabase.from('tasks')
              .update({ status: 'completed' })
              .eq('organisation_id', organisationId)
              .eq('entity_id', customerId)
              .eq('entity_type', 'delivery')
              .eq('status', 'pending');

            const { data: delConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (delConv) {
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: delConv.id,
                role: 'system', content: `✓ Delivery marked as completed for ${customer.name}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Delivery completed for ${customer.name}` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            executed.push(actionId);
            break;
          }

          case 'goods_returned': {
            // Record return — create a negative invoice or credit note as system alert
            const returnAmount = params.amount || 0;
            if (returnAmount > 0) {
              // Reduce outstanding balance
              const newBalance = Math.max(0, (customer.outstanding_balance || 0) - returnAmount);
              await supabase.from('customers').update({ outstanding_balance: newBalance })
                .eq('id', customerId).eq('organisation_id', organisationId);
            }
            // System message
            const { data: retConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (retConv) {
              const itemDesc = Array.isArray(params.items) && params.items.length > 0
                ? params.items.map(i => `${i.quantity || 1} × ${i.product_name}`).join(', ')
                : 'goods';
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: retConv.id,
                role: 'system', content: `✓ Goods returned by ${customer.name}: ${itemDesc}${params.reason ? ` — ${params.reason}` : ''}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Goods returned by ${customer.name}` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            executed.push(actionId);
            break;
          }

          case 'record_expense': {
            await supabase.from('expenses').insert({
              organisation_id: organisationId,
              category: params.category || 'general',
              description: params.description || `Expense for ${customer.name}`,
              amount: params.amount || 0,
              currency: 'INR',
              expense_date: new Date().toISOString().split('T')[0],
              payment_method: params.payment_mode || null,
              status: 'pending',
            });
            const { data: expConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (expConv) {
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: expConv.id,
                role: 'system', content: `✓ Expense recorded: ₹${(params.amount || 0).toLocaleString('en-IN')} — ${params.description || params.category || 'general'}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Expense recorded for ${customer.name}` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            executed.push(actionId);
            break;
          }


          case 'create_purchase_bill': {
            // CENTRALIZED PRIMITIVE — calls recordPurchaseBill() via API route
            // Never inline. Follows BUILD-BESIDE-THEN-MIGRATE doctrine.
            // params.items: [{ product_id, description, quantity, unit_price, tax_rate }]
            // params.due_date, params.bill_number, params.notes are optional
            const { recordPurchaseBill } = await import('./services/business/recordPurchaseBill.js');
            const pbResult = await recordPurchaseBill(supabase, organisationId, customerId, params.items || [], {
              dueDate: params.due_date || null,
              billNumber: params.bill_number || null,
              supplierBillNumber: params.supplier_bill_number || null,
              notes: params.notes || null,
            });
            if (pbResult.status === 'failed') {
              failed.push(actionId);
              break;
            }
            const { data: pbConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (pbConv) {
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: pbConv.id,
                role: 'system',
                content: `✓ Purchase bill ${pbResult.bill_number} recorded — ${pbResult.entity_name} · ₹${(pbResult.total_amount || 0).toLocaleString('en-IN')} due ${pbResult.due_date || ''}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Purchase bill ${pbResult.bill_number} recorded` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            // Alias learning — same pattern as create_invoice confirm
            // Learns vocabulary from owner corrections in the preview sheet
            // Non-blocking: failure never surfaces to owner
            try {
              const { learnVocabularyAliases } = await import('./services/business/prepareTransactionDocument.js');
              const itemsArr = Array.isArray(params.items) ? params.items : [];
              await learnVocabularyAliases({ supabase, organisationId, items: itemsArr });
            } catch (aliasErr) {
              console.warn('[VOCAB] purchase_bill alias learning failed silently:', aliasErr.message);
            }
            executed.push(actionId);
            break;
          }

          case 'record_supplier_payment': {
            // CENTRALIZED PRIMITIVE — calls recordSupplierPayment() via service
            // Never inline. Mirrors record_payment case pattern exactly.
            // params.amount: number (required)
            // params.payment_mode, params.bill_id, params.bank_account_name are optional
            if (!params.amount || params.amount <= 0) { failed.push(actionId); break; }
            const { recordSupplierPayment } = await import('./services/business/recordSupplierPayment.js');
            let bankAccountId = null;
            if (params.bank_account_name) {
              try {
                const { data: bankAcc } = await supabase
                  .from('bank_accounts').select('id')
                  .eq('organisation_id', organisationId)
                  .ilike('name', `%${params.bank_account_name}%`)
                  .eq('is_active', true).limit(1).maybeSingle();
                if (bankAcc) bankAccountId = bankAcc.id;
              } catch {}
            }
            const spResult = await recordSupplierPayment(supabase, organisationId, customerId, Number(params.amount), {
              paymentDate: params.payment_date || null,
              paymentMethod: params.payment_mode || null,
              billId: params.bill_id || null,
              bankAccountId,
              notes: params.notes || null,
            });
            if (spResult.status === 'failed') {
              failed.push(actionId);
              break;
            }
            const { data: spConv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
            if (spConv) {
              const paidStr = spResult.bills_paid_full?.length > 0 ? ` · ${spResult.bills_paid_full.length} bill(s) fully paid` : '';
              await supabase.from('messages').insert({
                organisation_id: organisationId, conversation_id: spConv.id,
                role: 'system',
                content: `✓ Payment of ₹${(spResult.total_applied || 0).toLocaleString('en-IN')} recorded to ${spResult.entity_name}${paidStr}`,
                metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: true, preview_text: `Payment to ${spResult.entity_name} recorded` },
                tokens_input: 0, tokens_output: 0,
              });
            }
            executed.push(actionId);
            break;
          }

          default:
            failed.push(actionId);
        }

        // Mark action as executed
        if (executed.includes(actionId)) {
          await supabase.from('ai_actions').update({ status: 'executed' }).eq('id', actionId);
        }
      } catch (execErr) {
        console.error(`Action ${actionId} execution failed:`, execErr);
        failed.push(actionId);
      }
    }

    return c.json({ executed, failed });

  } catch (error) {
    console.error('POST /api/chat/spark/confirm error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── PATCH /api/chat/:customer_id/spark/action/:action_id ──
app.patch('/api/chat/:customer_id/spark/action/:action_id', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const actionId = c.req.param('action_id');

    const body = await c.req.json();
    const newParams = body.parameters;
    if (!newParams) return c.json({ error: 'missing_parameters' }, 400);

    const { data: action } = await supabase
      .from('ai_actions').select('id, parameters')
      .eq('id', actionId).eq('organisation_id', auth.organisationId).maybeSingle();
    if (!action) return c.json({ error: 'action_not_found' }, 404);

    const merged = { ...(action.parameters || {}), ...newParams };
    const { error: updateErr } = await supabase
      .from('ai_actions').update({ parameters: merged }).eq('id', actionId);
    if (updateErr) return c.json({ error: 'server_error' }, 500);

    return c.json({ action_id: actionId, updated: true });

  } catch (error) {
    console.error('PATCH /api/chat/spark/action error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── DELETE /api/chat/:customer_id/spark/:draft_id ─────────
app.delete('/api/chat/:customer_id/spark/:draft_id', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');
    const draftId = c.req.param('draft_id');

    // Fetch action before rejecting — need type for cancellation message
    const { data: action } = await supabase
      .from('ai_actions').select('id, action_type, action_name')
      .eq('id', draftId).eq('organisation_id', organisationId).maybeSingle();

    const { error: updateErr } = await supabase
      .from('ai_actions').update({ status: 'rejected' })
      .eq('id', draftId).eq('organisation_id', organisationId);
    if (updateErr) return c.json({ error: 'server_error' }, 500);

    // Write intent-reversal message to conversation
    // Phrasing avoids reinforcing product names — signals closed intent to AI
    // AI reads this in recentText and does not treat previous draft as active
    try {
      const { data: conv } = await supabase
        .from('conversations').select('id')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer')
        .eq('entity_id', customerId).eq('status', 'active').maybeSingle();

      if (conv) {
        const actionLabel = action?.action_type === 'create_invoice' ? 'invoice'
          : action?.action_type === 'create_quote' ? 'quote' : 'action';
        await supabase.from('messages').insert({
          organisation_id: organisationId,
          conversation_id: conv.id,
          role: 'tool',
          content: `Owner reviewed the ${actionLabel} preview and chose not to proceed. This draft is closed. Treat the next owner message as a fresh instruction.`,
          metadata: {
            sender_type: 'system',
            visibility: 'owner',
            message_type: 'action_cancelled',
            read_by_owner: true,
            preview_text: `${actionLabel} draft cancelled`,
          },
          tokens_input: 0,
          tokens_output: 0,
        });
      }
    } catch (msgErr) {
      console.warn('[CANCEL] cancellation message write failed silently:', msgErr.message);
    }

    return c.json({ cancelled: true });
  } catch (error) {
    console.error('DELETE /api/chat/spark error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
// AI MESSAGES — Customer-scoped AI query (Flow 3A AI Tab)
// ══════════════════════════════════════════════════════════════

const AI_QUERY_TOOLS = [
  { type: 'function', function: { name: 'get_customer_info', description: 'Get customer profile: name, phone, outstanding balance, tags, health score', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_customer_invoices', description: 'Get all invoices for this customer with amounts, dates, status, items', parameters: { type: 'object', properties: { status: { type: 'string', description: 'Filter: all, paid, unpaid, overdue. Default: all' } }, required: [] } } },
  { type: 'function', function: { name: 'get_purchase_history', description: 'Get products purchased by this customer with quantities, amounts, dates', parameters: { type: 'object', properties: { months: { type: 'number', description: 'How many months back to look. Default: 6' } }, required: [] } } },
  { type: 'function', function: { name: 'get_financial_summary', description: 'Total purchases, total payments, outstanding balance, avg order value for this customer in a date range', parameters: { type: 'object', properties: { months: { type: 'number', description: 'Months back. Default: 6' } }, required: [] } } },
  { type: 'function', function: { name: 'get_customer_tasks', description: 'Get pending tasks, reminders, deliveries for this customer', parameters: { type: 'object', properties: {}, required: [] } } },
];

async function executeAiQueryTool(toolName, args, supabase, organisationId, customerId) {
  switch (toolName) {
    case 'get_customer_info': {
      const { data: cust } = await supabase.from('customers').select('name, phone, outstanding_balance, custom_fields')
        .eq('id', customerId).eq('organisation_id', organisationId).single();
      const { data: tags } = await supabase.from('customer_tags').select('tags(name)')
        .eq('customer_id', customerId);
      const tagNames = (tags || []).map(t => t.tags?.name).filter(Boolean);
      return { name: cust?.name, phone: cust?.phone, outstanding_balance: cust?.outstanding_balance || 0, health_score: cust?.custom_fields?.health_score, tags: tagNames };
    }
    case 'get_customer_invoices': {
      const includeHistorical = args.include_historical === true;
      let q = supabase.from('invoices').select('invoice_number, status, total_amount, amount_paid, amount_due, issue_date, due_date')
        .eq('organisation_id', organisationId).eq('customer_id', customerId).order('issue_date', { ascending: false }).limit(20);
      if (!includeHistorical) q = q.eq('is_historical', false);
      if (args.status === 'paid') q = q.eq('status', 'paid');
      else if (args.status === 'unpaid') q = q.neq('status', 'paid');
      else if (args.status === 'overdue') q = q.neq('status', 'paid').lt('due_date', new Date().toISOString().split('T')[0]);
      const { data } = await q;
      return { invoices: data || [], count: (data || []).length };
    }
    case 'get_purchase_history': {
      const months = args.months || 6;
      const since = new Date(); since.setMonth(since.getMonth() - months);
      const { data: invs } = await supabase.from('invoices').select('id, invoice_number, total_amount, issue_date')
        .eq('organisation_id', organisationId).eq('customer_id', customerId).gte('issue_date', since.toISOString().split('T')[0]);
      const invIds = (invs || []).map(i => i.id);
      let items = [];
      if (invIds.length > 0) {
        const { data: ii } = await supabase.from('invoice_items').select('description, quantity, unit_price, line_total, invoice_id')
          .eq('organisation_id', organisationId).in('invoice_id', invIds);
        items = ii || [];
      }
      // Aggregate by product
      const productMap = {};
      for (const item of items) {
        const key = item.description;
        if (!productMap[key]) productMap[key] = { product: key, total_qty: 0, total_amount: 0, orders: 0 };
        productMap[key].total_qty += item.quantity || 0;
        productMap[key].total_amount += item.line_total || 0;
        productMap[key].orders += 1;
      }
      return { products: Object.values(productMap), invoice_count: invs?.length || 0, period_months: months };
    }
    case 'get_financial_summary': {
      const months = args.months || 6;
      const since = new Date(); since.setMonth(since.getMonth() - months);
      const { data: invs } = await supabase.from('invoices').select('total_amount, amount_paid, status, issue_date')
        .eq('organisation_id', organisationId).eq('customer_id', customerId).eq('is_historical', false).gte('issue_date', since.toISOString().split('T')[0]);
      const totalPurchases = (invs || []).reduce((s, i) => s + (i.total_amount || 0), 0);
      const totalPaid = (invs || []).reduce((s, i) => s + (i.amount_paid || 0), 0);
      const { data: cust } = await supabase.from('customers').select('outstanding_balance').eq('id', customerId).single();
      return { total_purchases: totalPurchases, total_paid: totalPaid, outstanding: cust?.outstanding_balance || 0, invoice_count: (invs || []).length, avg_order: (invs || []).length > 0 ? Math.round(totalPurchases / invs.length) : 0, period_months: months };
    }
    case 'get_customer_tasks': {
      const { data: tasks } = await supabase.from('tasks').select('title, status, priority, due_date, entity_type')
        .eq('organisation_id', organisationId).eq('entity_id', customerId).neq('status', 'completed').order('due_date', { ascending: true }).limit(10);
      return { tasks: tasks || [], count: (tasks || []).length };
    }
    default:
      return { error: 'Unknown tool' };
  }
}

// ─── GET /api/chat/:customer_id/ai-conversations ────────────────
app.get('/api/chat/:customer_id/ai-conversations', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    // Fetch all AI conversations for this customer
    const { data: conversations } = await supabase
      .from('ai_conversations')
      .select('id, title, is_archived, created_at, last_message_at')
      .eq('organisation_id', organisationId)
      .eq('customer_id', customerId)
      .eq('scope', 'customer')
      .eq('is_archived', false)
      .order('last_message_at', { ascending: false })
      .limit(20);

    return c.json({ conversations: conversations || [] });
  } catch (error) {
    console.error('GET /api/chat/:customer_id/ai-conversations error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/chat/:customer_id/ai-conversations ───────────────
app.post('/api/chat/:customer_id/ai-conversations', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const title = null; // title set via auto-title on first message, not on creation

    // Create new AI conversation
    const { data: newConv, error: convError } = await supabase
      .from('ai_conversations')
      .insert({
        organisation_id: organisationId,
        customer_id: customerId,
        scope: 'customer',
        title: title,
        is_archived: false,
        custom_fields: {},
      })
      .select('id, title, is_archived, created_at')
      .single();

    if (convError || !newConv) {
      return c.json({ error: 'failed_to_create_conversation' }, 500);
    }

    return c.json({ conversation: newConv });
  } catch (error) {
    console.error('POST /api/chat/:customer_id/ai-conversations error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/chat/:customer_id/ai-messages ──────────────────
// Returns only AI messages (ai_query, ai_response, action_card) for a specific ai_conversation_id
// Separate from /api/chat/:customer_id which returns direct/operational messages only
app.get('/api/chat/:customer_id/ai-messages', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const aiConversationId = c.req.query('ai_conversation_id');
    if (!aiConversationId) return c.json({ error: 'missing_ai_conversation_id' }, 400);

    // Validate ai_conversation_id belongs to this org + customer — security boundary
    const { data: aiConvCheck } = await supabase
      .from('ai_conversations')
      .select('id')
      .eq('id', aiConversationId)
      .eq('organisation_id', organisationId)
      .eq('customer_id', customerId)
      .eq('scope', 'customer')
      .eq('is_archived', false)
      .single();
    if (!aiConvCheck) return c.json({ error: 'ai_conversation_not_found' }, 403);

    // Fetch the conversation_id for this customer
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('entity_type', 'customer')
      .eq('entity_id', customerId)
      .eq('status', 'active')
      .maybeSingle();

    if (!conversation) return c.json({ messages: [], has_more: false });

    const before = c.req.query('before');
    let query = supabase
      .from('messages')
      .select('id, role, content, canonical_text, input_modality, metadata, created_at, ai_conversation_id')
      .eq('conversation_id', conversation.id)
      .eq('ai_conversation_id', aiConversationId)
      .in('metadata->>message_type', ['ai_query', 'ai_response', 'action_card'])
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(31);

    if (before) query = query.lt('created_at', before);

    const { data: msgData, error: msgErr } = await query;
    if (msgErr) {
      console.error('GET /ai-messages query error:', msgErr);
      return c.json({ error: 'server_error' }, 500);
    }

    const hasMore = msgData.length === 31;
    const slice = hasMore ? msgData.slice(0, 30) : msgData;
    const messages = slice.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      sender_type: m.metadata?.sender_type || null,
      visibility: m.metadata?.visibility || 'both',
      message_type: m.metadata?.message_type || 'text',
      card_type: m.metadata?.card_type || null,
      card_data: m.metadata?.card_data || {},
      preview_text: m.metadata?.preview_text || null,
      metadata: m.metadata || {},
      ai_conversation_id: m.ai_conversation_id || null,
      canonical_text: m.canonical_text || null,
      input_modality: m.input_modality || m.metadata?.input_modality || "text",
    }));

    return c.json({ messages, has_more: hasMore });

  } catch (error) {
    console.error('GET /api/chat/:customer_id/ai-messages error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

app.post('/api/chat/:customer_id/ai-query', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const conversationId = body.conversation_id;
    if (!conversationId) return c.json({ error: 'missing_conversation_id' }, 400);

    // Accept optional ai_conversation_id (additive — conversation_id continues working)
    const aiConversationId = body.ai_conversation_id || null;

    // Validate ai_conversation_id belongs to this org + customer — security boundary
    if (aiConversationId) {
      const { data: aiConvCheck } = await supabase
        .from('ai_conversations')
        .select('id')
        .eq('id', aiConversationId)
        .eq('organisation_id', organisationId)
        .eq('customer_id', customerId)
        .eq('scope', 'customer')
        .eq('is_archived', false)
        .single();
      if (!aiConvCheck) {
        return c.json({ error: 'invalid_ai_conversation_id', message: 'AI conversation not found or access denied.' }, 403);
      }
    }

    // Get owner's preferred language
    const language = auth.primaryLanguage || 'en';

    // Read attachment early — needed before empty_query guard for audio
    const attachmentRaw = body.attachment || null;

    // Determine input modality
    let inputModality = 'text';
    if (attachmentRaw) {
      if (attachmentRaw.type === 'audio' || attachmentRaw.mime_type?.startsWith('audio')) inputModality = 'audio';
      else if (attachmentRaw.type === 'image' || attachmentRaw.mime_type?.startsWith('image')) inputModality = 'image';
      else if (attachmentRaw.type === 'file') inputModality = 'document';
    }

    // Whisper transcription for audio attachments
    let audioTranscript = '';
    if (inputModality === 'audio' && attachmentRaw?.url) {
      try {
        const whisperClient = getOpenAI();
        if (whisperClient) {
          const fetchController = new AbortController();
          const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
          try {
            const audioRes = await fetch(attachmentRaw.url, { signal: fetchController.signal });
            if (audioRes.ok) {
              const audioBuffer = await audioRes.arrayBuffer();
              if (audioBuffer.byteLength <= 8 * 1024 * 1024) {
                const { toFile } = await import('openai');
                const audioFile = await toFile(
                  Buffer.from(audioBuffer),
                  attachmentRaw.name || 'audio.m4a',
                  { type: attachmentRaw.mime_type || 'audio/m4a' }
                );
                const whisperController = new AbortController();
                const whisperTimeout = setTimeout(() => whisperController.abort(), 30000);
                try {
                  const transcription = await whisperClient.audio.transcriptions.create({
                    model: 'whisper-1',
                    file: audioFile,
                  }, { signal: whisperController.signal });
                  audioTranscript = transcription.text?.trim() || '';
                } finally {
                  clearTimeout(whisperTimeout);
                }
              }
            }
          } finally {
            clearTimeout(fetchTimeout);
          }
        }
      } catch (whisperErr) {
        console.error('AI query Whisper transcription failed:', whisperErr.message);
      }
    }

    // Build effective query — transcript overrides empty text for audio
    const rawQuery = body.query?.trim() || '';
    let effectiveQuery = rawQuery;
    if (inputModality === 'audio') {
      if (audioTranscript) {
        effectiveQuery = audioTranscript;
        if (rawQuery) effectiveQuery = rawQuery + '\n\n[Voice note transcript: ' + audioTranscript + ']';
      } else if (!rawQuery) {
        effectiveQuery = 'Owner sent a voice note but transcription failed. Ask them to type their question.';
      }
    } else if (!rawQuery && attachmentRaw) {
      effectiveQuery = attachmentRaw.type === 'image'
        ? 'Analyze this image in the context of this customer.'
        : 'Analyze this document in the context of this customer.';
      if (rawQuery) effectiveQuery = rawQuery + '\n\n[Customer attachment: ' + attachmentRaw.name + ']';
    }

    if (!effectiveQuery) return c.json({ error: 'empty_query' }, 400);

    // canonical_text = faithful extraction (transcript for audio, raw text for others)
    const canonicalText = inputModality === 'audio'
      ? (audioTranscript || rawQuery || null)
      : (rawQuery || null);

    // UI display content — audio shows voice note label
    const displayContent = inputModality === 'audio'
      ? (rawQuery || '\ud83c\udfa4 Voice note')
      : effectiveQuery;

    // Save owner's query as owner-only message
    const insertPayload = {
      organisation_id: organisationId, conversation_id: conversationId,
      role: 'user', content: displayContent,
      canonical_text: canonicalText,
      input_modality: inputModality,
      metadata: {
        sender_type: 'owner', visibility: 'owner_only', message_type: 'ai_query',
        read_by_owner: true, preview_text: displayContent.substring(0, 50),
        attachment: attachmentRaw || undefined,
      },
      tokens_input: 0, tokens_output: 0,
    };
    if (aiConversationId) {
      insertPayload.ai_conversation_id = aiConversationId;
    }
    await supabase.from('messages').insert(insertPayload);

    // Use effectiveQuery for AI reasoning
    const query = effectiveQuery;

    const client = getOpenAI();
    if (!client) return c.json({ error: 'ai_error', message: 'AI not configured' }, 500);

    // Language name map — ISO code to full name + script for GPT clarity
    const LANGUAGE_NAMES = {
      'ur': 'Urdu (written in Arabic/Nastaliq script only, never Devanagari)',
      'hi': 'Hindi (written in Devanagari script only)',
      'en': 'English',
      'ar': 'Arabic',
      'bn': 'Bengali',
      'pa': 'Punjabi',
      'gu': 'Gujarati',
      'mr': 'Marathi',
      'ta': 'Tamil',
      'te': 'Telugu',
      'kn': 'Kannada',
      'ml': 'Malayalam',
    };
    const languageName = LANGUAGE_NAMES[language] || language;

    // Fetch business profile for owner identity injection in drafts
    const { data: bizProfile } = await supabase
      .from('business_profiles')
      .select('business_name, phone, email')
      .eq('organisation_id', organisationId)
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .limit(1)
      .single();

    const ownerName = bizProfile?.business_name || null;
    const ownerPhone = bizProfile?.phone || null;

    // Fetch customer language preference
    const { data: custLangData } = await supabase
      .from('customers')
      .select('custom_fields')
      .eq('id', customerId)
      .single();
    const customerLanguage = custLangData?.custom_fields?.language || null;
    const customerLanguageName = customerLanguage
      ? (LANGUAGE_NAMES[customerLanguage] || customerLanguage)
      : null;

    // Build owner signature for customer-facing drafts
    const ownerSignature = ownerName
      ? `${ownerName}${ownerPhone ? '\n' + ownerPhone : ''}`
      : null;

    const systemPrompt = `You are a business intelligence assistant for an Indian MSME trader. You answer questions about customer "${customer.name}".

== RESPONSE STYLE (non-negotiable) ==
- Keep ALL owner-facing responses SHORT. Maximum 5 bullet points or 3 lines of prose. No long paragraphs.
- Lead with the most important number or insight first.
- Use bullet points (•) not paragraphs for lists.
- For financial data (outstanding, payments, invoices): NEVER use pipe tables or markdown tables. Instead, append a [VIZ:...] block per the VISUALIZATION RULES below.
- Never explain what you are doing. Just give the answer.
- If the answer is a single number or fact, just state it. No preamble.
- End EVERY owner-facing response with one line starting with "→" suggesting the single most logical next action the owner should take, framed as a question. Example: "→ Want me to draft a payment reminder?" Make it specific and directly actionable within this app.
- The → next action line must follow the same language as the rest of the owner-facing response (per language policy below).
- NEVER suggest vague actions. Make it specific: draft a message, schedule a reminder, create an invoice.
- MANDATORY: When your response contains ANY of the following, you MUST append a [VIZ:{...}] block at the very end (after the → line):
  * 2 or more financial or business KPIs (amounts, counts, ratios, averages)
  * Any ranked list of customers, invoices, or products with amounts
  * Any payment behavior analysis
  * Any customer summary or account overview
  * Any outstanding balance breakdown
  * Any purchase history or product breakdown
  * Any business health or performance summary
  Use these type mappings:
  * payment behavior / pattern analysis → metric_grid
  * customer summary / account overview → metric_grid
  * outstanding invoices / ranked amounts → ranked_list
  * top products / purchase history → ranked_list
  * single dominant KPI → metric
  * risk or overdue alerts → risk_list
  * one key insight → insight
  Omitting [VIZ:...] when any of the above conditions are met is an error.

== LANGUAGE POLICY (non-negotiable) ==
Owner-facing responses (analysis, briefs, summaries, insights): MUST be in ${languageName}. Use that script exclusively. Never switch scripts.
Customer-facing draft messages (reminders, follow-ups, WhatsApp messages): ${customerLanguageName ? `Use ${customerLanguageName} — this customer's confirmed preferred language.` : `Customer language not set. Detect the dominant language from recent conversation history and use that naturally. Match Hinglish or mixed styles if that is what is used. Never ask the owner.`}
Fallback to English only if the target language cannot be rendered.

== CAPABILITY REGISTRY (available business data) ==
This customer's data includes:
- Invoices: issue dates, due dates, amounts, products, quantities, status (earliest invoice date = relationship start date)
- Purchase history: products bought, order dates, order totals, quantities per product
- Payment records: payments received, payment dates, amounts, average payment delay
- Outstanding balance: current amount owed by this customer
- Reminders: scheduled and past reminders for this customer
- Message history: past conversations with this customer
Use this knowledge to infer answers to any owner query about this customer.

== DATA RULES ==
- ALWAYS call a tool first. NEVER guess or invent financial data.
- After receiving tool results, write a plain-language answer using ONLY the returned data.
- Amounts in INR (₹), Indian format: ₹1,20,000.
- Never invent numbers. If data is empty, say so clearly.
- Today's date: ${new Date().toISOString().split('T')[0]}

== OWNER BUSINESS PROFILE ==
Business name: ${ownerName || 'Not configured — owner must set up business profile'}
Phone: ${ownerPhone || 'Not configured'}

== DRAFT MESSAGE RULES ==
- NEVER use placeholders like [Your Name], [Company Name], or [Contact Number] in drafts.
- ${ownerSignature ? `Always sign customer-facing drafts with:\n${ownerSignature}` : `Business profile not configured — skip signature silently, do not mention it to the owner.`}

== ACTION CARD RULES ==
- Append [ACTION_CARD:draft_message] ONLY when your response is a message intended to be sent TO the customer (payment reminder, follow-up, reorder request, apology, delivery update).
- When creating an action card: (1) output ONLY the pure draft message with no preamble, no explanation, no prefix or suffix text. (2) ALWAYS append [ACTION_CARD:draft_message] at the very end — this is a required system tag, invisible to the user, do not omit it.
- NEVER append this marker for: analytical responses, owner briefs, summaries, data breakdowns, "Before I Call" briefs, internal insights, or any content the owner reads for themselves.

== VISUALIZATION RULES ==
When your response contains ranked data, totals, comparisons, or any business metric, append ONE visualization block at the very end of your response (after all text).

Supported types and when to use them:
- "metric"       — single KPI answer (e.g. total outstanding, total collections). Use when the answer is one number.
- "metric_grid"  — 2 to 4 KPIs together (e.g. business health summary, payment overview). Use for "how is my business doing" queries.
- "ranked_list"  — top-N items with amounts (e.g. top customers by dues, purchase history, reorder candidates). Use when answer is a ranked list.
- "risk_list"    — items with risk severity and days overdue (e.g. risk check, silence anomalies). Use for risk and alert queries.
- "insight"      — single dominant observation (e.g. one customer dominates outstanding). Use when one fact is more important than a list.

Format — append exactly ONE block in this format:
[VIZ:{"type":"ranked_list","title":"Top Outstanding Customers","currency":"INR","series":[{"label":"Ali Traders","value":45000},{"label":"Noor Enterprise","value":32000}],"highlight":"Ali Traders contributes 38% of total dues","level":"warning"}]

Schema per type:
- metric:       { type, title, value (formatted string e.g. Rs.4,52,000), subtitle?, level? }
- metric_grid:  { type, title, cards:[{ label, value, trend?, trend_direction }] } — trend_direction: up or down or flat
- ranked_list:  { type, title, currency, series:[{ label, value }], highlight?, level? }
- risk_list:    { type, title, series:[{ label, value, days_late?, level }], highlight? }
- insight:      { type, title, text, level }

Hard rules:
- ONE [VIZ:...] block per response maximum. Never more than one.
- ranked_list and risk_list series must contain a maximum of 5 items. If there are more, include only the top 5 by value.
- series labels and title always in English regardless of owner language setting.
- highlight text follows owner language setting.
- value fields in series are always plain numbers — no currency symbol, no commas.
- level values: info or warning or critical
- NEVER append [VIZ:...] on action cards or customer-facing draft messages.
- NEVER append [VIZ:...] if the response is purely conversational with no quantitative data.
- The JSON inside [VIZ:...] must always be valid. Never break the JSON structure.
- Never include markdown formatting or code fences inside [VIZ:...] block.
- If no visualization type fits the response, do not include the block at all.
- COMPLETION RULE: A response that contains financial data, business metrics, or ranked information is INCOMPLETE without a valid [VIZ:...] block as the final output. Always append it.`;

    // Build user message — multimodal if image attachment present
    // attachmentRaw already read above — do not re-read body.attachment
    const isImageAttachment = (
      attachmentRaw &&
      (attachmentRaw.type === 'image' || attachmentRaw.mime_type?.startsWith?.('image')) &&
      attachmentRaw.url
    );
    let userMessage;
    if (isImageAttachment) {
      userMessage = {
        role: 'user',
        content: [
          { type: 'text', text: query },
          { type: 'image_url', image_url: { url: attachmentRaw.url, detail: 'auto' } },
        ],
      };
    } else {
      userMessage = { role: 'user', content: query };
    }
    // Fetch last 15 AI conversation messages for continuity
    // If ai_conversation_id provided, filter by it; else fetch all AI messages
    let aiMessagesQuery = supabase
      .from('messages')
      .select('role, content, input_modality, created_at')
      .eq('conversation_id', conversationId)
      .in('metadata->>message_type', ['ai_query', 'ai_response', 'action_card']);
    
    if (aiConversationId) {
      aiMessagesQuery = aiMessagesQuery.eq('ai_conversation_id', aiConversationId);
    }
    
    const { data: recentAiMessages } = await aiMessagesQuery
      .order('created_at', { ascending: false })
      .limit(15);
    const conversationHistory = (recentAiMessages || [])
      .reverse()
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content || '',
      }))
      .filter(m => m.content.trim().length > 0);

    // Fetch working state from ai_conversations
    // If ai_conversation_id provided, fetch from that specific conversation
    let aiConvQuery = supabase
      .from('ai_conversations')
      .select('custom_fields, title')
      .eq('organisation_id', organisationId)
      .eq('customer_id', customerId)
      .eq('scope', 'customer');
    
    if (aiConversationId) {
      aiConvQuery = aiConvQuery.eq('id', aiConversationId);
    } else {
      aiConvQuery = aiConvQuery.order('created_at', { ascending: false }).limit(1);
    }
    
    const { data: aiConvData } = await aiConvQuery.maybeSingle();
    const workingState = aiConvData?.custom_fields?.working_state || null;
    const workingStateContext = workingState
      ? '\n\n== ACTIVE CONVERSATION STATE ==\n' + JSON.stringify(workingState, null, 2) + '\nUse this state to resolve references and avoid re-asking resolved questions.'
      : '';

    let messages = [
      { role: 'system', content: systemPrompt + workingStateContext },
      ...conversationHistory,
      userMessage,
    ];

    // First call — get tool call
    const controller1 = new AbortController();
    const t1 = setTimeout(() => controller1.abort(), 10000);
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: 'gpt-4o-mini', messages, tools: AI_QUERY_TOOLS, tool_choice: 'auto', temperature: 0.1,
      }, { signal: controller1.signal });
      clearTimeout(t1);
    } catch (e) {
      clearTimeout(t1);
      return c.json({ error: 'ai_error', message: 'AI temporarily unavailable' }, 500);
    }

    let responseText = '';
    const choice = completion.choices[0];

    if (choice.message.tool_calls?.length > 0) {
      // Execute tool calls
      messages.push(choice.message);
      for (const tc of choice.message.tool_calls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        const result = await executeAiQueryTool(tc.function.name, args, supabase, organisationId, customerId);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      // Second call — get natural language response
      const controller2 = new AbortController();
      const t2 = setTimeout(() => controller2.abort(), 25000);
      try {
        const completion2 = await client.chat.completions.create({
          model: 'gpt-4o-mini', messages, temperature: 0.2,
        }, { signal: controller2.signal });
        clearTimeout(t2);
        responseText = completion2.choices[0].message.content || 'No response';
      } catch (e) {
        clearTimeout(t2);
        responseText = 'AI processing failed. Please try again.';
      }
    } else {
      responseText = choice.message.content || 'No response';
    }

    // Detect and strip ACTION_CARD marker — backend is semantic authority
    const isActionCard = responseText.includes('[ACTION_CARD:draft_message]');
    const cleanResponse = responseText.replace(/\[ACTION_CARD:[^\]]+\]/g, '').trim();

    // Extract and strip VIZ block — visualization data for frontend rendering
    const { cleanText: finalResponse, chartData } = extractVisualization(cleanResponse);

    // Save AI response as owner-only message
    const responsePayload = {
      organisation_id: organisationId, conversation_id: conversationId,
      role: 'assistant', content: finalResponse,
      canonical_text: finalResponse,
      input_modality: 'text',
      metadata: {
        sender_type: 'ai', visibility: 'owner_only',
        message_type: isActionCard ? 'action_card' : 'ai_response',
        card_type: isActionCard ? 'draft_message' : null,
        shareable: isActionCard,
        chart_data: chartData || null,
        read_by_owner: true,
        preview_text: finalResponse.substring(0, 50),
      },
      tokens_input: 0, tokens_output: 0,
    };
    if (aiConversationId) {
      responsePayload.ai_conversation_id = aiConversationId;
    }
    const { data: savedMsg } = await supabase.from('messages').insert(responsePayload).select('id').single();

    // Update last_message_at on ai_conversation for correct recency ordering
    if (aiConversationId) {
      await supabase.from('ai_conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', aiConversationId)
        .eq('organisation_id', organisationId);
    }

    // Auto-generate title if ai_conversation has default/empty title
    if (aiConversationId && aiConvData) {
      const currentTitle = aiConvData.title || '';
      if (!currentTitle || currentTitle === 'New Chat' || currentTitle.trim() === '') {
        // Generate title from first query (max 40 chars)
        const firstQuery = effectiveQuery.substring(0, 40).trim();
        const autoTitle = firstQuery.length < effectiveQuery.length ? firstQuery + '...' : firstQuery;
        await supabase
          .from('ai_conversations')
          .update({ title: autoTitle })
          .eq('id', aiConversationId)
          .eq('organisation_id', organisationId);
      }
    }

    return c.json({
      message_id: savedMsg?.id,
      response: finalResponse,
      message_type: isActionCard ? 'action_card' : 'ai_response',
      card_type: isActionCard ? 'draft_message' : null,
      shareable: isActionCard,
      chart_data: chartData || null,
    });

  } catch (error) {
    console.error('POST /api/chat/ai-query error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});



// ══════════════════════════════════════════════════════════════
// FLOW 3B — CUSTOMER REPORT ROUTES
// ══════════════════════════════════════════════════════════════

// ─── GET /api/customer/:customer_id/report ──────────────────
app.get('/api/customer/:customer_id/report', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    // Q1: Customer
    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const nameParts = (customer.name || '').split(' ').filter(Boolean);
    const initials = nameParts.map(p => p[0]).join('').toUpperCase().slice(0, 2);
    const avatarColor = customer.custom_fields?.avatar_color || '#075E54';
    const healthScore = customer.custom_fields?.health_score ?? null;
    let healthLabel = 'Moderate';
    if (healthScore !== null) {
      if (healthScore >= 80) healthLabel = 'Good';
      else if (healthScore < 40) healthLabel = 'At Risk';
    }

    // Q2: All invoices for this customer
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, total_amount, amount_paid, status, created_at, updated_at, due_date')
      .eq('organisation_id', organisationId)
      .eq('customer_id', customerId)
      .order('created_at', { ascending: true });

    const allInvoices = invoices || [];
    const paidInvoices = allInvoices.filter(i => i.status === 'paid');
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const invoices12mo = allInvoices.filter(i => new Date(i.created_at) > twelveMonthsAgo);

    // Computed summary
    const lifetimeValue = paidInvoices.reduce((s, i) => s + (i.total_amount || 0), 0);
    const totalOrders12mo = invoices12mo.length;
    const avgOrderValue = allInvoices.length > 0
      ? allInvoices.reduce((s, i) => s + (i.total_amount || 0), 0) / allInvoices.length : null;

    // Key metrics
    const totalOrders = allInvoices.length;

    // Payment delay: AVG(updated_at - due_date) WHERE status='paid'
    let paymentDelayAvg = null;
    if (paidInvoices.length > 0) {
      const delays = paidInvoices
        .filter(i => i.updated_at && i.due_date)
        .map(i => (new Date(i.updated_at).getTime() - new Date(i.due_date).getTime()) / 86400000);
      if (delays.length > 0) {
        paymentDelayAvg = Math.round(delays.reduce((s, d) => s + d, 0) / delays.length);
      }
    }

    // Last order date
    const lastOrderDate = allInvoices.length > 0
      ? allInvoices[allInvoices.length - 1].created_at : null;

    // Order frequency: AVG days between consecutive invoice created_at
    let orderFrequencyDays = null;
    if (allInvoices.length >= 2) {
      const gaps = [];
      for (let i = 1; i < allInvoices.length; i++) {
        const gap = (new Date(allInvoices[i].created_at).getTime() - new Date(allInvoices[i - 1].created_at).getTime()) / 86400000;
        gaps.push(gap);
      }
      orderFrequencyDays = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    }

    // Q3: Bank transactions via invoice IDs
    let totalPaymentsReceived = null;
    const invoiceIds = allInvoices.map(i => i.id);
    if (invoiceIds.length > 0) {
      try {
        const { data: txns } = await supabase
          .from('bank_transactions')
          .select('amount')
          .eq('reference_type', 'invoice')
          .in('reference_id', invoiceIds)
          .is('deleted_at', null);
        if (txns && txns.length > 0) {
          totalPaymentsReceived = txns.reduce((s, t) => s + (t.amount || 0), 0);
        }
      } catch {}
    }

    // Q3b: Profit contribution via invoice_items + products
    let profitContributionPct = null;
    if (invoiceIds.length > 0) {
      try {
        const { data: items } = await supabase
          .from('invoice_items')
          .select('quantity, line_total, product_id')
          .in('invoice_id', invoiceIds);

        if (items && items.length > 0) {
          const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
          let prodMap = {};
          if (productIds.length > 0) {
            const { data: products } = await supabase
              .from('products').select('id, cost_price').in('id', productIds);
            (products || []).forEach(p => { prodMap[p.id] = p.cost_price; });
          }

          let totalCost = 0;
          let totalRevenue = 0;
          let hasCostData = false;
          items.forEach(item => {
            totalRevenue += item.line_total || 0;
            const cp = prodMap[item.product_id];
            if (cp && cp > 0) {
              totalCost += (item.quantity || 0) * cp;
              hasCostData = true;
            }
          });

          if (hasCostData && totalRevenue > 0) {
            profitContributionPct = Math.round(((totalRevenue - totalCost) / totalRevenue) * 100);
          }
        }
      } catch {}
    }

    // Invoice cleared percentage
    const allTotal = allInvoices.reduce((s, i) => s + (i.total_amount || 0), 0);
    const paidTotal = paidInvoices.reduce((s, i) => s + (i.total_amount || 0), 0);
    const invoiceClearedPct = allTotal > 0 ? Math.round((paidTotal / allTotal) * 100) : 0;

    // Q4: Entity memory for behavior insights
    let behaviorInsights = [];
    try {
      const { data: memories } = await supabase
        .from('entity_memory')
        .select('memory_key, memory_value')
        .eq('organisation_id', organisationId)
        .eq('entity_type', 'customer')
        .eq('entity_id', customerId)
        .is('deleted_at', null);
      behaviorInsights = memories || [];
    } catch {}

    // Q5: AI Smart Analysis (with timeout — non-blocking)
    let aiAnalysis = [];
    try {
      const client = getOpenAI();
      if (client) {
        const contextData = {
          customer_name: customer.name,
          outstanding_balance: customer.outstanding_balance || 0,
          order_frequency_days: orderFrequencyDays,
          last_order_date: lastOrderDate,
          total_orders: totalOrders,
          lifetime_value: lifetimeValue,
          health_score: healthScore,
          avg_order_value: avgOrderValue ? Math.round(avgOrderValue) : null,
          payment_delay_avg_days: paymentDelayAvg,
          total_payments_received: totalPaymentsReceived,
          profit_contribution_pct: profitContributionPct,
          invoice_cleared_pct: invoiceClearedPct,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Based on this customer data, generate exactly 3 short business insights for the owner. Do not invent facts. Use only the data provided. Keep each insight under 15 words. Output ONLY JSON: {"insights":[{"text":"...","highlight":false},{"text":"...","highlight":false},{"text":"...","highlight":true}]}`,
            },
            { role: 'user', content: JSON.stringify(contextData) },
          ],
          temperature: 0.3,
        }, { signal: controller.signal });
        clearTimeout(timeoutId);

        const aiText = completion.choices[0].message.content || '';
        try {
          const jsonMatch = aiText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed.insights)) {
              aiAnalysis = parsed.insights.filter(i => i && typeof i.text === 'string').slice(0, 3);
            }
          }
        } catch {}

        // Log usage
        try {
          await supabase.from('ai_usage_log').insert({
            organisation_id: organisationId, user_id: auth.userId,
            model: 'gpt-4o-mini', operation: 'customer_report',
            tokens_input: completion.usage?.prompt_tokens || 0,
            tokens_output: completion.usage?.completion_tokens || 0,
            cost_usd: ((completion.usage?.prompt_tokens || 0) * 0.00015 / 1000) + ((completion.usage?.completion_tokens || 0) * 0.00060 / 1000),
            duration_ms: 0, status: 'success',
          });
        } catch {}
      }
    } catch (aiErr) {
      // AI timeout or failure — return empty, don't block report
      console.warn('AI Smart Analysis failed:', aiErr.message);
      aiAnalysis = [];
    }

    return c.json({
      customer: {
        id: customer.id, name: customer.name, initials, avatar_color: avatarColor,
        outstanding_balance: customer.outstanding_balance || 0,
        health_score: healthScore, health_label: healthLabel,
        status: customer.status || 'active',
      },
      summary: {
        lifetime_value: lifetimeValue,
        total_orders_12mo: totalOrders12mo,
        avg_order_value: avgOrderValue !== null ? Math.round(avgOrderValue) : null,
      },
      metrics: {
        total_orders: totalOrders,
        payment_delay_avg_days: paymentDelayAvg,
        last_order_date: lastOrderDate,
        order_frequency_days: orderFrequencyDays,
      },
      financial: {
        total_payments_received: totalPaymentsReceived,
        profit_contribution_pct: profitContributionPct,
        invoice_cleared_pct: invoiceClearedPct,
      },
      behavior_insights: behaviorInsights,
      ai_analysis: aiAnalysis,
    });

  } catch (error) {
    console.error('GET /api/customer/report error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/customer/:customer_id/history ─────────────────
app.get('/api/customer/:customer_id/history', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, total_amount, amount_paid, status, created_at, invoice_number')
      .eq('organisation_id', organisationId)
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(50);

    const transactions = (invoices || []).map(inv => ({
      type: 'invoice',
      id: inv.id,
      invoice_number: inv.invoice_number,
      amount: inv.total_amount,
      amount_paid: inv.amount_paid || 0,
      date: inv.created_at,
      status: inv.status,
    }));

    return c.json({ transactions });

  } catch (error) {
    console.error('GET /api/customer/history error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
// FLOW 4 — INVOICE CREATION ROUTES
// ══════════════════════════════════════════════════════════════

// ─── GET /api/invoice/new ──────────────────────────────────
app.get('/api/invoice/new', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.query('customer_id');

    // Q1: Organisation
    const { data: org } = await supabase.from('organisations').select('id, name, logo_url').eq('id', organisationId).single();

    // Q2: Customer (validate org)
    let customerData = null;
    let billingAddress = null;
    let shippingAddress = null;
    if (customerId) {
      const cust = await validateCustomer(customerId, organisationId);
      if (cust) {
        customerData = { id: cust.id, name: cust.name, tax_id: cust.tax_id || null, custom_fields: cust.custom_fields || {} };
        // Q3: Addresses
        try {
          const { data: addrs } = await supabase.from('customer_addresses').select('*')
            .eq('customer_id', customerId).eq('organisation_id', organisationId);
          if (addrs) {
            const billing = addrs.find(a => a.address_type === 'billing' && a.is_default) || addrs.find(a => a.address_type === 'billing') || addrs[0];
            const shipping = addrs.find(a => a.address_type === 'shipping' && a.is_default) || addrs.find(a => a.address_type === 'shipping');
            if (billing) billingAddress = { id: billing.id, line1: billing.line1 || '', line2: billing.line2 || '', city: billing.city || '', state: billing.state || '', pincode: billing.pincode || '' };
            if (shipping) shippingAddress = { id: shipping.id, line1: shipping.line1 || '', city: shipping.city || '', state: shipping.state || '' };
          }
        } catch {}
      }
    }

    // Q3A: All customers (for dropdown)
    const { data: allCustomers } = await supabase.from('customers').select('id, name, phone')
      .eq('organisation_id', organisationId).eq('status', 'active').is('deleted_at', null).order('name');

    // Q4: Products (with images)
    const { data: products } = await supabase.from('products').select('id, name, sku, selling_price, tax_rate, unit, image_url, custom_fields')
      .eq('organisation_id', organisationId).eq('is_active', true).order('name');

    return c.json({
      organisation: { id: org?.id, name: org?.name, logo_url: org?.logo_url || null },
      customer: customerData,
      all_customers: (allCustomers || []).map(c => ({ id: c.id, name: c.name, phone: c.phone })),
      billing_address: billingAddress,
      shipping_address: shippingAddress,
      products: (products || []).map(p => ({
        id: p.id, name: p.name, sku: p.sku, selling_price: p.selling_price,
        tax_rate: p.tax_rate || 0, unit: p.unit || 'unit', hsn_code: p.custom_fields?.hsn_code || null,
        image_url: p.image_url || null,
      })),
      prefilled_items: [],
    });
  } catch (error) {
    console.error('GET /api/invoice/new error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/products/find ─────────────────────────────────
// DEPRECATED — use POST /api/products/resolve for full resolution
// Kept for backward compatibility with existing callers
app.get('/api/products/find', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json(null, 401);
    const { organisationId } = auth;
    const name = c.req.query('name')?.trim();
    if (!name) return c.json(null);
    const result = await resolveProduct({ productName: name, customerId: null, organisationId });
    return c.json(result.resolved || null);
  } catch (err) {
    console.error('[PRODUCTS/FIND] Error:', err);
    return c.json(null, 500);
  }
});

// ─── POST /api/products/resolve ──────────────────────────────
// Full Product Intelligence Engine endpoint
// exact → vocabulary → fuzzy → behaviorally ranked
// Returns: { resolved, alternatives, confidence, resolution_type }
app.post('/api/products/resolve', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const body = await c.req.json();
    const name = (body.name || '').trim();
    const customerId = body.customer_id || null;
    if (!name) return c.json({ error: 'name is required' }, 400);
    const result = await resolveProduct({ productName: name, customerId, organisationId });
    return c.json(result);
  } catch (err) {
    console.error('[PRODUCTS/RESOLVE] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── GET /api/products ──────────────────────────────────────
app.get('/api/products/list', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { data: products } = await supabase.from('products').select('id, name, sku, selling_price, tax_rate, unit, custom_fields')
      .eq('organisation_id', auth.organisationId).eq('is_active', true).order('name');
    return c.json({
      products: (products || []).map(p => ({
        id: p.id, name: p.name, sku: p.sku, selling_price: p.selling_price,
        tax_rate: p.tax_rate || 0, unit: p.unit || 'unit', hsn_code: p.custom_fields?.hsn_code || null,
      })),
    });
  } catch (error) {
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/invoice/ai-suggestion ─────────────────────────
app.get('/api/invoice/ai-suggestion', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const productId = c.req.query('product_id');
    const customerId = c.req.query('customer_id');
    if (!productId || !customerId) return c.json({ suggested_price: null, suggested_quantity: null, reason: 'Missing parameters' });

    // Check entity_memory for this customer+product
    let suggestion = { suggested_price: null, suggested_quantity: null, reason: 'No suggestion available yet' };
    try {
      const { data: memories } = await supabase.from('entity_memory').select('memory_key, memory_value')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer').eq('entity_id', customerId).is('deleted_at', null);
      // Check past invoices for this product+customer
      const { data: pastItems } = await supabase.from('invoice_items').select('quantity, unit_price, invoice_id')
        .eq('product_id', productId).eq('organisation_id', organisationId);
      if (pastItems && pastItems.length > 0) {
        const avgQty = Math.round(pastItems.reduce((s, i) => s + (i.quantity || 0), 0) / pastItems.length);
        const avgPrice = Math.round(pastItems.reduce((s, i) => s + (i.unit_price || 0), 0) / pastItems.length * 100) / 100;
        const custName = (await supabase.from('customers').select('name').eq('id', customerId).single()).data?.name || 'Customer';
        suggestion = { suggested_price: avgPrice, suggested_quantity: avgQty, reason: `${custName} usually orders ${avgQty} units at ₹${avgPrice}` };
      }
    } catch {}
    return c.json(suggestion);
  } catch (error) {
    return c.json({ suggested_price: null, suggested_quantity: null, reason: 'Error fetching suggestion' });
  }
});

// ─── PATCH /api/customers/:customer_id/name ────────────────


app.post('/api/debug/push-error', async (c) => {
  try {
    const body = await c.req.json();
    console.error('[PUSH-DEBUG] Error from device:', JSON.stringify(body));
    return c.json({ received: true });
  } catch (e) {
    return c.json({ received: true });
  }
});

app.post('/api/users/push-token', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId } = auth;
    const body = await c.req.json();
    const { push_token } = body;
    if (!push_token || !push_token.trim()) return c.json({ error: 'missing_push_token' }, 400);
    const { error: updateErr } = await supabase
      .from('users')
      .update({ push_token: push_token.trim() })
      .eq('id', userId);
    if (updateErr) {
      console.error('[PUSH] Token save error:', updateErr);
      return c.json({ error: 'server_error' }, 500);
    }
    console.log('[PUSH] Token saved for user:', userId);
    return c.json({ saved: true });
  } catch (error) {
    console.error('POST /api/users/push-token error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

app.patch('/api/customers/:customer_id/name', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const body = await c.req.json();
    const { name } = body;

    if (!name || !name.trim()) return c.json({ error: 'missing_name' }, 400);

    // Only update if current name looks like a phone number (digits only)
    const { data: customer } = await supabase
      .from('customers')
      .select('id, name')
      .eq('id', customerId)
      .eq('organisation_id', organisationId)
      .maybeSingle();

    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    // Guard: only update if name is a phone number pattern
    const isPhonePattern = /^[0-9+\s()-]{7,15}$/.test(customer.name.trim());
    if (!isPhonePattern) {
      return c.json({ updated: false, reason: 'name_already_set' });
    }

    const { error: updateErr } = await supabase
      .from('customers')
      .update({ name: name.trim() })
      .eq('id', customerId)
      .eq('organisation_id', organisationId);

    if (updateErr) return c.json({ error: 'server_error' }, 500);

    return c.json({ updated: true });
  } catch (error) {
    console.error('PATCH /api/customers/name error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── PATCH /api/customer/:customer_id/defaults ──────────────
app.patch('/api/customer/:customer_id/defaults', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const customerId = c.req.param('customer_id');
    const customer = await validateCustomer(customerId, auth.organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const currentFields = customer.custom_fields || {};
    const updated = {
      ...currentFields,
      payment_terms: body.payment_terms ?? currentFields.payment_terms,
      delivery_preference: body.delivery_preference ?? currentFields.delivery_preference,
      default_invoice_type: body.default_invoice_type ?? currentFields.default_invoice_type,
    };
    await supabase.from('customers').update({ custom_fields: updated }).eq('id', customerId).eq('organisation_id', auth.organisationId);
    return c.json({ saved: true });
  } catch (error) {
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/invoices ─────────────────────────────────────
app.post('/api/invoices', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const body = await c.req.json();
    const { customer_id, items, packing_handling, due_date, invoice_type, po_number } = body;

    if (!customer_id || !items || items.length === 0) return c.json({ error: 'missing_fields' }, 400);
    const customer = await validateCustomer(customer_id, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    // Generate unique invoice number by finding the max existing number
    const { data: existingInvoices } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('organisation_id', organisationId)
      .order('created_at', { ascending: false })
      .limit(100);
    
    let maxNum = 0;
    if (existingInvoices && existingInvoices.length > 0) {
      existingInvoices.forEach(inv => {
        const match = inv.invoice_number.match(/INV-(\d+)/);
        if (match) {
          const num = parseInt(match[1]);
          if (num > maxNum) maxNum = num;
        }
      });
    }
    
    const seqNum = maxNum + 1;
    const invoiceNumber = 'INV-' + seqNum.toString().padStart(3, '0');
    console.log(`📝 [INVOICE] Generated number: ${invoiceNumber} (max was ${maxNum})`);

    // Backend recomputes all financials
    let subtotal = 0;
    let totalTax = 0;
    let cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
    const computedItems = [];

    // Determine intra/inter state
    let supplierState = null;
    let customerState = null;
    try {
      const { data: orgData } = await supabase.from('organisations').select('settings').eq('id', organisationId).single();
      supplierState = orgData?.settings?.gstin_state || null;
    } catch {}
    try {
      const { data: addrs } = await supabase.from('customer_addresses').select('state')
        .eq('customer_id', customer_id).eq('organisation_id', organisationId).eq('address_type', 'billing').limit(1);
      customerState = addrs?.[0]?.state || null;
    } catch {}
    const isIntraState = supplierState && customerState && supplierState.toLowerCase() === customerState.toLowerCase();

    for (const item of items) {
      // Fetch product for selling_price and tax_rate
      const { data: product } = await supabase.from('products').select('id, name, selling_price, tax_rate, custom_fields')
        .eq('id', item.product_id).eq('organisation_id', organisationId).eq('is_active', true).single();
      if (!product) continue;

      const qty = item.quantity || 1;
      const unitPrice = product.selling_price || 0;
      const lineTotal = Math.round(qty * unitPrice * 100) / 100;
      const taxRate = product.tax_rate || 0;
      const itemTax = Math.round(lineTotal * taxRate / 100 * 100) / 100;

      subtotal += lineTotal;
      totalTax += itemTax;

      if (isIntraState || (!supplierState || !customerState)) {
        cgstTotal += Math.round(itemTax / 2 * 100) / 100;
        sgstTotal += Math.round(itemTax / 2 * 100) / 100;
      } else {
        igstTotal += itemTax;
      }

      computedItems.push({
        product_id: product.id, description: product.name, quantity: qty,
        unit_price: unitPrice, tax_rate: taxRate, line_total: lineTotal, sort_order: computedItems.length + 1,
        hsn_code: product.custom_fields?.hsn_code || null,
      });
    }

    const packingHandling = Math.round((packing_handling || 0) * 100) / 100;
    const totalAmount = Math.round((subtotal + totalTax + packingHandling) * 100) / 100;

    // Compute due_date
    let computedDueDate = due_date;
    if (!computedDueDate) {
      const paymentTerms = customer.custom_fields?.payment_terms || '';
      const match = paymentTerms.match(/(\d+)/);
      const days = match ? parseInt(match[1]) : 7;
      computedDueDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
    }

    // Create invoice
    const status = body.status || 'sent';
    const { data: newInvoice, error: invErr } = await supabase.from('invoices').insert({
      organisation_id: organisationId, customer_id, invoice_number: invoiceNumber,
      status, issue_date: new Date().toISOString().split('T')[0], due_date: computedDueDate,
      currency: 'INR', subtotal, tax_amount: totalTax, total_amount: totalAmount,
      amount_due: totalAmount, amount_paid: 0,
      custom_fields: {
        invoice_type: invoice_type || 'Tax Invoice', po_number: po_number || null,
        packing_handling: packingHandling,
        cgst_amount: cgstTotal, sgst_amount: sgstTotal, igst_amount: igstTotal,
      },
    }).select('id').single();

    if (invErr) { console.error('Create invoice error:', invErr); return c.json({ error: 'server_error', detail: invErr.message }, 500); }

    // Create invoice items
    for (const item of computedItems) {
      await supabase.from('invoice_items').insert({
        organisation_id: organisationId, invoice_id: newInvoice.id,
        product_id: item.product_id, description: item.description,
        quantity: item.quantity, unit_price: item.unit_price,
        tax_rate: item.tax_rate, line_total: item.line_total, sort_order: item.sort_order,
      });
    }

    // Update customer outstanding_balance
    if (status !== 'draft') {
      await supabase.from('customers')
        .update({ outstanding_balance: (customer.outstanding_balance || 0) + totalAmount })
        .eq('id', customer_id).eq('organisation_id', organisationId);
    }

    return c.json({ invoice_id: newInvoice.id, invoice_number: invoiceNumber, total_amount: totalAmount, pdf_url: null });
  } catch (error) {
    console.error('POST /api/invoices error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/invoices/:id/pdf ─────────────────────────────
app.post('/api/invoices/:invoice_id/pdf', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const invoiceId = c.req.param('invoice_id');

    console.log(`📄 [PDF] Generating for invoice: ${invoiceId}`);

    // Fetch invoice + items + customer + org
    const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).eq('organisation_id', organisationId).single();
    if (!invoice) {
      console.error('📄 [PDF] Invoice not found:', invoiceId);
      return c.json({ error: 'invoice_not_found' }, 404);
    }

    const { data: items } = await supabase.from('invoice_items').select('*').eq('invoice_id', invoiceId).order('sort_order');
    const { data: customer } = await supabase.from('customers').select('name, phone, tax_id').eq('id', invoice.customer_id).single();
    const { data: org } = await supabase.from('organisations').select('name').eq('id', organisationId).single();

    console.log(`📄 [PDF] Invoice: ${invoice.invoice_number}, Items: ${items?.length || 0}`);

    // Generate PDF with pdfkit
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    const pdfReady = new Promise((resolve) => doc.on('end', resolve));

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(org?.name || 'Business', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).font('Helvetica').text('TAX INVOICE', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Invoice #: ${invoice.invoice_number}`, { align: 'right' });
    doc.text(`Date: ${invoice.issue_date}`, { align: 'right' });
    doc.text(`Due: ${invoice.due_date}`, { align: 'right' });
    doc.moveDown(0.5);

    // Bill To
    doc.fontSize(11).font('Helvetica-Bold').text('BILL TO:');
    doc.font('Helvetica').fontSize(10).text(customer?.name || '');
    if (customer?.tax_id) doc.text(`GSTIN: ${customer.tax_id}`);
    doc.moveDown(1);

    // Items table header
    const tableTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('#', 50, tableTop, { width: 20 });
    doc.text('Item', 75, tableTop, { width: 200 });
    doc.text('Qty', 280, tableTop, { width: 40, align: 'right' });
    doc.text('Rate', 330, tableTop, { width: 70, align: 'right' });
    doc.text('Tax', 405, tableTop, { width: 40, align: 'right' });
    doc.text('Amount', 450, tableTop, { width: 95, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    // Items
    doc.font('Helvetica').fontSize(9);
    (items || []).forEach((item, i) => {
      const y = doc.y;
      doc.text(`${i + 1}`, 50, y, { width: 20 });
      doc.text(item.description || '', 75, y, { width: 200 });
      doc.text(`${item.quantity}`, 280, y, { width: 40, align: 'right' });
      doc.text(`₹${(item.unit_price || 0).toFixed(2)}`, 330, y, { width: 70, align: 'right' });
      doc.text(`${item.tax_rate || 0}%`, 405, y, { width: 40, align: 'right' });
      doc.text(`₹${(item.line_total || 0).toFixed(2)}`, 450, y, { width: 95, align: 'right' });
      doc.moveDown(0.5);
    });

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // Totals
    const totalsX = 380;
    doc.font('Helvetica').fontSize(10);
    doc.text('Subtotal:', totalsX, doc.y, { width: 70 });
    doc.text(`₹${(invoice.subtotal || 0).toFixed(2)}`, 450, doc.y - 12, { width: 95, align: 'right' });
    doc.moveDown(0.3);
    doc.text(`GST:`, totalsX, doc.y, { width: 70 });
    doc.text(`₹${(invoice.tax_amount || 0).toFixed(2)}`, 450, doc.y - 12, { width: 95, align: 'right' });
    if (invoice.custom_fields?.packing_handling > 0) {
      doc.moveDown(0.3);
      doc.text('P&H:', totalsX, doc.y, { width: 70 });
      doc.text(`₹${invoice.custom_fields.packing_handling.toFixed(2)}`, 450, doc.y - 12, { width: 95, align: 'right' });
    }
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('TOTAL:', totalsX, doc.y, { width: 70 });
    doc.text(`₹${(invoice.total_amount || 0).toFixed(2)}`, 450, doc.y - 14, { width: 95, align: 'right' });

    doc.end();
    await pdfReady;

    const pdfBuffer = Buffer.concat(chunks);
    const fileName = `${invoice.invoice_number}_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0,15)}.pdf`;
    const storagePath = `${organisationId}/${fileName}`;

    console.log(`📄 [PDF] Uploading to storage: ${storagePath}`);

    // Upload to Supabase Storage
    const { error: uploadErr } = await supabase.storage.from('invoices').upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf', upsert: true,
    });
    if (uploadErr) {
      console.error('📄 [PDF] Upload error:', uploadErr);
      return c.json({ error: 'upload_failed', detail: uploadErr.message }, 500);
    }

    const { data: publicUrl } = supabase.storage.from('invoices').getPublicUrl(storagePath);
    console.log(`📄 [PDF] Public URL: ${publicUrl.publicUrl}`);

    // Save to attachments table
    try {
      await supabase.from('attachments').insert({
        organisation_id: organisationId, entity_type: 'invoice', entity_id: invoiceId,
        file_name: fileName, mime_type: 'application/pdf',
        storage_path: storagePath, public_url: publicUrl.publicUrl,
      });
      console.log(`📄 [PDF] Attachment record saved`);
    } catch (attErr) {
      console.warn('📄 [PDF] Attachment record failed:', attErr);
    }

    return c.json({ pdf_url: publicUrl.publicUrl, attachment_id: null });
  } catch (error) {
    console.error('POST /api/invoices/pdf error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/invoices/:id/share ───────────────────────────
app.post('/api/invoices/:invoice_id/share', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId, userId } = auth;
    const invoiceId = c.req.param('invoice_id');
    const body = await c.req.json();
    const channel = body.channel || 'app';

    const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).eq('organisation_id', organisationId).single();
    if (!invoice) return c.json({ error: 'invoice_not_found' }, 404);

    const { data: customer } = await supabase.from('customers').select('id, name, phone').eq('id', invoice.customer_id).single();

    if (channel === 'app') {
      // Send invoice card to chat
      console.log(`📱 [SHARE] Sharing to app for invoice: ${invoiceId}`);
      const { data: conv } = await supabase.from('conversations').select('id')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer')
        .eq('entity_id', invoice.customer_id).eq('status', 'active').maybeSingle();
      
      if (!conv) {
        console.error(`📱 [SHARE] No active conversation found for customer: ${invoice.customer_id}`);
        return c.json({ shared: false, message_id: null, error: 'no_conversation' });
      }
      
      console.log(`📱 [SHARE] Found conversation: ${conv.id}`);
      
      // Fetch items summary
      const { data: items } = await supabase.from('invoice_items').select('description, quantity').eq('invoice_id', invoiceId).limit(3);
      const itemsSummary = (items || []).map(i => `${i.description} × ${i.quantity}`).join(', ');

      // Get PDF URL
      const { data: attachment } = await supabase.from('attachments').select('public_url')
        .eq('entity_type', 'invoice').eq('entity_id', invoiceId).order('created_at', { ascending: false }).limit(1).maybeSingle();

      console.log(`📱 [SHARE] PDF URL: ${attachment?.public_url || 'None'}`);

      const { data: msg, error: msgErr } = await supabase.from('messages').insert({
        organisation_id: organisationId, conversation_id: conv.id,
        role: 'tool', content: `Invoice #${invoice.invoice_number} created`,
        metadata: {
          sender_type: 'system', visibility: 'both', message_type: 'invoice_card',
          read_by_owner: true, preview_text: `Invoice #${invoice.invoice_number} - ₹${invoice.total_amount}`,
          card_type: 'invoice_card',
          card_data: {
            invoice_id: invoiceId, invoice_number: invoice.invoice_number,
            total_amount: invoice.total_amount, due_date: invoice.due_date,
            status: invoice.status, items_summary: itemsSummary,
            pdf_url: attachment?.public_url || null,
          },
        },
        tokens_input: 0, tokens_output: 0,
      }).select('id, metadata, content').single();
      
      if (msgErr) {
        console.error(`📱 [SHARE] Message insert error:`, msgErr);
        return c.json({ shared: false, error: msgErr.message }, 500);
      }

      await mirrorCardToReceiverOrg({
        supabase,
        senderOrgId: organisationId,
        senderUserId: userId,
        customerPhone: customer?.phone,
        originalMetadata: msg?.metadata || {},
        originalContent: msg?.content || '',
      });
      
      await broadcastNewMessage(organisationId, { conversation_id: conv.id });
      console.log(`📱 [SHARE] Message created: ${msg?.id}`);
      return c.json({ shared: true, message_id: msg?.id });

    } else if (channel === 'whatsapp') {
      console.log(`💬 [WHATSAPP] Sharing invoice: ${invoiceId}`);
      const phone = (customer?.phone || '').replace(/[^0-9]/g, '');
      console.log(`💬 [WHATSAPP] Customer phone: ${phone}`);
      
      // Get PDF URL
      const { data: attachment } = await supabase.from('attachments').select('public_url')
        .eq('entity_type', 'invoice').eq('entity_id', invoiceId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      
      const pdfLink = attachment?.public_url ? `\n📄 ${attachment.public_url}` : '';
      console.log(`💬 [WHATSAPP] PDF link: ${pdfLink || 'None'}`);
      
      const text = encodeURIComponent(
        `Hi ${customer?.name || 'there'}, here's your invoice #${invoice.invoice_number} for ₹${(invoice.total_amount || 0).toLocaleString('en-IN')}.\n\nBill generated by AssistMe. Download AssistMe: https://assistme.app${pdfLink}`
      );
      const waUrl = `https://wa.me/${phone}?text=${text}`;
      console.log(`💬 [WHATSAPP] WhatsApp URL generated`);
      return c.json({ shared: true, whatsapp_url: waUrl });
    }

    return c.json({ error: 'invalid_channel' }, 400);
  } catch (error) {
    console.error('POST /api/invoices/share error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
// FLOW 5 — SMART CATALOG ROUTES
// ══════════════════════════════════════════════════════════════

// ─── POST /api/products ─────────────────────────────────────
app.post('/api/products', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const body = await c.req.json().catch(() => ({}));
    const { createProduct } = await import('./services/business/productMutations.js');
    const result = await createProduct(supabase, organisationId, {
      name: body.name,
      sellingPrice: body.selling_price,
      taxRate: body.tax_rate,
      category: body.category || null,
      costPrice: body.cost_price || 0,
      unit: body.unit || 'pcs',
    });
    if (result.status === 'failed') return c.json({ error: result.error, message: result.message }, 400);
    return c.json(result.product, 201);
  } catch (err) {
    console.error('[POST /api/products] Error:', err.message);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── PATCH /api/products/:id ────────────────────────────────
// Handles: edit fields, archive (is_active=false), restore (is_active=true)
// No DELETE endpoint — soft delete is a state change via PATCH
app.patch('/api/products/:id', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const productId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const { updateProduct, archiveProduct, restoreProduct } = await import('./services/business/productMutations.js');
    if (body.is_active === false) {
      const result = await archiveProduct(supabase, organisationId, productId);
      if (result.status === 'failed') return c.json({ error: result.error }, 500);
      return c.json({ success: true, operation: 'archive' });
    }
    if (body.is_active === true) {
      const result = await restoreProduct(supabase, organisationId, productId);
      if (result.status === 'failed') return c.json({ error: result.error }, 500);
      return c.json({ success: true, operation: 'restore' });
    }
    const result = await updateProduct(supabase, organisationId, productId, {
      name: body.name,
      sellingPrice: body.selling_price,
      costPrice: body.cost_price,
      taxRate: body.tax_rate,
      category: body.category,
      unit: body.unit,
    });
    if (result.status === 'failed') return c.json({ error: result.error, message: result.message }, 400);
    return c.json(result.product);
  } catch (err) {
    console.error('[PATCH /api/products/:id]', err.message);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/products/:id/image ───────────────────────────
app.post('/api/products/:id/image', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const productId = c.req.param('id');

    const { data: product } = await supabase.from('products').select('id').eq('id', productId).eq('organisation_id', organisationId).single();
    if (!product) return c.json({ error: 'not_found' }, 404);

    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return c.json({ error: 'no_file' }, 400);

    const mimeType = file.type || 'image/jpeg';
    if (!mimeType.startsWith('image/')) return c.json({ error: 'invalid_mime', message: 'Only images allowed' }, 400);

    const ext = (file.name || 'photo.jpg').split('.').pop() || 'jpg';
    const fileName = `products/${organisationId}/${productId}-${Date.now()}.${ext}`;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > 5 * 1024 * 1024) return c.json({ error: 'file_too_large', message: 'Max 5MB' }, 400);

    const { error: uploadErr } = await supabase.storage.from('chat-attachments').upload(fileName, buffer, { contentType: mimeType, upsert: true });
    if (uploadErr) return c.json({ error: 'upload_failed', message: uploadErr.message }, 500);

    const { data: urlData } = supabase.storage.from('chat-attachments').getPublicUrl(fileName);
    const imageUrl = urlData.publicUrl;

    await supabase.from('products').update({ image_url: imageUrl }).eq('id', productId).eq('organisation_id', organisationId);

    return c.json({ success: true, image_url: imageUrl, product_id: productId });
  } catch (err) {
    console.error('[POST /api/products/:id/image]', err.message);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/products/import/extract ──────────────────────
app.post('/api/products/import/extract', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    const body = await c.req.json();
    const { files } = body;
    if (!files || !Array.isArray(files) || files.length === 0)
      return c.json({ error: 'no_files' }, 400);

    const client = getOpenAI();
    if (!client) return c.json({ error: 'ai_unavailable' }, 503);

    const { data: org } = await supabase.from('organisations').select('subscription_plan').eq('id', organisationId).single();
    const plan = org?.subscription_plan || 'free';

    const { extractProductsFromFiles, resolveImportedProducts } = await import('./services/business/productImport.js');
    const { products, totalExtracted, usedFallback, importModel } = await extractProductsFromFiles({ files, client, plan });
    const { resolved, totalResolved, totalNew, totalFuzzy } = await resolveImportedProducts({ products, organisationId, supabase });

    return c.json({
      products: resolved,
      used_fallback: usedFallback,
      total: resolved.length,
      total_extracted: totalExtracted,
      total_resolved: totalResolved,
      total_new: totalNew,
      total_fuzzy: totalFuzzy,
      model_used: importModel,
    });
  } catch (err) {
    console.error('[POST /api/products/import/extract]', err.message);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/products/import/confirm ──────────────────────
app.post('/api/products/import/confirm', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    const body = await c.req.json();
    const { items } = body;
    if (!items || !Array.isArray(items))
      return c.json({ error: 'no_items' }, 400);

    const { confirmImportedProducts } = await import('./services/business/productImport.js');
    const result = await confirmImportedProducts({ items, organisationId, supabase });

    return c.json(result);
  } catch (err) {
    console.error('[POST /api/products/import/confirm]', err.message);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/products/archived ─────────────────────────────
app.get('/api/products/archived', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const { data: products, error } = await supabase
      .from('products')
      .select('id, name, category, selling_price, image_url')
      .eq('organisation_id', organisationId)
      .eq('is_active', false)
      .order('name');
    if (error) return c.json({ error: 'db_error' }, 500);
    return c.json({ products: products || [] });
  } catch (err) {
    console.error('[GET /api/products/archived]', err.message);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/catalog ───────────────────────────────────────
app.get('/api/catalog', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    const { data: org } = await supabase.from('organisations').select('id, name').eq('id', organisationId).single();
    const { data: products } = await supabase.from('products')
      .select('id, name, category, image_url, selling_price, cost_price, custom_fields, sku')
      .eq('organisation_id', organisationId).eq('is_active', true).order('category').order('name');

    const allProducts = (products || []).map(p => ({
      id: p.id, name: p.name, category: p.category || 'Uncategorized',
      image_url: p.image_url || null, selling_price: p.selling_price || 0,
      cost_price: p.cost_price || 0, is_top_seller: p.custom_fields?.is_top_seller || false,
      sku: p.sku || null,
    }));
    const categories = [...new Set(allProducts.map(p => p.category))];

    // Top sellers: single aggregation query on invoice_items
    let topSellerIds = new Set();
    try {
      const { data: salesData } = await supabase.from('invoice_items')
        .select('product_id, invoices!inner(organisation_id)')
        .eq('invoices.organisation_id', organisationId);
      if (salesData && salesData.length > 0) {
        const counts = {};
        salesData.forEach(row => { counts[row.product_id] = (counts[row.product_id] || 0) + 1; });
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        sorted.slice(0, 10).forEach(([pid]) => topSellerIds.add(pid));
      }
    } catch {}

    // Mark top sellers from query
    allProducts.forEach(p => {
      if (topSellerIds.has(p.id)) p.is_top_seller = true;
    });

    return c.json({ organisation: { id: org?.id, name: org?.name }, categories, products: allProducts });
  } catch (error) {
    console.error('GET /api/catalog error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/catalog/suggestions ──────────────────────────
app.post('/api/catalog/suggestions', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const body = await c.req.json();
    const selectedIds = body.selected_product_ids || [];

    if (selectedIds.length === 0) return c.json({ suggestions: [] });

    // Co-purchase analysis: find products bought in same invoices as selected products
    const coPurchaseCounts = {};
    try {
      // Get invoice_ids that contain selected products
      const { data: selectedItems } = await supabase.from('invoice_items')
        .select('invoice_id').in('product_id', selectedIds);
      if (!selectedItems || selectedItems.length === 0) return c.json({ suggestions: [] });

      const invoiceIds = [...new Set(selectedItems.map(i => i.invoice_id))];
      if (invoiceIds.length === 0) return c.json({ suggestions: [] });

      // Get all products in those invoices (excluding selected ones)
      const { data: coItems } = await supabase.from('invoice_items')
        .select('product_id').in('invoice_id', invoiceIds);

      (coItems || []).forEach(item => {
        if (!selectedIds.includes(item.product_id)) {
          coPurchaseCounts[item.product_id] = (coPurchaseCounts[item.product_id] || 0) + 1;
        }
      });
    } catch {}

    if (Object.keys(coPurchaseCounts).length === 0) return c.json({ suggestions: [] });

    // Top 5 by co_purchase_count
    const top5 = Object.entries(coPurchaseCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pid, count]) => ({ product_id: pid, count }));

    const top5Ids = top5.map(t => t.product_id);
    const { data: suggestedProducts } = await supabase.from('products')
      .select('id, name').in('id', top5Ids).eq('is_active', true);

    const prodMap = {};
    (suggestedProducts || []).forEach(p => { prodMap[p.id] = p.name; });

    // Get selected product names for AI reason
    const { data: selectedProds } = await supabase.from('products').select('id, name').in('id', selectedIds);
    const selectedNames = (selectedProds || []).map(p => p.name);

    // AI generates reason text
    let suggestions = top5.filter(t => prodMap[t.product_id]).map(t => ({
      product_id: t.product_id, product_name: prodMap[t.product_id],
      reason: `Often bought with ${selectedNames[0] || 'your selected items'} by your customers`,
      co_purchase_count: t.count,
    }));

    // Try AI for better reasons
    try {
      const client = getOpenAI();
      if (client && suggestions.length > 0) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 6000);
        const comp = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'system',
            content: 'Generate a short reason (under 10 words) for each product suggestion based on co-purchase data. Output JSON array: [{"product_id":"...","reason":"..."}]. No markdown.',
          }, {
            role: 'user',
            content: JSON.stringify({ selected: selectedNames, suggestions: suggestions.map(s => ({ product_id: s.product_id, name: s.product_name, co_count: s.co_purchase_count })) }),
          }],
          temperature: 0.3,
        }, { signal: controller.signal });
        clearTimeout(tid);

        const aiText = comp.choices[0].message.content || '';
        try {
          const match = aiText.match(/\[[\s\S]*\]/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            parsed.forEach(item => {
              const s = suggestions.find(sg => sg.product_id === item.product_id);
              if (s && item.reason) s.reason = item.reason;
            });
          }
        } catch {}
      }
    } catch {}

    return c.json({ suggestions: suggestions.map(s => ({ product_id: s.product_id, product_name: s.product_name, reason: s.reason })) });
  } catch (error) {
    console.error('POST /api/catalog/suggestions error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── PATCH /api/products/prices ─────────────────────────────
app.patch('/api/products/prices', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json();
    const updates = body.price_updates || [];
    let count = 0;
    for (const u of updates) {
      if (u.product_id && u.selling_price > 0) {
        const { error } = await supabase.from('products')
          .update({ selling_price: u.selling_price })
          .eq('id', u.product_id).eq('organisation_id', auth.organisationId);
        if (!error) count++;
      }
    }
    return c.json({ updated: count });
  } catch (error) {
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/catalog/pdf ──────────────────────────────────
app.post('/api/catalog/pdf', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const body = await c.req.json();
    const { product_ids, edited_prices, hide_prices } = body;

    if (!product_ids || product_ids.length === 0) return c.json({ error: 'no_products' }, 400);

    const { data: org } = await supabase.from('organisations').select('name').eq('id', organisationId).single();
    const { data: products } = await supabase.from('products')
      .select('id, name, category, selling_price, sku, custom_fields')
      .in('id', product_ids).eq('is_active', true);

    // Group by category
    const grouped = {};
    (products || []).forEach(p => {
      const cat = p.category || 'Uncategorized';
      if (!grouped[cat]) grouped[cat] = [];
      const price = (edited_prices && edited_prices[p.id]) ? edited_prices[p.id] : p.selling_price;
      grouped[cat].push({ ...p, display_price: price });
    });

    // Generate PDF
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    const pdfReady = new Promise(resolve => doc.on('end', resolve));

    doc.fontSize(22).font('Helvetica-Bold').text(org?.name || 'Product Catalog', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).font('Helvetica').fillColor('#666').text('PRODUCT CATALOG', { align: 'center' });
    doc.moveDown(1);

    for (const [category, items] of Object.entries(grouped)) {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#075E54').text(category);
      doc.moveDown(0.3);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E0E0E0').stroke();
      doc.moveDown(0.3);

      // Table header
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#999');
      doc.text('#', 40, doc.y, { width: 25 });
      doc.text('PRODUCT', 70, doc.y - 11, { width: 200 });
      doc.text('SKU', 280, doc.y - 11, { width: 80 });
      if (!hide_prices) doc.text('PRICE', 420, doc.y - 11, { width: 100, align: 'right' });
      doc.moveDown(0.4);

      items.forEach((item, i) => {
        if (doc.y > 750) { doc.addPage(); }
        doc.fontSize(10).font('Helvetica').fillColor('#333');
        doc.text(`${i + 1}`, 40, doc.y, { width: 25 });
        doc.text(item.name, 70, doc.y - 11, { width: 200 });
        doc.text(item.sku || '—', 280, doc.y - 11, { width: 80 });
        if (!hide_prices) doc.text(`₹${item.display_price.toFixed(2)}`, 420, doc.y - 11, { width: 100, align: 'right' });
        doc.moveDown(0.4);
      });
      doc.moveDown(0.5);
    }

    doc.end();
    await pdfReady;

    const pdfBuffer = Buffer.concat(chunks);
    const fileName = `catalog-${Date.now()}.pdf`;
    const storagePath = `${organisationId}/${fileName}`;

    const { error: uploadErr } = await supabase.storage.from('invoices').upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) return c.json({ error: 'upload_failed' }, 500);

    const { data: publicUrl } = supabase.storage.from('invoices').getPublicUrl(storagePath);

    let attachmentId = null;
    try {
      const { data: att } = await supabase.from('attachments').insert({
        organisation_id: organisationId, entity_type: 'catalog', entity_id: organisationId,
        file_name: fileName, mime_type: 'application/pdf', storage_path: storagePath, public_url: publicUrl.publicUrl,
      }).select('id').single();
      attachmentId = att?.id;
    } catch {}

    return c.json({ pdf_url: publicUrl.publicUrl, attachment_id: attachmentId });
  } catch (error) {
    console.error('POST /api/catalog/pdf error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/catalog/share ────────────────────────────────
app.post('/api/catalog/share', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const body = await c.req.json();
    const { customer_id, attachment_id, channel } = body;

    if (channel === 'app' && customer_id) {
      const { data: conv } = await supabase.from('conversations').select('id')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer')
        .eq('entity_id', customer_id).eq('status', 'active').maybeSingle();
      if (conv) {
        // Get PDF URL from attachment
        let pdfUrl = '';
        if (attachment_id) {
          const { data: att } = await supabase.from('attachments').select('public_url').eq('id', attachment_id).single();
          pdfUrl = att?.public_url || '';
        }
        const { data: msg } = await supabase.from('messages').insert({
          organisation_id: organisationId, conversation_id: conv.id,
          role: 'tool', content: 'Product catalog shared',
          metadata: {
            sender_type: 'system', visibility: 'both', message_type: 'text',
            read_by_owner: true, preview_text: 'Product catalog shared',
            card_type: 'catalog_card', card_data: { attachment_id, pdf_url: pdfUrl },
          },
          tokens_input: 0, tokens_output: 0,
        }).select('id').single();
        return c.json({ shared: true, message_id: msg?.id });
      }
      return c.json({ shared: false });
    } else if (channel === 'whatsapp' && customer_id) {
      const { data: cust } = await supabase.from('customers').select('phone').eq('id', customer_id).single();
      const phone = (cust?.phone || '').replace(/[^0-9]/g, '');
      let pdfUrl = '';
      if (attachment_id) {
        const { data: att } = await supabase.from('attachments').select('public_url').eq('id', attachment_id).single();
        pdfUrl = att?.public_url || '';
      }
      const text = encodeURIComponent(`Check out our latest product catalog:\n${pdfUrl}`);
      return c.json({ shared: true, whatsapp_url: `https://wa.me/${phone}?text=${text}` });
    }
    return c.json({ error: 'invalid_request' }, 400);
  } catch (error) {
    console.error('POST /api/catalog/share error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});


// ══════════════════════════════════════════════════════════════
// MODULE 19 — AI WATCH ENGINE + ACTIVITY CENTER
// ══════════════════════════════════════════════════════════════

// ── Idempotency check ────────────────────────────────────────
async function alertAlreadyFired(orgId, convId, idKey, idValue, today) {
  try {
    const { data } = await supabase.from('messages').select('id')
      .eq('organisation_id', orgId).eq('conversation_id', convId)
      .filter(`metadata->>${idKey}`, 'eq', idValue)
      .filter('metadata->>alert_date', 'eq', today).maybeSingle();
    return !!data;
  } catch { return false; }
}

// ── Alert message insert helper ──────────────────────────────
async function insertAlert(orgId, convId, content, meta) {
  return supabase.from('messages').insert({
    organisation_id: orgId, conversation_id: convId, role: 'system', content,
    tokens_input: 0, tokens_output: 0,
    metadata: { sender_type: 'system', visibility: 'owner_only', message_type: 'system_alert', read_by_owner: false, preview_text: content.slice(0, 50), ...meta },
  });
}

// ── Get or create customer conversation ──────────────────────
async function getConvForCustomer(orgId, userId, customerId) {
  let { data: conv } = await supabase.from('conversations').select('id')
    .eq('organisation_id', orgId).eq('entity_type', 'customer').eq('entity_id', customerId).eq('status', 'active').maybeSingle();
  if (!conv) {
    const { data: newConv } = await supabase.from('conversations').insert({
      organisation_id: orgId, user_id: userId, entity_type: 'customer', entity_id: customerId, model: 'gpt-4o-mini', status: 'active',
    }).select('id').single();
    conv = newConv;
  }
  return conv?.id;
}

// ── Get global AI conversation ───────────────────────────────
async function getGlobalConv(orgId, userId) {
  let { data: conv } = await supabase.from('conversations').select('id')
    .eq('organisation_id', orgId).is('entity_type', null).eq('status', 'active').maybeSingle();
  if (!conv) {
    const { data: newConv } = await supabase.from('conversations').insert({
      organisation_id: orgId, user_id: userId, entity_type: null, model: 'gpt-4o-mini', status: 'active',
    }).select('id').single();
    conv = newConv;
  }
  return conv?.id;
}

// ── Job 1: Morning Briefing ─────────────────────────────────
async function jobMorningBriefing(orgId, userId) {
  const today = new Date().toISOString().split('T')[0];
  let fired = 0;
  const { data: tasks } = await supabase.from('tasks').select('id, title, entity_id, entity_type')
    .eq('organisation_id', orgId).eq('entity_type', 'delivery').eq('status', 'pending').eq('due_date', today).is('deleted_at', null);
  for (const task of (tasks || [])) {
    let custName = 'Customer'; let custId = null;
    if (task.entity_id) {
      const { data: inv } = await supabase.from('invoices').select('customer_id, invoice_number').eq('id', task.entity_id).maybeSingle();
      if (inv) {
        custId = inv.customer_id;
        const { data: cust } = await supabase.from('customers').select('name').eq('id', inv.customer_id).maybeSingle();
        custName = cust?.name || 'Customer';
        const convId = await getConvForCustomer(orgId, userId, inv.customer_id);
        if (convId && !(await alertAlreadyFired(orgId, convId, 'task_id', task.id, today))) {
          await insertAlert(orgId, convId, `🚚 Delivery due today — ${inv.invoice_number} for ${custName}. Mark done when delivered.`,
            { task_id: task.id, alert_type: 'delivery_due', alert_date: today });
          await supabase.from('entity_memory').upsert({ organisation_id: orgId, entity_type: 'customer', entity_id: inv.customer_id, memory_key: 'last_delivery_alert_date', memory_value: today, confidence: 1.0 },
            { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });
          fired++;
        }
      }
    }
  }
  return fired;
}

// ── Job 2: Payment Reminders ─────────────────────────────────
async function jobPaymentReminders(orgId, userId) {
  const today = new Date().toISOString().split('T')[0];
  let fired = 0;
  const { data: tasks } = await supabase.from('tasks').select('id, entity_id')
    .eq('organisation_id', orgId).eq('entity_type', 'reminder').eq('status', 'pending').eq('due_date', today).is('deleted_at', null);
  for (const task of (tasks || [])) {
    if (!task.entity_id) continue;
    const { data: inv } = await supabase.from('invoices').select('customer_id, invoice_number').eq('id', task.entity_id).maybeSingle();
    if (!inv) continue;
    const { data: cust } = await supabase.from('customers').select('name, outstanding_balance').eq('id', inv.customer_id).maybeSingle();
    const convId = await getConvForCustomer(orgId, userId, inv.customer_id);
    if (convId && !(await alertAlreadyFired(orgId, convId, 'task_id', task.id, today))) {
      const amt = (cust?.outstanding_balance || 0).toLocaleString('en-IN');
      await insertAlert(orgId, convId, `💰 Payment reminder — ${cust?.name || 'Customer'} owes ₹${amt}. Tap to send WhatsApp.`,
        { task_id: task.id, invoice_id: inv.id, alert_type: 'reminder_due', alert_date: today, customer_id: inv.customer_id });
      await supabase.from('entity_memory').upsert({ organisation_id: orgId, entity_type: 'customer', entity_id: inv.customer_id, memory_key: 'last_reminder_alert_date', memory_value: today, confidence: 1.0 },
        { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });
      fired++;
    }
  }
  return fired;
}

// ── Job 3: Overdue Escalation ────────────────────────────────
async function jobOverdueEscalation(orgId, userId) {
  const today = new Date().toISOString().split('T')[0];
  let fired = 0;
  const { data: invoices } = await supabase.from('invoices').select('id, invoice_number, total_amount, due_date, customer_id')
    .eq('organisation_id', orgId).eq('is_historical', false).not('status', 'in', '("paid","cancelled")').lt('due_date', today).is('deleted_at', null);
  for (const inv of (invoices || [])) {
    const { data: cust } = await supabase.from('customers').select('name').eq('id', inv.customer_id).maybeSingle();
    const convId = await getConvForCustomer(orgId, userId, inv.customer_id);
    if (convId && !(await alertAlreadyFired(orgId, convId, 'invoice_id', inv.id, today))) {
      const days = Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000);
      const amt = (inv.total_amount || 0).toLocaleString('en-IN');
      await insertAlert(orgId, convId, `⚠️ Invoice ${inv.invoice_number} overdue by ${days} day${days > 1 ? 's' : ''} — ${cust?.name || 'Customer'} owes ₹${amt}.`,
        { invoice_id: inv.id, alert_type: 'overdue_invoice', alert_date: today, customer_id: inv.customer_id });
      fired++;
    }
  }
  return fired;
}

// ── Job 4: Bank Reconciliation ───────────────────────────────
async function jobBankReconciliation(orgId, userId) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: txns } = await supabase.from('bank_transactions').select('amount')
      .eq('organisation_id', orgId).eq('reconciled', false).is('deleted_at', null);
    if (!txns || txns.length === 0) return 0;
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0).toLocaleString('en-IN');
    const convId = await getGlobalConv(orgId, userId);
    if (convId && !(await alertAlreadyFired(orgId, convId, 'alert_type', 'bank_reconciliation', today))) {
      await insertAlert(orgId, convId, `🏦 ${txns.length} bank transaction${txns.length > 1 ? 's' : ''} need reconciliation — ₹${total} unreconciled today.`,
        { alert_type: 'bank_reconciliation', alert_date: today });
      return 1;
    }
  } catch {}
  return 0;
}

// ── Job 5: Daily Insight Regeneration ────────────────────────
async function jobDailyInsight(orgId) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: custs } = await supabase.from('customers').select('outstanding_balance').eq('organisation_id', orgId);
    const totalOutstanding = (custs || []).reduce((s, c) => s + (c.outstanding_balance || 0), 0);
    const { count: overdueCount } = await supabase.from('invoices').select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId).not('status', 'in', '("paid","cancelled")').lt('due_date', today);
    const { count: paidToday } = await supabase.from('invoices').select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId).eq('status', 'paid').gte('updated_at', today + 'T00:00:00');
    const { count: pendingDeliveries } = await supabase.from('tasks').select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId).eq('entity_type', 'delivery').eq('status', 'pending').gte('due_date', today);

    const context = `Outstanding: ₹${totalOutstanding.toLocaleString('en-IN')}. Overdue invoices: ${overdueCount || 0}. Paid today: ${paidToday || 0}. Pending deliveries: ${pendingDeliveries || 0}.`;

    let insightText = `Focus on collecting ₹${totalOutstanding.toLocaleString('en-IN')} outstanding across ${(custs || []).length} customers.`;

    const client = getOpenAI();
    if (client) {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 6000);
        const comp = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Generate one actionable insight sentence (max 15 words) for an Indian MSME trader. Use ₹ and Indian formatting. Plain text only.' },
            { role: 'user', content: context },
          ],
          temperature: 0.3,
        }, { signal: controller.signal });
        clearTimeout(tid);
        insightText = comp.choices[0].message.content?.trim() || insightText;
      } catch {}
    }

    await supabase.from('ai_context').upsert({
      organisation_id: orgId, context_key: 'daily_insight',
      context_value: JSON.stringify({ content: insightText, generated_at: new Date().toISOString() }),
      scope: 'global', is_active: true,
    }, { onConflict: 'organisation_id,context_key,scope' });

    return true;
  } catch { return false; }
}

// ── Job 6: Draft Cleanup ─────────────────────────────────────
async function jobDraftCleanup(orgId) {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    const { data: stale } = await supabase.from('ai_actions').select('id')
      .eq('organisation_id', orgId).eq('status', 'pending').lt('created_at', fiveMinAgo).is('deleted_at', null);
    let count = 0;
    for (const action of (stale || [])) {
      await supabase.from('ai_actions').update({ status: 'rejected' }).eq('id', action.id);
      count++;
    }
    return count;
  } catch { return 0; }
}

// ─── POST /api/watch/trigger ─────────────────────────────────
app.post('/api/watch/trigger', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const body = await c.req.json().catch(() => ({}));
    const jobType = body.job_type || 'all';

    let alertsFired = 0;
    let tasksUpdated = 0;
    let insightUpdated = false;

    if (jobType === 'all' || jobType === 'morning_briefing') {
      alertsFired += await jobMorningBriefing(organisationId, userId);
    }
    if (jobType === 'all' || jobType === 'payment_reminders') {
      alertsFired += await jobPaymentReminders(organisationId, userId);
    }
    if (jobType === 'all' || jobType === 'overdue_escalation') {
      alertsFired += await jobOverdueEscalation(organisationId, userId);
    }
    if (jobType === 'all' || jobType === 'bank_reconciliation') {
      alertsFired += await jobBankReconciliation(organisationId, userId);
    }
    if (jobType === 'all' || jobType === 'daily_insight') {
      insightUpdated = await jobDailyInsight(organisationId);
    }
    if (jobType === 'all' || jobType === 'draft_cleanup') {
      tasksUpdated = await jobDraftCleanup(organisationId);
    }

    console.log(`🔔 Watch trigger: ${alertsFired} alerts, ${tasksUpdated} drafts cleaned, insight=${insightUpdated}`);
    return c.json({ alerts_fired: alertsFired, tasks_updated: tasksUpdated, insight_updated: insightUpdated });
  } catch (error) {
    console.error('POST /api/watch/trigger error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── GET /api/activity ───────────────────────────────────────
app.get('/api/activity', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { userId, organisationId } = auth;
    const tab = c.req.query('tab') || 'watchlist';

    if (tab === 'watchlist') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: alerts } = await supabase.from('messages').select('id, content, metadata, created_at, conversation_id')
        .eq('organisation_id', organisationId).eq('role', 'system').gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: false }).limit(50);

      const items = [];
      for (const alert of (alerts || [])) {
        const meta = alert.metadata || {};
        let custName = null, custId = meta.customer_id || null, custPhone = null;
        if (custId) {
          const { data: cust } = await supabase.from('customers').select('name, phone').eq('id', custId).maybeSingle();
          custName = cust?.name; custPhone = cust?.phone;
        } else {
          // Try to get customer from conversation
          const { data: conv } = await supabase.from('conversations').select('entity_id, entity_type').eq('id', alert.conversation_id).maybeSingle();
          if (conv?.entity_type === 'customer' && conv.entity_id) {
            custId = conv.entity_id;
            const { data: cust } = await supabase.from('customers').select('name, phone').eq('id', conv.entity_id).maybeSingle();
            custName = cust?.name; custPhone = cust?.phone;
          }
        }
        items.push({
          id: alert.id, type: meta.alert_type || 'system', content: alert.content,
          customer_name: custName, customer_id: custId, customer_phone: custPhone,
          alert_date: meta.alert_date || alert.created_at?.split('T')[0],
          is_silenced: meta.silenced || false,
          task_id: meta.task_id || null, invoice_id: meta.invoice_id || null,
          created_at: alert.created_at,
        });
      }
      return c.json({ items });

    } else {
      // My Tasks
      const { data: tasks } = await supabase.from('tasks').select('id, title, description, status, priority, due_date, entity_type, entity_id, created_at')
        .eq('organisation_id', organisationId).is('deleted_at', null)
        .or(`created_by.eq.${userId},assigned_to.eq.${userId}`)
        .order('due_date', { ascending: true }).limit(50);

      const items = [];
      for (const task of (tasks || [])) {
        let custName = null, custId = null, custPhone = null;
        if (task.entity_id && (task.entity_type === 'delivery' || task.entity_type === 'reminder')) {
          const { data: inv } = await supabase.from('invoices').select('customer_id').eq('id', task.entity_id).maybeSingle();
          if (inv?.customer_id) {
            custId = inv.customer_id;
            const { data: cust } = await supabase.from('customers').select('name, phone').eq('id', inv.customer_id).maybeSingle();
            custName = cust?.name; custPhone = cust?.phone;
          }
        }
        items.push({
          id: task.id, title: task.title, description: task.description,
          status: task.status, priority: task.priority, due_date: task.due_date,
          entity_type: task.entity_type, entity_id: task.entity_id,
          customer_name: custName, customer_id: custId, customer_phone: custPhone,
          created_at: task.created_at,
        });
      }
      return c.json({ items });
    }
  } catch (error) {
    console.error('GET /api/activity error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── PATCH /api/tasks/:task_id ───────────────────────────────
app.patch('/api/tasks/:task_id', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const taskId = c.req.param('task_id');
    const body = await c.req.json();

    const updateFields = {};
    if (body.status) updateFields.status = body.status;
    if (body.status === 'completed') updateFields.completed_at = new Date().toISOString();
    updateFields.updated_at = new Date().toISOString();

    const { error } = await supabase.from('tasks').update(updateFields)
      .eq('id', taskId).eq('organisation_id', auth.organisationId);
    if (error) return c.json({ error: 'server_error' }, 500);

    // Write entity_memory if completed
    if (body.status === 'completed') {
      const { data: task } = await supabase.from('tasks').select('entity_id, entity_type, due_date').eq('id', taskId).single();
      if (task?.entity_id) {
        const { data: inv } = await supabase.from('invoices').select('customer_id').eq('id', task.entity_id).maybeSingle();
        if (inv?.customer_id) {
          const today = new Date().toISOString().split('T')[0];
          const onTime = task.due_date ? task.due_date >= today : true;
          try {
            await supabase.from('entity_memory').upsert({
              organisation_id: auth.organisationId, entity_type: 'customer', entity_id: inv.customer_id,
              memory_key: 'task_completed_on_time', memory_value: onTime ? 'true' : 'false', confidence: 1.0,
            }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });
          } catch {}
        }
      }
    }

    return c.json({ updated: true });
  } catch (error) {
    return c.json({ error: 'server_error' }, 500);
  }
});


// Export supabase client for use in other modules
export { supabase };

// Register AI routes (Flow 2B)
if (supabase) {
  registerAIRoutes(app, supabase);
  registerOrgAiRoutes(app, supabase, authenticateChat, getOpenAI);
  registerSupplierRoutes(app, supabase, authenticateChat);
  console.log('✅ AI routes registered');
}

// Start server
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
console.log(`🚀 Backend server running on http://0.0.0.0:${port}`);

serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0',
});
