#!/usr/bin/env python3
"""
Patch: Export My Data -- wire the new generateOwnerDataExport module into
index.js (import, cron registration, 3 thin route handlers). The bulk of
the logic lives in backend/src/services/export/generateOwnerDataExport.js
(deployed separately, already verified). This patch is intentionally
small.
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

anchor_a = """import { getFinancialPosition } from './services/ai/queryEngine/primitives.js';"""

new_a = """import { getFinancialPosition } from './services/ai/queryEngine/primitives.js';
import { generateOwnerDataExport } from './services/export/generateOwnerDataExport.js';"""

replacements.append(("A", anchor_a, new_a))

anchor_b = """cron.schedule('0 20 * * *', () => runWatchJobForAllOrgs('jobBankReconciliation', jobBankReconciliation), CRON_TZ);"""

new_b = """cron.schedule('0 20 * * *', () => runWatchJobForAllOrgs('jobBankReconciliation', jobBankReconciliation), CRON_TZ);
cron.schedule('0 3 * * *', () => runWatchJobForAllOrgs('jobDataExport', jobDataExport), CRON_TZ);"""

replacements.append(("B", anchor_b, new_b))

anchor_c = """      console.error('[GET /api/customers/search] error:', error.message);
      return c.json({ error: 'search_failed' }, 500);
    }

    return c.json({ customers: data || [] });
  } catch (err) {
    console.error('[GET /api/customers/search] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});"""

new_c = """      console.error('[GET /api/customers/search] error:', error.message);
      return c.json({ error: 'search_failed' }, 500);
    }

    return c.json({ customers: data || [] });
  } catch (err) {
    console.error('[GET /api/customers/search] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── Export My Data (Home Menu Audit) ────────────────────────
// Core logic lives in services/export/generateOwnerDataExport.js.

async function jobDataExport(orgId) {
  const result = await generateOwnerDataExport({ orgId, supabase });
  return result.success ? 1 : 0;
}

app.get('/api/export/status', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const { data: orgRow, error } = await supabase
      .from('organisations').select('settings').eq('id', organisationId).maybeSingle();
    if (error) return c.json({ error: 'internal_error' }, 500);
    const settings = orgRow?.settings || {};
    return c.json({
      hasExport: !!settings.last_export_path,
      generatedAt: settings.last_export_generated_at || null,
    });
  } catch (err) {
    console.error('[GET /api/export/status] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// Mints a short-lived (10 min) signed URL on demand -- never stored, never
// returned by /api/export/status. This bundle contains full bank account
// numbers + the complete business ledger, meaningfully more sensitive than
// a single invoice PDF, hence signed-URL-on-demand rather than a permanent
// public link.
app.get('/api/export/download', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const { data: orgRow } = await supabase
      .from('organisations').select('settings').eq('id', organisationId).maybeSingle();
    const storagePath = orgRow?.settings?.last_export_path;
    if (!storagePath) return c.json({ error: 'no_export_yet' }, 404);
    const { data: signedData, error: signErr } = await supabase.storage
      .from('exports')
      .createSignedUrl(storagePath, 600);
    if (signErr) {
      console.error('[GET /api/export/download] sign error:', signErr.message);
      return c.json({ error: 'sign_failed' }, 500);
    }
    return c.json({ url: signedData.signedUrl });
  } catch (err) {
    console.error('[GET /api/export/download] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

app.post('/api/export/trigger', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;
    const result = await generateOwnerDataExport({ orgId: organisationId, supabase });
    if (!result.success) return c.json({ error: 'export_failed', message: result.error }, 500);
    return c.json({ generatedAt: result.generatedAt });
  } catch (err) {
    console.error('[POST /api/export/trigger] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});"""

replacements.append(("C", anchor_c, new_c))

for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Export My Data index.js wiring applied successfully (A, B, C).")
