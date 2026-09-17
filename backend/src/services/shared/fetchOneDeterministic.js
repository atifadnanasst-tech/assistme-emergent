/**
 * AssistMe — fetchOneDeterministic.js
 * Created: Sept 2026
 *
 * PURPOSE:
 *   Fetches "the one row that should exist" for a query where duplicate
 *   rows are a KNOWN possible data-integrity issue — either from a race
 *   condition during creation, or by legitimate design (e.g. multiple
 *   active targeted-override rows for the same key).
 *
 *   Supabase's .maybeSingle() THROWS its own error when more than one
 *   row matches, expecting exactly 0 or 1. That error is easy to forget
 *   to check — and when it's silently discarded, the caller gets `null`
 *   back and falls through to whatever "nothing found" behavior exists,
 *   even though a real row (or several) genuinely exists.
 *
 *   This function never uses .maybeSingle(). It always asks for the
 *   rows ordered by a caller-specified tiebreak column and takes the
 *   first one — deterministic, and immune to ever silently returning
 *   nothing just because more than one row happens to match.
 *
 * CONFIRMED REAL PRECEDENT (not speculative — this pattern has already
 * caused two independent, confirmed production bugs before this
 * function existed):
 *   1. system_config.pdf_footer_promo lookup (documentBrandingProfile.js,
 *      fixed Jun 17 2026) — multiple active rows for the same key
 *      (global default + targeted overrides) made .maybeSingle() throw,
 *      silently producing a blank footer.
 *   2. business_profiles default-profile lookup (documentBrandingProfile.js,
 *      fixed Sept 2026) — a known, documented race condition
 *      (PROFILE-DB-01) let two is_default=true rows exist per org,
 *      making .maybeSingle() throw and silently print a blank/placeholder
 *      business name on a real customer's invoice.
 *
 * NOT YET DONE, DELIBERATELY: setBusinessProfileCapability.js's own
 * _getOrCreateDefaultProfile() already implements this exact same
 * order-and-take-first pattern inline, predating this shared function.
 * Migrating it (and the footer-promo call site above) to call this
 * function instead is a real, worthwhile follow-up — deliberately not
 * bundled into whichever fix first introduced this file, to keep that
 * fix's blast radius small. Both existing inline implementations are
 * still correct as-is; this is a reusability cleanup, not a bug fix,
 * for those two call sites specifically.
 */

export async function fetchOneDeterministic(supabase, table, {
  select = '*',
  filters = {},
  isNullColumns = [],
  orderColumn,
  ascending,
}) {
  if (!orderColumn) {
    throw new Error('fetchOneDeterministic requires an orderColumn — silently picking an arbitrary row when duplicates exist defeats the entire purpose of this function.');
  }

  let query = supabase.from(table).select(select);
  for (const [col, val] of Object.entries(filters)) {
    query = query.eq(col, val);
  }
  for (const col of isNullColumns) {
    query = query.is(col, null);
  }
  query = query.order(orderColumn, { ascending }).limit(1);

  const { data, error } = await query;
  if (error) {
    return { row: null, error };
  }
  return { row: (data && data[0]) || null, error: null };
}
