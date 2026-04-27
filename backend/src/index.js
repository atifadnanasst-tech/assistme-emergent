import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerAIRoutes, getOpenAI } from './ai-routes.js';
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
        .is('deleted_at', null)
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
    const { organisationId, userId } = auth;
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
          .select('id, organisation_id, phone')
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
              .select('id, phone')
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
                    sender_type: 'customer',
                    message_type: 'text',
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
      "action_type": "create_invoice | schedule_delivery | set_reminder | record_payment",
      "entities": {
        "items": [{"product_name": "string", "quantity": number}],
        "amount": number or null,
        "due_date": "YYYY-MM-DD or null",
        "delivery_date": "YYYY-MM-DD or null"
      }
    }
  ],
  "confidence_score": 0.0 to 1.0,
  "reasoning": "one sentence"
}
Rules:
- create_invoice: put ALL products inside entities.items array as one action (never split into multiple create_invoice)
- schedule_delivery: one action, set delivery_date
- set_reminder: one action, set due_date
- record_payment: one action, set amount
- Resolve relative dates: "tomorrow"/"kal" = next day, "7 din baad" = +7 days from today
- If intent is truly unclear, return empty actions array with confidence_score < 0.50
- No markdown. No preamble. JSON only.`;

const FINANCIAL_INTENTS = ['create_invoice', 'record_payment', 'set_reminder'];
const ALLOWED_INTENTS = ['create_invoice', 'schedule_delivery', 'set_reminder', 'record_payment', 'query', 'ambiguous'];

function parseSparkResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { actions: [], confidence_score: 0.0, reasoning: 'Could not parse response' };
    const parsed = JSON.parse(jsonMatch[0]);

    // Handle new multi-action format
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

    // Fallback: old single-intent format
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

    // Product resolution: resolve each product name from the DB
    // Build a map of product_name → { resolved, alternatives }
    async function resolveProduct(productName) {
      if (!productName) return { resolved: null, alternatives: [] };
      const { data: products } = await supabase
        .from('products').select('id, name, selling_price, sku')
        .eq('organisation_id', organisationId).eq('is_active', true)
        .ilike('name', `%${productName}%`).limit(5);
      if (!products || products.length === 0) return { resolved: null, alternatives: [] };
      return { resolved: products[0], alternatives: products.length > 1 ? products : [] };
    }

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

      if (action.action_type === 'create_invoice') {
        // Handle items[] array for invoice
        const items = Array.isArray(ent.items) ? ent.items : (ent.product_name ? [{ product_name: ent.product_name, quantity: ent.quantity }] : []);
        const resolvedItems = [];
        let totalAmount = 0;

        for (const item of items) {
          const { resolved, alternatives } = await resolveProduct(item.product_name);
          const unitPrice = resolved?.selling_price || null;
          const qty = item.quantity || 1;
          const lineTotal = unitPrice ? unitPrice * qty : null;
          if (lineTotal) totalAmount += lineTotal;

          resolvedItems.push({
            product_name: resolved?.name || item.product_name,
            product_id: resolved?.id || null,
            quantity: qty,
            unit_price: unitPrice,
            line_total: lineTotal,
            alternatives: alternatives.map(a => ({ id: a.id, name: a.name, selling_price: a.selling_price })),
          });
        }

        const actionParams = {
          customer_id: customerId,
          customer_name: customer.name,
          items: resolvedItems,
          amount: ent.amount || totalAmount || null,
          due_date: ent.due_date || null,
          delivery_date: ent.delivery_date || null,
        };

        const { data: savedAction, error: actionErr } = await supabase
          .from('ai_actions').insert({
            organisation_id: organisationId,
            action_name: `create invoice for ${customer.name}`,
            action_type: 'create_invoice',
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
          action_type: 'create_invoice',
          details: itemLines.join('\n') + (totalStr ? `\nTotal: ${totalStr}` : '') + (ent.due_date ? `\nDue: ${ent.due_date}` : ''),
          parameters: actionParams,
          items: resolvedItems,
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
            const invoiceNumber = ((invCount || 0) + 1).toString();

            const itemsArr = Array.isArray(params.items) ? params.items : [];
            const subtotal = params.amount || itemsArr.reduce((s, i) => s + (i.line_total || (i.quantity || 1) * (i.unit_price || 0)), 0) || 0;
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

            // Insert invoice items — handle items[] array or legacy single product
            if (itemsArr.length > 0) {
              for (let idx = 0; idx < itemsArr.length; idx++) {
                const item = itemsArr[idx];
                await supabase.from('invoice_items').insert({
                  organisation_id: organisationId,
                  invoice_id: newInvoice.id,
                  description: item.product_name || 'Item',
                  quantity: item.quantity || 1,
                  unit_price: item.unit_price || 0,
                  tax_rate: 0,
                  line_total: item.line_total || (item.quantity || 1) * (item.unit_price || 0),
                  sort_order: idx + 1,
                });
              }
            } else if (params.product_name) {
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

            // Build items summary for card
            const itemsSummary = itemsArr.length > 0
              ? itemsArr.map(i => `${i.product_name} × ${i.quantity || 1}`).join(', ')
              : params.product_name ? `${params.product_name} × ${params.quantity || 1}` : 'Items';

            // Insert invoice card message in chat (visible to customer)
            const { data: conv } = await supabase
              .from('conversations').select('id')
              .eq('organisation_id', organisationId).eq('entity_type', 'customer')
              .eq('entity_id', customerId).eq('status', 'active').maybeSingle();

            if (conv) {
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
      let q = supabase.from('invoices').select('invoice_number, status, total_amount, amount_paid, amount_due, issue_date, due_date')
        .eq('organisation_id', organisationId).eq('customer_id', customerId).order('issue_date', { ascending: false }).limit(20);
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
        .eq('organisation_id', organisationId).eq('customer_id', customerId).gte('issue_date', since.toISOString().split('T')[0]);
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

app.post('/api/chat/:customer_id/ai-query', async (c) => {
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

    // Get owner's preferred language
    const { data: orgData } = await supabase.from('organisations').select('custom_fields').eq('id', organisationId).single();
    const language = orgData?.custom_fields?.language || 'English';

    // Save owner's query as owner-only message
    await supabase.from('messages').insert({
      organisation_id: organisationId, conversation_id: conversationId,
      role: 'user', content: query,
      metadata: { sender_type: 'owner', visibility: 'owner_only', message_type: 'ai_query', read_by_owner: true, preview_text: query.substring(0, 50) },
      tokens_input: 0, tokens_output: 0,
    });

    const client = getOpenAI();
    if (!client) return c.json({ error: 'ai_error', message: 'AI not configured' }, 500);

    const systemPrompt = `You are a data assistant for an Indian MSME trader. You answer questions about customer "${customer.name}".
RULES:
- ALWAYS call a tool first. NEVER guess financial data.
- After receiving tool results, write a plain-language answer using ONLY the returned data.
- Amounts in INR (₹), Indian format: ₹1,20,000.
- Never invent numbers. If data is empty, say "No records found."
- Respond in ${language}. Be concise and actionable.
- Today's date: ${new Date().toISOString().split('T')[0]}`;

    let messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
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
      const t2 = setTimeout(() => controller2.abort(), 10000);
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

    // Save AI response as owner-only message
    const { data: savedMsg } = await supabase.from('messages').insert({
      organisation_id: organisationId, conversation_id: conversationId,
      role: 'assistant', content: responseText,
      metadata: { sender_type: 'ai', visibility: 'owner_only', message_type: 'ai_response', read_by_owner: true, preview_text: responseText.substring(0, 50) },
      tokens_input: 0, tokens_output: 0,
    }).select('id').single();

    return c.json({ message_id: savedMsg?.id, response: responseText });

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
    const fileName = `${invoice.invoice_number}.pdf`;
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
    const { organisationId } = auth;
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
      }).select('id').single();
      
      if (msgErr) {
        console.error(`📱 [SHARE] Message insert error:`, msgErr);
        return c.json({ shared: false, error: msgErr.message }, 500);
      }
      
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
    .eq('organisation_id', orgId).not('status', 'in', '("paid","cancelled")').lt('due_date', today).is('deleted_at', null);
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
