#!/usr/bin/env python3
"""
Patch: Dashboard Tier 1 backend — GET /api/dashboard endpoint. See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Home Menu Audit" -> Dashboard.

Tier 1 scope only: You'll Get / You'll Give cards + this-month expenses +
3-month sales trend (bar chart, no react-native-svg dependency — that's
noted as a backlog upgrade for a future real line chart). Tier 2 (the 4
downloadable PDF reports: Sales/Purchases/Balance Sheet/P&L) is explicitly
NOT built here — separate scoped session.

Reuses existing, proven primitives rather than duplicating logic:
  - You'll Get / You'll Give -> getFinancialPosition({ orgId, scope:
    { type: 'org' }, supabase }) from queryEngine/primitives.js. Already
    computes totalReceivables + totalPayables + overdue amounts + cashGap
    in one call -- zero new financial logic written here.
  - Sales trend -> new query, but respects the schema's MANDATORY
    is_historical=false filter for financial truth (invoices table
    comment: "MANDATORY: all operational finance queries MUST filter
    is_historical = false").
  - Expenses this month -> new query, straightforward SUM.

1 file changed: backend/src/index.js
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

anchor_a = """import { extractBankAccountFromImage } from './services/ai/extractBankAccountFromImage.js';
import PDFDocument from 'pdfkit';"""

new_a = """import { extractBankAccountFromImage } from './services/ai/extractBankAccountFromImage.js';
import { getFinancialPosition } from './services/ai/queryEngine/primitives.js';
import PDFDocument from 'pdfkit';"""

replacements.append(("A", anchor_a, new_a))

anchor_b = """    return c.json({ articles: data || [] });
  } catch (err) {
    console.error('[GET /api/help-articles] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── PATCH /api/organisations ───────────────────────────────"""

new_b = """    return c.json({ articles: data || [] });
  } catch (err) {
    console.error('[GET /api/help-articles] Error:', err);
    return c.json({ error: 'internal_error' }, 500);
  }
});

// ─── GET /api/dashboard ──────────────────────────────────────
// Dashboard screen, Tier 1 (Home Menu Audit). Returns:
//   - position: { totalReceivables, totalPayables, ... } via the existing
//     getFinancialPosition() primitive -- no duplicated financial logic
//   - expensesThisMonth: sum of expenses.amount for the current calendar
//     month, excluding rejected/deleted
//   - salesTrend: last 3 calendar months of invoiced total_amount, each
//     with { month, label, total }, plus pctChangeVsPriorMonth. Respects
//     the schema's mandatory is_historical=false filter for financial
//     truth (see invoices table comment in schema_sql_v3.txt).
// Tier 2 (downloadable Sales/Purchases/BalSheet/P&L reports) intentionally
// NOT included -- separate scoped session.
app.get('/api/dashboard', async (c) => {
  try {
    const auth = await authenticateChat(c);
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const { organisationId } = auth;

    // You'll Get / You'll Give — reuse existing primitive, zero new logic
    const { position, error: posError } = await getFinancialPosition({
      orgId: organisationId,
      scope: { type: 'org' },
      supabase,
    });
    if (posError) {
      console.warn('[GET /api/dashboard] getFinancialPosition error:', posError);
    }

    // Expenses this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const { data: expenseRows, error: expError } = await supabase
      .from('expenses')
      .select('amount')
      .eq('organisation_id', organisationId)
      .gte('expense_date', monthStart)
      .neq('status', 'rejected')
      .is('deleted_at', null);
    if (expError) console.warn('[GET /api/dashboard] expenses query error:', expError.message);
    const expensesThisMonth = (expenseRows || []).reduce((s, e) => s + Number(e.amount || 0), 0);

    // Sales trend — last 3 calendar months (current + 2 prior)
    const monthWindows = [];
    for (let i = 2; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      monthWindows.push({
        label: start.toLocaleDateString('en-US', { month: 'short' }),
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      });
    }
    const earliestStart = monthWindows[0].start;
    const { data: invoiceRows, error: invError } = await supabase
      .from('invoices')
      .select('issue_date, total_amount')
      .eq('organisation_id', organisationId)
      .eq('is_historical', false)
      .not('status', 'in', '("draft","cancelled")')
      .gte('issue_date', earliestStart)
      .is('deleted_at', null);
    if (invError) console.warn('[GET /api/dashboard] invoices query error:', invError.message);

    const salesTrend = monthWindows.map(w => {
      const total = (invoiceRows || [])
        .filter(inv => inv.issue_date >= w.start && inv.issue_date < w.end)
        .reduce((s, inv) => s + Number(inv.total_amount || 0), 0);
      return { month: w.start.slice(0, 7), label: w.label, total: Math.round(total * 100) / 100 };
    });
    const currentMonthTotal = salesTrend[salesTrend.length - 1]?.total || 0;
    const priorMonthTotal = salesTrend[salesTrend.length - 2]?.total || 0;
    const pctChangeVsPriorMonth = priorMonthTotal > 0
      ? Math.round(((currentMonthTotal - priorMonthTotal) / priorMonthTotal) * 10000) / 100
      : (currentMonthTotal > 0 ? 100 : 0);

    return c.json({
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

// ─── PATCH /api/organisations ───────────────────────────────"""

replacements.append(("B", anchor_b, new_b))

for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Dashboard Tier 1 backend patch applied successfully (A, B).")
