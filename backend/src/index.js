import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerAIRoutes, getOpenAI } from './ai-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: '/app/backend/.env' });

// Initialize Supabase client with service role key (backend only)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (!supabaseUrl || !supabaseServiceKey || supabaseUrl.includes('your_supabase')) {
  console.warn('⚠️  Supabase credentials not configured. Some features will be unavailable.');
  console.warn('⚠️  Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in /app/backend/.env');
} else {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
  console.log('✅ Supabase client initialized');
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
    const phone = userData.user.phone;

    if (!phone) {
      return c.json({ error: 'setup_failed', message: 'Phone number not found in token' }, 500);
    }

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
          // Rollback: delete the organisation
          await supabase.from('organisations').delete().eq('id', organisationId);
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
          .insert(tagsToInsert)
          .onConflict('organisation_id, name')
          .ignoreDuplicates();

        if (tagsError) {
          // Rollback: delete user and organisation
          await supabase.from('users').delete().eq('id', userId);
          await supabase.from('organisations').delete().eq('id', organisationId);
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
    try {
      const { data: orgRecord } = await supabase
        .from('organisations')
        .select('subscription_plan')
        .eq('id', organisationId)
        .single();
      if (orgRecord) {
        subscriptionPlan = orgRecord.subscription_plan || 'free';
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
            // Unread = read_by_owner is absent, null, false, or string "false"
            return rbo !== true && rbo !== 'true';
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
      language: language,
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
    .from('users').select('id, organisation_id').eq('auth_id', userData.user.id).single();
  if (!userRecord) return null;
  return { userId: userRecord.id, organisationId: userRecord.organisation_id };
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
    if (conversation?.id) {
      const { data: msgData, error: msgErr } = await supabase
        .from('messages')
        .select('id, role, content, metadata, created_at')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .limit(50);

      if (!msgErr && msgData) {
        messages = msgData.map(m => ({
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
        }));
      }

      // 4. Mark unread messages as read using jsonb_set
      try {
        const { data: unreadMsgs } = await supabase
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .eq('metadata->>read_by_owner', 'false');

        if (unreadMsgs && unreadMsgs.length > 0) {
          const unreadIds = unreadMsgs.map(m => m.id);
          await supabase.rpc('exec_sql', {
            query: `UPDATE messages SET metadata = jsonb_set(metadata, '{read_by_owner}', 'true') WHERE id = ANY($1)`,
            params: [unreadIds],
          }).catch(async () => {
            // RPC may not exist — fall back to per-row update
            for (const msg of unreadMsgs) {
              await supabase
                .from('messages')
                .update({ metadata: supabase.rpc ? undefined : undefined })
                .eq('id', msg.id);
            }
          });
          // Reliable fallback: individual updates using Supabase client
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
        health_score: healthScore,
        status: customer.status || 'active',
      },
      messages,
    });

  } catch (error) {
    console.error('GET /api/chat error:', error);
    return c.json({ error: 'server_error' }, 500);
  }
});

// ─── POST /api/chat/:customer_id/message ───────────────────
app.post('/api/chat/:customer_id/message', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const customerId = c.req.param('customer_id');

    const customer = await validateCustomer(customerId, organisationId);
    if (!customer) return c.json({ error: 'customer_not_found' }, 404);

    const body = await c.req.json();
    const content = body.content?.trim();
    const conversationId = body.conversation_id;

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

    const previewText = content.length > 50 ? content.substring(0, 50) + '...' : content;

    const { data: savedMsg, error: saveErr } = await supabase
      .from('messages')
      .insert({
        organisation_id: organisationId,
        conversation_id: conversationId,
        role: 'assistant',
        content,
        metadata: {
          sender_type: 'owner',
          visibility: 'both',
          message_type: 'text',
          read_by_owner: true,
          preview_text: previewText,
        },
        tokens_input: 0,
        tokens_output: 0,
      })
      .select('id, created_at')
      .single();

    if (saveErr) {
      console.error('Save owner message error:', saveErr);
      return c.json({ error: 'server_error' }, 500);
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


// ══════════════════════════════════════════════════════════════
// FLOW 3A — AI SPARK ROUTES
// ══════════════════════════════════════════════════════════════

const SPARK_SYSTEM_PROMPT = `You are an action extraction assistant for an Indian MSME trader.
The customer is already identified from context — do not ask who.
Available data: customers(id, name, phone, outstanding_balance),
products(id, name, sku, selling_price), invoices(id, status, total_amount),
tasks(id, entity_id, entity_type, due_date)

Extract the owner's intent and output ONLY this JSON — no other text:
{
  "intent": "create_invoice | schedule_delivery | set_reminder | record_payment | query | ambiguous",
  "confidence_score": 0.0,
  "entities": {
    "product_name": "string or null",
    "quantity": null,
    "amount": null,
    "due_date": "string or null",
    "delivery_date": "string or null"
  },
  "reasoning": "one sentence explaining confidence score"
}
If intent is unclear → output ambiguous with confidence_score < 0.50.
No markdown. No preamble. JSON only.`;

const FINANCIAL_INTENTS = ['create_invoice', 'record_payment', 'set_reminder'];
const ALLOWED_INTENTS = ['create_invoice', 'schedule_delivery', 'set_reminder', 'record_payment', 'query', 'ambiguous'];

function parseSparkResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { intent: 'ambiguous', confidence_score: 0.0, entities: {}, reasoning: 'Could not parse response' };
    const parsed = JSON.parse(jsonMatch[0]);
    let intent = parsed.intent || 'ambiguous';
    if (!ALLOWED_INTENTS.includes(intent)) intent = 'ambiguous';
    let confidence = parseFloat(parsed.confidence_score) || 0.0;
    if (confidence < 0 || confidence > 1) confidence = 0.0;
    return {
      intent,
      confidence_score: confidence,
      entities: (typeof parsed.entities === 'object' && parsed.entities) ? parsed.entities : {},
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return { intent: 'ambiguous', confidence_score: 0.0, entities: {}, reasoning: 'Parse error' };
  }
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
    const query = body.query?.trim();
    const conversationId = body.conversation_id;
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
    const userMessage = `Customer: ${customer.name}\nOwner instruction: ${query}\nRecent context: ${recentText}\nCustomer memory: ${customerMemory || 'none'}`;
    const systemContent = SPARK_SYSTEM_PROMPT + (globalContext ? `\n\nBusiness context:\n${globalContext}` : '');

    const client = getOpenAI();
    if (!client) return c.json({ error: 'ai_error', message: 'AI not configured' }, 500);

    let tokensInput = 0, tokensOutput = 0;
    let parsed = { intent: 'ambiguous', confidence_score: 0.0, entities: {}, reasoning: '' };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

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

    // Product resolution if product_name is present
    let resolvedProduct = null;
    if (parsed.entities.product_name) {
      const { data: products } = await supabase
        .from('products').select('id, name, selling_price')
        .eq('organisation_id', organisationId)
        .ilike('name', `%${parsed.entities.product_name}%`).limit(5);
      if (products?.length === 1) {
        resolvedProduct = products[0];
        parsed.confidence_score = Math.min(1.0, parsed.confidence_score + 0.2);
      } else if (products?.length > 1) {
        // Multiple — reduce confidence
        parsed.confidence_score = Math.max(0, parsed.confidence_score - 0.15);
      } else {
        parsed.confidence_score = Math.max(0, parsed.confidence_score - 0.3);
      }
    }

    // Compute amount if not provided
    let amount = parsed.entities.amount;
    if (!amount && resolvedProduct && parsed.entities.quantity) {
      amount = resolvedProduct.selling_price * parsed.entities.quantity;
    }

    // Confidence routing
    const isFinancial = FINANCIAL_INTENTS.includes(parsed.intent);
    let routing = 'preview'; // default
    if (parsed.intent === 'ambiguous' || parsed.confidence_score < 0.50) {
      routing = 'clarify';
    } else if (parsed.confidence_score > 0.85 && !isFinancial) {
      routing = 'auto_confirm';
    }

    // If clarifying, send AI question in chat and return
    if (routing === 'clarify') {
      const clarifyContent = parsed.reasoning || "I'm not sure what you'd like me to do. Could you be more specific?";
      await supabase.from('messages').insert({
        organisation_id: organisationId, conversation_id: conversationId,
        role: 'assistant', content: clarifyContent,
        metadata: {
          sender_type: 'ai', visibility: 'both', message_type: 'text',
          read_by_owner: true, preview_text: clarifyContent.substring(0, 50),
          ai_raw_response: JSON.stringify(parsed),
        },
        tokens_input: 0, tokens_output: 0,
      });
      return c.json({
        routing: 'clarify',
        message: clarifyContent,
        confidence_score: parsed.confidence_score,
        actions: [],
      });
    }

    // Build action parameters
    const actionParams = {
      customer_id: customerId,
      customer_name: customer.name,
      product_name: resolvedProduct?.name || parsed.entities.product_name || null,
      product_id: resolvedProduct?.id || null,
      quantity: parsed.entities.quantity || null,
      amount: amount || null,
      unit_price: resolvedProduct?.selling_price || null,
      due_date: parsed.entities.due_date || null,
      delivery_date: parsed.entities.delivery_date || null,
    };

    // Save draft to ai_actions
    const { data: savedAction, error: actionErr } = await supabase
      .from('ai_actions')
      .insert({
        organisation_id: organisationId,
        action_name: `${parsed.intent.replace(/_/g, ' ')} for ${customer.name}`,
        action_type: parsed.intent,
        prompt_template: query,
        parameters: actionParams,
        confidence_score: parsed.confidence_score,
        status: routing === 'auto_confirm' ? 'approved' : 'pending',
      })
      .select('id')
      .single();

    if (actionErr) {
      console.error('Save ai_action failed:', actionErr);
      return c.json({ error: 'server_error' }, 500);
    }

    // Get entity_memory insight for preview
    let aiInsight = null;
    try {
      const { data: insights } = await supabase
        .from('entity_memory').select('memory_key, memory_value')
        .eq('organisation_id', organisationId).eq('entity_type', 'customer')
        .eq('entity_id', customerId).is('deleted_at', null).limit(3);
      if (insights?.length > 0) {
        aiInsight = insights.map(i => `${i.memory_key}: ${i.memory_value}`).join('. ');
      }
    } catch {}

    // Build details string
    let details = '';
    if (actionParams.quantity && actionParams.product_name) {
      details += `${actionParams.quantity} × ${actionParams.product_name}`;
    }
    if (actionParams.amount) details += ` · Amount: ₹${actionParams.amount.toLocaleString('en-IN')}`;
    if (actionParams.due_date) details += ` · Due: ${actionParams.due_date}`;
    if (actionParams.delivery_date) details += ` · Delivery: ${actionParams.delivery_date}`;

    return c.json({
      draft_id: savedAction.id,
      confidence_score: parsed.confidence_score,
      routing,
      actions: [{
        action_id: savedAction.id,
        action_type: parsed.intent,
        details: details || `${parsed.intent} for ${customer.name}`,
        parameters: actionParams,
        editable: true,
      }],
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
            const invoiceNumber = ((invCount || 0) + 1).toString();

            const subtotal = params.amount || 0;
            const taxAmount = 0;
            const totalAmount = subtotal + taxAmount;

            const { data: newInvoice, error: invErr } = await supabase
              .from('invoices').insert({
                organisation_id: organisationId,
                customer_id: customerId,
                invoice_number: invoiceNumber,
                status: 'sent',
                issue_date: new Date().toISOString().split('T')[0],
                due_date: params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                currency: 'INR',
                subtotal, tax_amount: taxAmount, total_amount: totalAmount,
                amount_due: totalAmount, amount_paid: 0,
              }).select('id').single();

            if (invErr) { console.error('Create invoice failed:', invErr); failed.push(actionId); continue; }

            // Insert invoice items
            if (params.product_name) {
              await supabase.from('invoice_items').insert({
                organisation_id: organisationId,
                invoice_id: newInvoice.id,
                description: params.product_name,
                quantity: params.quantity || 1,
                unit_price: params.unit_price || params.amount || 0,
                tax_rate: 0,
                line_total: subtotal,
                sort_order: 1,
              });
            }

            // Insert invoice card message in chat
            const { data: conv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();

            if (conv) {
              const itemsSummary = params.product_name
                ? `${params.product_name} × ${params.quantity || 1}`
                : 'Items';

              await supabase.from('messages').insert({
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
                    total_amount: totalAmount,
                    due_date: params.due_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                    status: 'sent',
                    items_summary: itemsSummary,
                  },
                },
                tokens_input: 0, tokens_output: 0,
              });
            }

            // Update customer outstanding balance
            await supabase.from('customers')
              .update({ outstanding_balance: (customer.outstanding_balance || 0) + totalAmount })
              .eq('id', customerId).eq('organisation_id', organisationId);

            executed.push(actionId);
            break;
          }

          case 'schedule_delivery': {
            await supabase.from('tasks').insert({
              organisation_id: organisationId,
              title: `Delivery for ${customer.name}`,
              description: params.product_name ? `Deliver ${params.quantity || ''} ${params.product_name}` : 'Scheduled delivery',
              status: 'pending',
              priority: 'medium',
              created_by: userId,
              due_date: params.delivery_date || params.due_date || new Date(Date.now() + 86400000).toISOString().split('T')[0],
              entity_type: 'delivery',
              entity_id: customerId,
            });
            executed.push(actionId);
            break;
          }

          case 'set_reminder': {
            // Build wa.me reminder link
            const phone = (customer.phone || '').replace(/[^0-9]/g, '');
            if (phone) {
              const text = encodeURIComponent(
                `Hi ${customer.name}, this is a reminder about your pending payment. Please arrange at your earliest convenience.`
              );
              // Save reminder message to chat
              const { data: conv } = await supabase
                .from('conversations').select('id')
                .eq('organisation_id', organisationId).eq('entity_type', 'customer')
                .eq('entity_id', customerId).eq('status', 'active').maybeSingle();
              if (conv) {
                await supabase.from('messages').insert({
                  organisation_id: organisationId, conversation_id: conv.id,
                  role: 'assistant', content: `Payment reminder scheduled for ${customer.name}`,
                  metadata: {
                    sender_type: 'ai', visibility: 'both', message_type: 'text',
                    read_by_owner: true, preview_text: `Reminder scheduled for ${customer.name}`,
                    ai_raw_response: JSON.stringify(params),
                  },
                  tokens_input: 0, tokens_output: 0,
                });
              }
            }
            executed.push(actionId);
            break;
          }

          case 'record_payment': {
            if (params.amount && params.amount > 0) {
              // Find latest unpaid invoice for this customer
              const { data: inv } = await supabase
                .from('invoices').select('id, total_amount, amount_paid')
                .eq('organisation_id', organisationId).eq('customer_id', customerId)
                .neq('status', 'paid').order('created_at', { ascending: false }).limit(1).maybeSingle();
              if (inv) {
                const newPaid = (inv.amount_paid || 0) + params.amount;
                const newStatus = newPaid >= (inv.total_amount || 0) ? 'paid' : 'partial';
                await supabase.from('invoices').update({ amount_paid: newPaid, status: newStatus })
                  .eq('id', inv.id).eq('organisation_id', organisationId);
                const newBalance = Math.max(0, (customer.outstanding_balance || 0) - params.amount);
                await supabase.from('customers').update({ outstanding_balance: newBalance })
                  .eq('id', customerId).eq('organisation_id', organisationId);
                // entity_memory
                try {
                  await supabase.from('entity_memory').insert({
                    organisation_id: organisationId, entity_type: 'customer', entity_id: customerId,
                    memory_key: 'last_payment_amount', memory_value: params.amount.toString(), confidence: 1.0,
                  });
                } catch {}
              }
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
    const draftId = c.req.param('draft_id');

    const { error: updateErr } = await supabase
      .from('ai_actions').update({ status: 'rejected' })
      .eq('id', draftId).eq('organisation_id', auth.organisationId);
    if (updateErr) return c.json({ error: 'server_error' }, 500);

    return c.json({ cancelled: true });

  } catch (error) {
    console.error('DELETE /api/chat/spark error:', error);
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


// Export supabase client for use in other modules
export { supabase };

// Register AI routes (Flow 2B)
if (supabase) {
  registerAIRoutes(app, supabase);
  console.log('✅ AI routes registered');
}

// Start server
const port = 8001;
console.log(`🚀 Backend server running on http://0.0.0.0:${port}`);

serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0',
});
