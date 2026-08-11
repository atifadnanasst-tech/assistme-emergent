#!/usr/bin/env python3
"""
Patch: Header Search Tier 1 backend — GET /api/customers/search endpoint.
See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit" -> Header
Search.

Tier 1 scope only: search by customer name/phone/company, navigate to the
matched customer's chat. This is the cheap, low-risk slice — reuses the
customers table directly (mirrors customerSelector.js's own proven first
step: ILIKE partial match). Tier 2 (full message-content search across all
chats) is explicitly NOT built here -- documented separately as its own
scoped session, since it needs a new tsvector/GIN index on the messages
table, which has no existing text-search infrastructure and is one of the
most write-heavy tables in the app (every chat message, every AI turn) --
a careless index there risks slowing down message inserts. That risk isn't
worth taking without its own dedicated, performance-conscious session.

1 file changed: backend/src/index.js
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

anchor = """    return c.json({
      position: position || null,
      expensesThisMonth: Math.round(expensesThisMonth * 100) / 100,
      salesTrend,
      pctChangeVsPriorMonth,
    });
  } catch (err) {
    console.error('[GET /api/dashboard] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});"""

new = """    return c.json({
      position: position || null,
      expensesThisMonth: Math.round(expensesThisMonth * 100) / 100,
      salesTrend,
      pctChangeVsPriorMonth,
    });
  } catch (err) {
    console.error('[GET /api/dashboard] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── GET /api/customers/search ───────────────────────────────
// Header Search, Tier 1 (Home Menu Audit). Search by customer name/phone/
// company, navigate to their chat (/chat/[customer_id] -- no conversation
// join needed, that route resolves the conversation itself).
// Tier 2 (full message-content search) is a separate, heavier, future
// scoped session -- see file header comment above for why.
app.get('/api/customers/search', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    const q = (c.req.query('q') || '').trim();
    if (!q) return c.json({ customers: [] });

    // ILIKE across name/phone/company -- mirrors customerSelector.js's own
    // proven first step (partial match before any fuzzy fallback).
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, phone, company, outstanding_balance')
      .eq('organisation_id', organisationId)
      .is('deleted_at', null)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%,company.ilike.%${q}%`)
      .order('name', { ascending: true })
      .limit(20);

    if (error) {
      console.error('[GET /api/customers/search] error:', error.message);
      return c.json({ error: 'search_failed' }, 500);
    }

    return c.json({ customers: data || [] });
  } catch (err) {
    console.error('[GET /api/customers/search] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});"""

count = content.count(anchor)
if count != 1:
    print(f"ABORT: anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("GET /api/customers/search route added.")
