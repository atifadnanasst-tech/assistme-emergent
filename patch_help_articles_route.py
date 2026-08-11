#!/usr/bin/env python3
"""
Patch: Add GET /api/help-articles HTTP route (Step 2 of Home Menu Audit —
Tutorials & Help build). See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md ->
"Home Menu Audit".

The help_articles table + search_help_articles RPC already exist (shipped
v1.3.400), but only the internal Org AI freeform pre-check (tryHelpArticle)
calls the RPC — no HTTP endpoint exposes it, so the frontend Tutorials &
Help screen can't reach it. This adds a thin authenticated GET.

Behavior:
  - ?q=<query>  -> calls search_help_articles RPC, returns ranked matches.
  - no q (empty) -> returns all active articles (so the screen shows the
    full list on open, then filters as the user types). This keeps the
    frontend "search-only" with no separate list endpoint.
Read-only, org-agnostic (help articles are global product docs, not
per-org). Returns slug/title/category/steps/pitfalls for rendering.

1 file changed: backend/src/index.js
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

anchor = """    return c.json(data);
  } catch (err) {
    console.error('[GET /api/organisations] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── PATCH /api/organisations ───────────────────────────────"""

new = """    return c.json(data);
  } catch (err) {
    console.error('[GET /api/organisations] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── GET /api/help-articles ─────────────────────────────────
// Tutorials & Help screen (Home Menu Audit, Step 2). Search-only UX:
//   ?q=<query> -> ranked matches via the search_help_articles RPC
//   (no q)     -> all active articles (full list on screen open)
// Reuses the help_articles table + RPC shipped in v1.3.400. Read-only;
// help content is global product documentation, not org-scoped.
app.get('/api/help-articles', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);

    const q = (c.req.query('q') || '').trim();

    if (q) {
      // Ranked search via the existing RPC (same one tryHelpArticle uses).
      const { data, error } = await supabase
        .rpc('search_help_articles', { p_query: q });
      if (error) {
        console.error('[GET /api/help-articles] search error:', error.message);
        return c.json({ error: 'search_failed' }, 500);
      }
      return c.json({ articles: data || [] });
    }

    // No query -> full active list, stable ordering by category then title.
    const { data, error } = await supabase
      .from('help_articles')
      .select('slug, title, category, steps, pitfalls')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('title', { ascending: true });
    if (error) {
      console.error('[GET /api/help-articles] list error:', error.message);
      return c.json({ error: 'list_failed' }, 500);
    }
    return c.json({ articles: data || [] });
  } catch (err) {
    console.error('[GET /api/help-articles] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── PATCH /api/organisations ───────────────────────────────"""

count = content.count(anchor)
if count != 1:
    print(f"ABORT: anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("GET /api/help-articles route added.")
