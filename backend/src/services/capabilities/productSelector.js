/**
 * AssistMe — Product Selector (Shared Helper)
 *
 * Location: /backend/src/services/capabilities/productSelector.js
 * Created: Session I-A, Jun 2026
 *
 * PURPOSE: Single source of truth for resolving planner selector params → DB product records.
 *
 * CONSUMERS:
 *   executionPlanBuilder.js  → preview (READ ONLY, never writes)
 *   mutationCapabilities.js  → execution (writes after owner confirmation)
 *
 * GUARANTEE:
 *   Both consumers call this exact function with the same params.
 *   Preview and execution always operate on the same product set.
 *   No duplicate selector logic anywhere in the codebase.
 *
 * THIS FUNCTION IS READ ONLY. It never writes to DB.
 */

export async function resolveProductSelector({
  selector = {},
  orgId,
  supabase,
  includeInactive = false,
}) {
  if (!orgId) return { products: [], error: 'org_id is required' };
  if (!supabase) return { products: [], error: 'supabase client not provided' };

  let query = supabase
    .from('products')
    .select('id, name, selling_price, cost_price, category, unit, is_active')
    .eq('organisation_id', orgId)
    .is('deleted_at', null);

  if (!includeInactive) {
    query = query.eq('is_active', true);
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (selector.product_id !== undefined && selector.product_id !== null) {
    if (UUID_PATTERN.test(String(selector.product_id))) {
      query = query.eq('id', selector.product_id);
    } else {
      query = query.ilike('name', `%${selector.product_id}%`);
    }
  } else if (selector.category !== undefined && selector.category !== null && selector.category !== '') {
    query = query.ilike('category', `%${selector.category}%`);
  } else if (selector.name_contains !== undefined && selector.name_contains !== null && selector.name_contains !== '') {
    query = query.ilike('name', `%${selector.name_contains}%`);
  } else if (selector.name !== undefined && selector.name !== null && selector.name !== '') {
    // alias: planner may send 'name' instead of 'name_contains'
    query = query.ilike('name', `%${selector.name}%`);
  } else if (selector.all === true) {
    // explicit opt-in — no additional filter
  } else {
    console.warn('[resolveProductSelector] no valid selector provided:', JSON.stringify(selector));
    return { products: [], error: 'no_selector: specify category, name_contains, product_id, or all:true' };
  }

  const { data, error: dbError } = await query.order('name', { ascending: true });

  if (dbError) {
    console.error('[resolveProductSelector] DB error:', dbError.message);
    return { products: [], error: dbError.message };
  }

  const results = data || [];

  // Fuzzy fallback for single-product name lookups only
  // Only when a name was provided and ILIKE returned 0 results
  // Does NOT apply to category or all selectors — those are intentionally broad
  const isSingleNameLookup = (
    (selector.product_id && typeof selector.product_id === 'string') ||
    selector.name ||
    selector.name_contains
  ) && !selector.category && !selector.all;

  if (results.length === 0 && isSingleNameLookup) {
    const searchTerm = selector.name || selector.name_contains || selector.product_id;

    const { data: fuzzyMatches, error: fuzzyErr } = await supabase
      .rpc('search_products_fuzzy', {
        p_organisation_id: orgId,
        p_search_term: searchTerm,
        p_limit: 5,
        p_threshold: 0.10,
      });

    if (fuzzyErr) {
      console.warn('[resolveProductSelector] fuzzy search error:', fuzzyErr.message);
      return { products: [], error: null };
    }

    const fuzzyResults = fuzzyMatches || [];
    if (fuzzyResults.length === 0) return { products: [], error: null };

    console.log('[resolveProductSelector] fuzzy:', searchTerm,
      '→', fuzzyResults.length, 'match(es), top score:', fuzzyResults[0]?.similarity_score);

    // Re-query full product records by ID — ensures consistent object shape for all callers
    const fuzzyIds = fuzzyResults.map(p => p.id);
    const { data: fullProducts, error: fullErr } = await supabase
      .from('products')
      .select('id, name, selling_price, cost_price, category, unit, is_active')
      .eq('organisation_id', orgId)
      .is('deleted_at', null)
      .in('id', fuzzyIds);

    if (fullErr) {
      console.warn('[resolveProductSelector] fuzzy re-query error:', fullErr.message);
      return { products: [], error: null };
    }

    // Restore fuzzy score ranking — .in() query doesn't guarantee order
    const scoreOrder = new Map(fuzzyIds.map((id, idx) => [id, idx]));
    const ranked = (fullProducts || []).sort(
      (a, b) => (scoreOrder.get(a.id) ?? 999) - (scoreOrder.get(b.id) ?? 999)
    );

    return { products: ranked, error: null };
  }

  return { products: results, error: null };
}

export async function resolveProductSelectorCount({
  selector = {},
  orgId,
  supabase,
  includeInactive = false,
}) {
  const { products, error } = await resolveProductSelector({ selector, orgId, supabase, includeInactive });
  if (error) return { count: null, error };
  return { count: products.length, error: null };
}
