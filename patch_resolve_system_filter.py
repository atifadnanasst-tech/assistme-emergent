#!/usr/bin/env python3
"""
Patch: resolveSystemFilter() — Home Screen Filter Pills v1 surgical fix
See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Screen Filter Pills — v1
Functional Spec (Task 0)" for full pill definitions and muted-pill rationale.

Applies 4 changes to backend/src/index.js:
  A. Inserts resolveSystemFilter(tagName, organisationId) helper before the
     /api/home route.
  B. Trims new-org signup system tags to only the 3 live pills (All, Dues,
     Quotes). Existing orgs' old tag rows (Invoiced/To Deliver/Challans) are
     left untouched in the DB — they're just hidden from filterTabs (see C).
  C. filterTabs loop: hides muted/removed system tags from the response
     entirely, and computes counts for live system tags (Dues/Quotes) via
     resolveSystemFilter instead of entity_tags.
  D. Filter-application block: uses resolveSystemFilter for live/muted system
     tags, falls back to entity_tags only for genuine custom tags.

Run: python3 patch_resolve_system_filter.py
Then: node --check backend/src/index.js
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# ─────────────────────────────────────────────────────────────────────────
# A. Insert resolveSystemFilter() helper before the /api/home route
# ─────────────────────────────────────────────────────────────────────────
anchor_a = "// Home Screen Data Endpoint\napp.get('/api/home', async (c) => {"

resolver_fn = '''// ── Home Screen System Filter Resolver (v1 surgical fix) ───────────────────
// v1 implementation: system filters are resolved here. This is an
// intentional pre-Business Segment Engine abstraction and should eventually
// migrate to shared BQE primitives (resolveSegment + one file per primitive)
// rather than grow within this file. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
// -> "Home Screen Filter Pills — v1 Functional Spec (Task 0)" for full pill
// definitions and muted-pill rationale.
//
// IMPORTANT: both the filterTabs count loop AND the tap-to-filter block call
// this exact function — counts and results can never drift out of sync.
// Keep it that way; never compute a count via a separate query.
//
// TODO (v2 migration point): this keys off tag.name (display text), because
// the tags table has no stable system_key/slug column today (verified
// against schema_sql_v3.txt). Acceptable for v1 since system tag names are
// not user-editable, but if that ever changes, add a system_key column and
// key off that instead of name.
//
// Returns:
//   { customerIds: [...] }  — recognised system tag, computed result (may be
//                              an empty array for muted pills)
//   null                    — not a recognised system tag; caller falls back
//                              to entity_tags (custom tag) lookup
async function resolveSystemFilter(tagName, organisationId) {
  switch (tagName) {
    case 'Dues': {
      // Dues = net money owed (ledger balance: opening balance + unpaid/
      // partial invoices - payments + applied credit notes). NOT the same
      // set as "Invoiced" (paperwork existence) — see backlog doc for the
      // opening-balance-only / credit-note-offset edge cases.
      const { data, error } = await supabase
        .from('customers')
        .select('id')
        .eq('organisation_id', organisationId)
        .gt('outstanding_balance', 0)
        .is('deleted_at', null);
      if (error) {
        console.error('resolveSystemFilter[Dues] error:', error);
        return { customerIds: [] };
      }
      return { customerIds: (data || []).map(r => r.id) };
    }

    case 'Quotes': {
      // No expiry cutoff in v1 by design — a quote stays "active" until it
      // is converted to an invoice or explicitly cancelled.
      const { data, error } = await supabase
        .from('quotations')
        .select('customer_id')
        .eq('organisation_id', organisationId)
        .in('status', ['draft', 'sent'])
        .is('deleted_at', null);
      if (error) {
        console.error('resolveSystemFilter[Quotes] error:', error);
        return { customerIds: [] };
      }
      return { customerIds: [...new Set((data || []).map(r => r.customer_id))] };
    }

    // ── MUTED FOR v1 — do not wire these up without reading the backlog doc ──
    // Unread: no unread_count field exists in schema; needs a delivery_status-
    //   based query and touches the D2/B3 transport pipeline. Muted on
    //   complexity grounds.
    // Invoiced: actually the simplest pill to build — muted purely on
    //   scope-minimalism grounds, to keep v1 to Dues + Quotes.
    // To Deliver: backend/task wiring reliability unconfirmed, muted pending
    //   audit.
    case 'Unread':
    case 'Invoiced':
    case 'To Deliver':
      console.warn(`resolveSystemFilter: "${tagName}" is muted for v1 — returning empty result`);
      return { customerIds: [] };

    // Challans removed permanently (not deferred) — a challan is a document
    // artifact, not a customer state; "To Deliver" already represents that
    // state. Falls through to default so any stray legacy tag row is treated
    // as an unrecognised/custom tag rather than crashing.

    default:
      return null; // not a recognised system tag — caller falls back to entity_tags
  }
}

// Home Screen Data Endpoint
app.get('/api/home', async (c) => {'''

replacements.append(("A", anchor_a, resolver_fn))

# ─────────────────────────────────────────────────────────────────────────
# B. Trim new-org signup system tags to the 3 live pills
# ─────────────────────────────────────────────────────────────────────────
anchor_b = """        const systemTags = [
          { name: 'All', color: '#6366f1', is_system: true },
          { name: 'Dues', color: '#D32F2F', is_system: true },
          { name: 'Quotes', color: '#F57C00', is_system: true },
          { name: 'Invoiced', color: '#388E3C', is_system: true },
          { name: 'To Deliver', color: '#1976D2', is_system: true },
          { name: 'Challans', color: '#7B1FA2', is_system: true },
        ];"""

new_b = """        // v1: only the 3 live pills are provisioned for new orgs. Unread/
        // Invoiced/To Deliver are muted, Challans is removed permanently —
        // see ASSISTME_V2_ARCHITECTURAL_BACKLOG.md "Home Screen Filter Pills
        // — v1 Functional Spec (Task 0)". Existing orgs' old tag rows for the
        // muted/removed pills are left as-is in the DB; they're just hidden
        // from filterTabs (see resolveSystemFilter + filterTabs loop).
        const systemTags = [
          { name: 'All', color: '#6366f1', is_system: true },
          { name: 'Dues', color: '#D32F2F', is_system: true },
          { name: 'Quotes', color: '#F57C00', is_system: true },
        ];"""

replacements.append(("B", anchor_b, new_b))

# ─────────────────────────────────────────────────────────────────────────
# C. filterTabs loop — hide muted/removed system tags, compute live ones
#    via resolveSystemFilter
# ─────────────────────────────────────────────────────────────────────────
anchor_c = """    const filterTabs = [];
    
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
    }"""

new_c = """    const filterTabs = [];

    // v1: these system pills are muted/removed — hidden from filterTabs
    // entirely rather than shown with broken/empty behavior. Custom
    // (non-system) tags are never affected by this list. See
    // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md "Home Screen Filter Pills — v1
    // Functional Spec (Task 0)".
    const MUTED_OR_REMOVED_SYSTEM_TAGS = ['Unread', 'Invoiced', 'To Deliver', 'Challans'];

    if (!tagsError && tags) {
      // Compute counts for each tag
      for (const tag of tags) {
        // v1: hide muted/removed system tags from the UI entirely
        if (tag.is_system && MUTED_OR_REMOVED_SYSTEM_TAGS.includes(tag.name)) {
          continue;
        }

        let count = null;

        if (tag.is_system) {
          // Live system tag (All / Dues / Quotes) — computed via
          // resolveSystemFilter, not entity_tags. "All" has no computed
          // definition (no filter applied), so it falls through
          // resolveSystemFilter (returns null) and keeps count = null.
          const resolved = await resolveSystemFilter(tag.name, organisationId);
          if (resolved) {
            count = resolved.customerIds.length;
          }
        } else {
          // Custom tag (VIP, Gold, etc.) — unchanged, still manual entity_tags
          const { count: tagCount, error: countError } = await supabase
            .from('entity_tags')
            .select('*', { count: 'exact', head: true })
            .eq('organisation_id', organisationId)
            .eq('tag_id', tag.id)
            .eq('entity_type', 'customer');

          if (!countError) {
            count = tagCount;
          }
        }

        filterTabs.push({
          id: tag.id,
          name: tag.name,
          count: count,
          is_custom: !tag.is_system,
        });
      }
    }"""

replacements.append(("C", anchor_c, new_c))

# ─────────────────────────────────────────────────────────────────────────
# D. Filter-application block — use resolveSystemFilter for system tags,
#    fall back to entity_tags for custom tags
# ─────────────────────────────────────────────────────────────────────────
anchor_d = """    // Apply filter if specified (not 'all')
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
    }"""

new_d = """    // Apply filter if specified (not 'all')
    let filteredCustomerIds = [];
    if (filterTagId && filterTagId !== 'all') {
      const filterTagRecord = (tags || []).find(t => t.id === filterTagId);
      const resolvedSystem = (filterTagRecord && filterTagRecord.is_system)
        ? await resolveSystemFilter(filterTagRecord.name, organisationId)
        : null;

      if (resolvedSystem) {
        // Live (or muted, returns []) system tag — computed customer IDs
        filteredCustomerIds = resolvedSystem.customerIds;
      } else {
        // Custom tag (or unrecognised system tag) — fall back to entity_tags
        const { data: entityTags, error: entityTagsError } = await supabase
          .from('entity_tags')
          .select('entity_id')
          .eq('organisation_id', organisationId)
          .eq('tag_id', filterTagId)
          .eq('entity_type', 'customer');

        if (!entityTagsError && entityTags) {
          filteredCustomerIds = entityTags.map(et => et.entity_id);
        }
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
    }"""

replacements.append(("D", anchor_d, new_d))

# ─────────────────────────────────────────────────────────────────────────
# Apply with match-count validation — abort if any anchor isn't exactly 1
# ─────────────────────────────────────────────────────────────────────────
for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("All 4 patches applied successfully (A, B, C, D).")
