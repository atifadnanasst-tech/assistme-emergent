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
    const { data: partialMatches, error: partialErr } = await supabase
      .from('customers')
      .select(baseSelect)
      .eq('organisation_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .ilike('name', `%${searchName}%`)
      .order('name', { ascending: true });

    if (partialErr) return { customer: null, candidates: [], error: partialErr.message };

    const partialResults = partialMatches || [];
    if (partialResults.length === 1) return { customer: partialResults[0], candidates: [], error: null };
    if (partialResults.length > 1) return { customer: null, candidates: partialResults, error: null };

    // Step 3: fuzzy trigram search via search_customers_fuzzy()
    // Threshold 0.10 — tuned from production data (Jun 2026)
    // Falls here when exact and partial ILIKE both return 0 results
    // e.g. "noor" → "Noor Suppliers", "anea" → "Ania Adnan"
    const { data: fuzzyMatches, error: fuzzyErr } = await supabase
      .rpc('search_customers_fuzzy', {
        p_organisation_id: orgId,
        p_search_term: searchName,
        p_limit: 5,
        p_threshold: 0.10,
      });

    if (fuzzyErr) {
      console.warn('[customerSelector] fuzzy search error:', fuzzyErr.message);
      return { customer: null, candidates: [], error: null }; // graceful — don't fail hard on fuzzy error
    }

    const fuzzyResults = fuzzyMatches || [];
    if (fuzzyResults.length === 0) return { customer: null, candidates: [], error: null };
    if (fuzzyResults.length === 1) return { customer: fuzzyResults[0], candidates: [], error: null };

    // Multiple fuzzy matches — return as candidates with similarity scores for clarification
    return { customer: null, candidates: fuzzyResults, error: null };
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
