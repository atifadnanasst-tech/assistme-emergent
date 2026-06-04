/**
 * AssistMe — Customer Selector (Shared Helper)
 *
 * Location: /backend/src/services/capabilities/customerSelector.js
 * Created: Session II, Jun 2026
 *
 * PURPOSE: Single source of truth for resolving planner customer params → DB customer record.
 *          Used by paymentCapabilities.js and future customer mutation capabilities.
 *
 * THIS FUNCTION IS READ ONLY. It never writes to DB.
 *
 * SCHEMA NOTE:
 *   customers table uses status='active' (not is_active boolean).
 *   outstanding_balance is a physical column (numeric 18,2).
 *
 * Future: fuzzy customer name matching (trigram similarity) deferred to later session.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveCustomerSelector({ selector = {}, orgId, supabase }) {
  if (!orgId) return { customer: null, candidates: [], error: 'org_id required' };
  if (!supabase) return { customer: null, candidates: [], error: 'supabase client not provided' };

  const baseSelect = 'id, name, phone, outstanding_balance, currency, payment_terms_days, custom_fields';

  // Priority 1: exact UUID
  if (selector.customer_id && UUID_PATTERN.test(String(selector.customer_id))) {
    const { data, error } = await supabase
      .from('customers')
      .select(baseSelect)
      .eq('organisation_id', orgId)
      .eq('id', selector.customer_id)
      .eq('status', 'active')
      .is('deleted_at', null)
      .maybeSingle();

    if (error) return { customer: null, candidates: [], error: error.message };
    return { customer: data || null, candidates: [], error: null };
  }

  // Priority 2: name resolution (exact first, then partial)
  const searchName = selector.name || selector.customer_name;
  if (searchName) {
    // Step 1: exact case-insensitive match (no wildcards)
    // Use array return — maybeSingle() fails if duplicate names exist in real MSME data
    const { data: exactMatches, error: exactErr } = await supabase
      .from('customers')
      .select(baseSelect)
      .eq('organisation_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .ilike('name', searchName);

    if (exactErr) return { customer: null, candidates: [], error: exactErr.message };
    if (exactMatches?.length === 1) return { customer: exactMatches[0], candidates: [], error: null };
    if (exactMatches?.length > 1) return { customer: null, candidates: exactMatches, error: null };

    // Step 2: partial ILIKE search
    // Future: add trigram fuzzy match here before returning candidates
    const { data: partialMatches, error: partialErr } = await supabase
      .from('customers')
      .select(baseSelect)
      .eq('organisation_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .ilike('name', `%${searchName}%`)
      .order('name', { ascending: true });

    if (partialErr) return { customer: null, candidates: [], error: partialErr.message };

    const results = partialMatches || [];
    if (results.length === 0) return { customer: null, candidates: [], error: null };
    if (results.length === 1) return { customer: results[0], candidates: [], error: null };

    return { customer: null, candidates: results, error: null };
  }

  // Priority 3: phone
  if (selector.phone) {
    const { data, error } = await supabase
      .from('customers')
      .select(baseSelect)
      .eq('organisation_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .eq('phone', selector.phone)
      .maybeSingle();

    if (error) return { customer: null, candidates: [], error: error.message };
    return { customer: data || null, candidates: [], error: null };
  }

  return { customer: null, candidates: [], error: 'no_selector: specify name, customer_id, or phone' };
}
