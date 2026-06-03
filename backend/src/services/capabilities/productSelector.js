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

  return { products: data || [], error: null };
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
