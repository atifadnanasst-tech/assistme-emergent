import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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


// Export supabase client for use in other modules
export { supabase };

// Start server
const port = 8001;
console.log(`🚀 Backend server running on http://0.0.0.0:${port}`);

serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0',
});
