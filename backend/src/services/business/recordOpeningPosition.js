/**
 * AssistMe — recordOpeningPosition() Domain Service
 * Location: /backend/src/services/business/recordOpeningPosition.js
 * Created: Jun 2026 — Opening Position capability (Patch Set A)
 *
 * THIRD CANONICAL BUSINESS PRIMITIVE (mirrors recordPayment.js /
 * recordPurchaseBill.js pattern). Called by record_opening_position
 * capability. Never duplicated. Never bypassed.
 *
 * ARCHITECTURE STATUS — READ THIS FIRST:
 *   This is NOT a new financial model. It activates two dormant v1.7
 *   mechanisms that already exist in schema and doctrine:
 *     1. customers.opening_balance / opening_balance_date (added v1.7,
 *        never written until now)
 *     2. "OB invoice" semantics (historical_source='opening_balance'),
 *        previously specified only for the historical-import flow
 *        (AssistMe_Financial_Calculation_Rules.md → "Historical Import
 *        Rules" item 7), now made callable as a standalone declaration.
 *   Full spec, audit (score 9.2/10), and rationale:
 *     AssistMe_Financial_Calculation_Rules.md → "Opening Position Rules"
 *
 * CORE PRINCIPLE: Opening Position is a LEDGER EVENT, not a balance
 * mutation.
 *   - Receivable ("they owe the owner") → OB invoice
 *       (inline insert here, mirrors index.js ~2703-2854 invoice-creation
 *       pattern; exempt from calculateInvoiceTotals — same exemption
 *       historical-import OB invoices already have)
 *   - Payable ("the owner owes them") → OB purchase bill
 *       (delegates directly to recordPurchaseBill() — reuse, not
 *       reinvent; purchase_bills.amount_due is already the live payable
 *       truth, no new balance field per ASSISTME_ENTITY_FINANCIAL_DOCTRINE.md
 *       "RULE FOR NOW")
 *
 * DEFINITIONS (see Financial Calculation Rules for canonical text):
 *   Real Transaction = invoices/payments/purchase_bills/supplier_payments
 *     row WHERE historical_source IS NULL OR historical_source !=
 *     OPENING_POSITION_SOURCE
 *   Opening Position Transaction = invoices/purchase_bills row WHERE
 *     historical_source = OPENING_POSITION_SOURCE (always is_historical
 *     = false)
 *   Correction Window = period with zero Real Transactions for this
 *     customer (in the relevant direction). Open → re-declaration allowed
 *     (void old OB row, create new). Closed → permanently locked,
 *     recordBalanceAdjustment() (Phase 2, NOT YET BUILT) is the only
 *     future path.
 *
 * GUARD (lock condition) — OB rows never count toward their own lock:
 *   Receivable locked <=> count(real invoices) > 0 OR count(real payments) > 0
 *   Payable locked    <=> count(real purchase_bills) > 0
 *     (supplier_payments has no historical_source/is_historical column —
 *     Opening Position never writes there, so ANY row in
 *     supplier_payments for this entity is a Real Transaction and locks)
 *
 * CORRECTION BEHAVIOR (within open window) — no silent mutation, but
 * ORDERING IS ASYMMETRIC BY DESIGN (audit Corrections 1/3 + Issue 1,
 * Jun 2026):
 *
 *   RECEIVABLE (customers.outstanding_balance is a cached balance field
 *   that MUST stay correct at all times):
 *     1. New OB invoice created FIRST (OB-<timestamp>)
 *     2. customers.opening_balance / opening_balance_date / 
 *        outstanding_balance updated (net-adjusted: reverse old OB
 *        amount, apply new — correct the instant this step completes)
 *     3. Old OB invoice voided (status='cancelled') LAST
 *     If step 3 fails: both OB invoices live, but outstanding_balance is
 *     already correct from step 2 — cosmetic LedgerView duplicate only,
 *     flagged via opening_position_void_failed.
 *
 *   PAYABLE (purchase_bills.amount_due has NO cached balance field — Home
 *   Screen / P3 sum amount_due across ALL non-cancelled rows ON DEMAND,
 *   so two live OB bills = silently double-counted payable):
 *     1. Old OB purchase bill voided (status='cancelled') FIRST
 *     2. New OB purchase bill created (OB-<timestamp>)
 *     If step 2 fails: zero OB bills exist temporarily (payable
 *     understated to 0 for this entity) — recoverable by re-declaring,
 *     flagged via reconciliation_note. Never silently OVERSTATED, which
 *     is the worse failure mode for cashflow/collection decisions.
 *
 * opening_balance_date SEMANTICS: represents the date of the CURRENTLY
 * ACTIVE Opening Position declaration, not the first-ever declaration.
 * If corrected within the window, this date is overwritten to the
 * correction's date — by design, since the old declaration is voided
 * and no longer represents the entity's opening position.
 *
 * VISIBILITY: OB rows are excluded from default invoice/bill list queries
 * (historical_source != OPENING_POSITION_SOURCE) — see Patch Set E.
 * They ARE shown in LedgerView / explainability queries (no filter, or
 * filter inverted).
 *
 * entity_memory: NEVER written here. Opening Position is financial truth,
 * recorded in invoices/purchase_bills. entity_memory is synthesized
 * intelligence and must never be the only record of a financial fact.
 *
 * WHAT REQUIRES RECALIBRATION (cancelled OB rows + downstream queries):
 *   - Cancelled invoices/purchase_bills are excluded from balance
 *     calculations by existing status filters
 *     (e.g. recordPayment.js's unpaid-invoice query uses
 *     .not('status', 'in', '("paid","cancelled","draft")') — cancelled
 *     OB invoices will not be offered for payment allocation, correct).
 *   - get_customer_invoices (index.js ~3557) and equivalent purchase-bill
 *     list endpoints need historical_source != OPENING_POSITION_SOURCE
 *     added — Patch Set E, same release per audit (not deferred).
 *
 * KNOWN DEBT (matches recordPayment.js / recordPurchaseBill.js v1 debt):
 *   - No Postgres transaction wrapping. Partial failure between OB invoice
 *     insert and customers update leaves the OB invoice created but
 *     opening_balance/outstanding_balance not reflecting it. Logged with
 *     operation_id for manual reconciliation. Documented for Phase 2
 *     hardening (same debt class as recordPayment.js).
 *   - Receivable OB invoice insert is inline (not via a createInvoice()
 *     primitive) because no such primitive exists yet — see
 *     AssistMe_Phased_Deferred_Work_v3.md "Invoice Refactor Sprint:
 *     Extract POST /api/invoices into createInvoice()". When that
 *     refactor happens, fold this OB-invoice insert into it too.
 *
 * DEFERRED TECHNICAL DEBT (audit, Jun 2026): a partial unique index would
 * eliminate the need for runtime corruption detection in findOpenOBRow():
 *   CREATE UNIQUE INDEX ... ON invoices (organisation_id, customer_id)
 *     WHERE historical_source = 'opening_balance' AND status != 'cancelled'
 *   (and equivalent for purchase_bills). NOT part of this patch.
 */

import { randomUUID } from 'crypto';
import { OPENING_POSITION_SOURCE } from '../../constants/openingPosition.js';
import { recordPurchaseBill } from './recordPurchaseBill.js';

const istToday = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};

/**
 * Returns true if the customer has at least one Real Transaction
 * (non-Opening-Position row) in the given table.
 * OB rows (historical_source = OPENING_POSITION_SOURCE) are excluded —
 * they never count toward their own lock.
 *
 * supplier_payments.customer_id (audit Finding A, Jun 2026): this table
 * has a legacy supplier_id column, but recordSupplierPayment.js (the only
 * writer) hardcodes supplier_id: null for all new rows and documents
 * "supplier_payments.supplier_id (legacy column) is null for all new
 * payments" — customer_id is the live column for the single-entity model.
 * Querying customer_id only is therefore correct for all rows written by
 * current code. Pre-migration rows with supplier_id set and customer_id
 * null are not expected to exist for entities that would also be eligible
 * for Opening Position (a brand-new, zero-history entity cannot have a
 * pre-migration row). If that assumption is ever violated, this guard
 * fails OPEN (a stale legacy row would not be detected) — acceptable
 * given current data shape, but flagged here for any future session
 * touching this function.
 */
async function hasRealTransaction(supabase, orgId, customerId, table, customerCol = 'customer_id') {
  let query = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', orgId)
    .eq(customerCol, customerId)
    .is('deleted_at', null);

  // supplier_payments has NO historical_source / is_historical column
  // (verified against schema_sql_v3.txt — Opening Position never writes
  // to this table, only to purchase_bills, so every row here is by
  // definition a Real Transaction). Apply the historical_source filter
  // only to tables that have it (invoices, purchase_bills, payments).
  if (table !== 'supplier_payments') {
    query = query.or(`historical_source.is.null,historical_source.neq.${OPENING_POSITION_SOURCE}`);
  }

  const { count, error } = await query;

  if (error) {
    // Fail closed: if we can't verify, treat as locked rather than risk
    // a duplicate/incorrect Opening Position.
    console.warn(`[recordOpeningPosition] hasRealTransaction(${table}) check failed:`, error.message);
    return true;
  }
  return (count || 0) > 0;
}

/**
 * Finds the currently-open (non-cancelled) Opening Position invoice or
 * purchase bill for this customer, if one exists. Used to support the
 * correction window (void old OB row, create new).
 *
 * FAIL-CLOSED ON MULTIPLE ACTIVE OB ROWS (audit Finding B, Jun 2026):
 * the architecture assumes 0 or 1 active OB row per entity/direction,
 * but there is no DB constraint enforcing this. .maybeSingle() would
 * throw on 2+ rows, and the old code swallowed that error and returned
 * null — silently treating an ambiguous/corrupt state as "no existing OB
 * row" and creating a THIRD one. Instead: fetch up to 2 rows; if 2 are
 * found, refuse outright with a distinct error code requiring manual
 * intervention. Financial primitives must not self-heal ambiguous states.
 */
async function findOpenOBRow(supabase, orgId, customerId, table) {
  const idCol = table === 'invoices' ? 'invoice_number' : 'bill_number';
  const { data, error } = await supabase
    .from(table)
    .select(`id, status, total_amount, amount_due, ${idCol}`)
    .eq('organisation_id', orgId)
    .eq('customer_id', customerId)
    .eq('historical_source', OPENING_POSITION_SOURCE)
    .eq('is_historical', false)
    .neq('status', 'cancelled')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(2);

  if (error) {
    console.warn(`[recordOpeningPosition] findOpenOBRow(${table}) failed:`, error.message);
    return { error: 'lookup_failed' };
  }

  if ((data || []).length > 1) {
    console.error(`[recordOpeningPosition] CORRUPT STATE: ${(data || []).length} active OB rows found in ${table} for customer=${customerId}. Refusing to proceed.`);
    return { error: 'opening_position_corrupt_state' };
  }

  return { row: (data && data[0]) || null, error: null };
}

/**
 * Receivable direction: "Ahmed owes me ₹10,000"
 * Creates an OB invoice, updates customers.opening_balance /
 * opening_balance_date / outstanding_balance.
 */
async function recordReceivableOpeningPosition(supabase, orgId, customerId, amount, operationId) {
  const events = [];

  // ── Guard: locked if any Real Transaction exists in invoices/payments ──
  const [realInvoices, realPayments] = await Promise.all([
    hasRealTransaction(supabase, orgId, customerId, 'invoices'),
    hasRealTransaction(supabase, orgId, customerId, 'payments'),
  ]);

  if (realInvoices || realPayments) {
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'opening_position_locked',
      message: 'This customer already has invoices or payments. Opening ' +
        'balance can only be set for a brand-new customer with no ' +
        'transaction history. To correct an existing balance, use a ' +
        'balance adjustment (not yet available).',
    };
  }

  // ── Correction window: check for an existing open OB invoice, but do
  //    NOT void it yet — create the replacement first (audit Correction 3:
  //    fail-safe ordering. No Postgres transaction wrapping exists in this
  //    codebase yet — recordPayment.js/recordPurchaseBill.js document the
  //    same "Known Debt". Ordering new-then-void means a failure after
  //    this point leaves the OLD OB invoice intact and uncancelled —
  //    system stays in its prior consistent state rather than a
  //    half-corrected one.) ──
  const obLookup = await findOpenOBRow(supabase, orgId, customerId, 'invoices');
  if (obLookup.error === 'opening_position_corrupt_state') {
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'opening_position_corrupt_state',
      message: 'Multiple opening balance records exist for this customer ' +
        '— this should not happen. Manual review is required before this ' +
        'can be corrected.',
    };
  }
  // lookup_failed is treated as "no existing OB row" (same as before) —
  // worst case is a duplicate OB row created, which is still cosmetic
  // on the receivable side since outstanding_balance is computed from
  // (current - reversedAmount + amount) regardless.
  const existingOB = obLookup.row;
  const reversedAmount = existingOB ? Number(existingOB.total_amount || 0) : 0;

  // ── Get current customer state ──
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, name, outstanding_balance')
    .eq('id', customerId)
    .eq('organisation_id', orgId)
    .is('deleted_at', null)
    .maybeSingle();

  if (custErr || !customer) {
    return { status: 'failed', operation_id: operationId, events, error: 'customer_not_found' };
  }

  // ── Invoice number for OB invoices (audit Correction 1): NOT the
  //    INV-NNN count+1 sequence — that pattern has a pre-existing race
  //    condition shared with live invoice creation (index.js ~2668/3173:
  //    two concurrent creates can read the same count and collide). OB
  //    invoices don't need a sequence number — historical_source is
  //    already the canonical identifier (Rule 7). Use OB-<timestamp>
  //    instead, avoiding the INV- sequence collision surface entirely. ──
  const invoiceNumber = 'OB-' + Date.now();

  const issueDate = istToday();

  // ── Create OB invoice — exempt from calculateInvoiceTotals, same
  //    exemption as historical-import OB invoices ──
  const { data: newInvoice, error: invErr } = await supabase
    .from('invoices')
    .insert({
      organisation_id: orgId,
      customer_id: customerId,
      invoice_number: invoiceNumber,
      status: 'sent',
      issue_date: issueDate,
      due_date: issueDate,
      // INR hardcoded — accepted for India-first rollout (audit Issue 5,
      // Jun 2026, not a blocker). If multi-currency orgs are added,
      // read org currency here instead.
      currency: 'INR',
      subtotal: amount,
      tax_amount: 0,
      discount_amount: 0,
      total_amount: amount,
      amount_due: amount,
      amount_paid: 0,
      is_historical: false,
      historical_source: OPENING_POSITION_SOURCE,
      custom_fields: { opening_position: true },
    })
    .select('id, invoice_number')
    .single();

  if (invErr || !newInvoice) {
    console.error(`[recordOpeningPosition] op=${operationId} OB invoice insert failed:`, invErr?.message);
    return {
      status: events.length > 0 ? 'partial_success' : 'failed',
      operation_id: operationId,
      events,
      error: 'ob_invoice_insert_failed',
      message: 'Could not record opening balance. Please try again.',
    };
  }

  events.push({
    type: 'opening_position_recorded',
    operation_id: operationId,
    direction: 'receivable',
    table: 'invoices',
    id: newInvoice.id,
    invoice_number: newInvoice.invoice_number,
    amount,
    entity_name: customer.name,
  });

  // Optional descriptive line item — cosmetic, not required by schema
  const { error: itemErr } = await supabase.from('invoice_items').insert({
    organisation_id: orgId,
    invoice_id: newInvoice.id,
    product_id: null,
    description: 'Opening Balance',
    quantity: 1,
    unit_price: amount,
    discount_pct: 0,
    tax_rate: 0,
    line_total: amount,
    sort_order: 0,
  });
  if (itemErr) {
    console.warn(`[recordOpeningPosition] op=${operationId} OB invoice_items insert failed (non-fatal):`, itemErr.message);
  }

  // ── Update customers: opening_balance, opening_balance_date,
  //    outstanding_balance (net adjustment if correcting) ──
  const currentBalance = Number(customer.outstanding_balance || 0);
  const newBalance = Math.round((currentBalance - reversedAmount + amount) * 100) / 100;

  const { error: balErr } = await supabase
    .from('customers')
    .update({
      opening_balance: amount,
      opening_balance_date: issueDate,
      outstanding_balance: newBalance,
    })
    .eq('id', customerId)
    .eq('organisation_id', orgId);

  if (balErr) {
    console.error(`[recordOpeningPosition] op=${operationId} customers update failed:`, balErr.message);
    return {
      status: 'partial_success',
      operation_id: operationId,
      events,
      error: 'customer_update_failed',
      reconciliation_note: `OB invoice ${newInvoice.id} created but ` +
        `customers.opening_balance/outstanding_balance not updated. op=${operationId}`,
    };
  }

  events.push({
    type: 'customer_balance_updated',
    operation_id: operationId,
    opening_balance: amount,
    opening_balance_date: issueDate,
    outstanding_balance: newBalance,
    previous_outstanding_balance: currentBalance,
  });

  // ── Void the old OB invoice LAST (audit Correction 3 ordering): the
  //    new OB invoice exists and customers.outstanding_balance already
  //    reflects it. If voiding fails here, both old and new OB invoices
  //    exist (old still 'sent', not 'cancelled') — outstanding_balance is
  //    correct either way since it was computed from (current - old + new)
  //    BEFORE this step. Worst case is a cosmetic duplicate in LedgerView,
  //    not a financial drift. Logged for manual cleanup. ──
  if (existingOB) {
    const { error: voidErr } = await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', existingOB.id)
      .eq('organisation_id', orgId);

    if (voidErr) {
      console.warn(`[recordOpeningPosition] op=${operationId} failed to void old OB invoice ${existingOB.id} (non-fatal — balance already correct):`, voidErr.message);
      events.push({
        type: 'opening_position_void_failed',
        operation_id: operationId,
        old_id: existingOB.id,
        old_invoice_number: existingOB.invoice_number,
        note: 'Old OB invoice still has status=sent. Outstanding balance is ' +
          'correct. Manual cleanup recommended: set status=cancelled on this row.',
      });
    } else {
      events.push({
        type: 'opening_position_voided',
        operation_id: operationId,
        table: 'invoices',
        old_id: existingOB.id,
        old_invoice_number: existingOB.invoice_number,
        old_amount: reversedAmount,
      });
    }
  }

  return {
    status: 'success',
    operation_id: operationId,
    events,
    direction: 'receivable',
    invoice_id: newInvoice.id,
    invoice_number: newInvoice.invoice_number,
    amount,
    new_outstanding_balance: newBalance,
    entity_name: customer.name,
  };
}

/**
 * Payable direction: "I owe Noor ₹5,000"
 * Delegates to recordPurchaseBill() — reuse, not reinvent. No new
 * balance field; purchase_bills.amount_due is the live payable truth.
 */
async function recordPayableOpeningPosition(supabase, orgId, customerId, amount, operationId) {
  const events = [];

  // ── Guard: locked if any Real Transaction exists in purchase_bills/
  //    supplier_payments ──
  const [realBills, realSupplierPayments] = await Promise.all([
    hasRealTransaction(supabase, orgId, customerId, 'purchase_bills'),
    hasRealTransaction(supabase, orgId, customerId, 'supplier_payments'),
  ]);

  if (realBills || realSupplierPayments) {
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'opening_position_locked',
      message: 'This entity already has purchase bills or payments made. ' +
        'Opening balance can only be set for a brand-new entity with no ' +
        'transaction history. To correct an existing balance, use a ' +
        'balance adjustment (not yet available).',
    };
  }

  // ── Correction window: void the existing open OB purchase bill FIRST,
  //    then create the replacement (audit Issue 1, Jun 2026 — DIFFERENT
  //    ordering than the receivable side, and intentionally so):
  //
  //    Unlike receivables, purchase_bills.amount_due has NO cached
  //    balance field — Home Screen / P3 totalPayables sum amount_due
  //    across all non-cancelled rows ON DEMAND. If we created the new OB
  //    bill BEFORE voiding the old one (mirroring the receivable
  //    ordering), a failure during voiding would leave BOTH bills live
  //    and BOTH would be summed — e.g. old=5000 + new=7000 = 12000
  //    shown as payable, which is financially wrong and silent.
  //
  //    Voiding first means: if voiding succeeds but bill creation then
  //    fails, the customer temporarily has ZERO OB bills (payable
  //    understated to 0 for this entity) — recoverable by simply
  //    re-declaring, and never silently wrong in the "too high" direction
  //    that could mislead collection/cashflow decisions. Logged via
  //    opening_position_void_failed / reconciliation_note either way. ──
  const obLookup = await findOpenOBRow(supabase, orgId, customerId, 'purchase_bills');
  if (obLookup.error === 'opening_position_corrupt_state') {
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'opening_position_corrupt_state',
      message: 'Multiple opening balance records exist for this entity ' +
        '— this should not happen. Manual review is required before this ' +
        'can be corrected.',
    };
  }
  if (obLookup.error === 'lookup_failed') {
    // Payable side (audit Issue 1 fix): unlike receivable, proceeding
    // without knowing whether an existing OB bill exists risks creating
    // a SECOND live bill -> silent double-counted payable (the exact
    // failure mode the void-first ordering exists to prevent). Fail
    // closed here rather than risk that.
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'lookup_failed',
      message: 'Could not verify existing opening balance records. Please try again.',
    };
  }
  const existingOB = obLookup.row;

  if (existingOB) {
    const { error: voidErr } = await supabase
      .from('purchase_bills')
      .update({ status: 'cancelled' })
      .eq('id', existingOB.id)
      .eq('organisation_id', orgId);

    if (voidErr) {
      console.error(`[recordOpeningPosition] op=${operationId} failed to void old OB purchase bill ${existingOB.id}:`, voidErr.message);
      return {
        status: 'failed',
        operation_id: operationId,
        events,
        error: 'void_old_ob_failed',
        message: 'Could not update the existing opening balance. Please try again.',
      };
    }

    events.push({
      type: 'opening_position_voided',
      operation_id: operationId,
      table: 'purchase_bills',
      old_id: existingOB.id,
      old_bill_number: existingOB.bill_number,
      old_amount: Number(existingOB.total_amount || 0),
    });
  }

  // ── Bill number for OB purchase bills (audit Correction 1, same
  //    reasoning as receivable side): recordPurchaseBill() defaults to
  //    PB-NNN count+1, which shares the same race-condition pattern as
  //    INV-NNN. historical_source is already the canonical identifier
  //    (Rule 7), so pass an explicit OB-<timestamp> bill number to avoid
  //    adding to the PB- sequence collision surface. ──
  const obBillNumber = 'OB-' + Date.now();

  // ── Create OB purchase bill via recordPurchaseBill() — reuse ──
  const result = await recordPurchaseBill(
    supabase,
    orgId,
    customerId,
    [{
      product_id: null,
      description: 'Opening Balance',
      quantity: 1,
      unit_price: amount,
      tax_rate: 0,
      discount_pct: 0,
    }],
    {
      issueDate: istToday(),
      billNumber: obBillNumber,
      notes: 'Opening Position — recorded via record_opening_position',
      historicalSource: OPENING_POSITION_SOURCE,
    }
  );

  if (result.status !== 'success') {
    return {
      status: events.length > 0 ? 'partial_success' : 'failed',
      operation_id: operationId,
      events,
      error: result.error || 'ob_purchase_bill_failed',
      message: events.length > 0
        ? 'The previous opening balance was removed, but the new amount ' +
          'could not be recorded. Please try setting the opening balance ' +
          'again.'
        : 'Could not record opening balance. Please try again.',
      reconciliation_note: events.length > 0
        ? `Old OB purchase bill ${existingOB?.id} was cancelled but new ` +
          `bill creation failed. Entity temporarily has zero Opening ` +
          `Position. op=${operationId}`
        : undefined,
    };
  }

  events.push({
    type: 'opening_position_recorded',
    operation_id: operationId,
    direction: 'payable',
    table: 'purchase_bills',
    id: result.bill_id,
    bill_number: result.bill_number,
    amount,
    entity_name: result.entity_name,
  });

  return {
    status: 'success',
    operation_id: operationId,
    events,
    direction: 'payable',
    bill_id: result.bill_id,
    bill_number: result.bill_number,
    amount,
    amount_due: result.amount_due,
    entity_name: result.entity_name,
  };
}

/**
 * isOpeningPositionAllowed() — lightweight, READ-ONLY eligibility check.
 * Created Jun 2026 (Spark preview-UX fix, post-recovery session).
 *
 * Reuses the EXACT SAME hasRealTransaction() guard that
 * recordOpeningPosition() itself uses — no duplicated query logic, no
 * second implementation of the lock rule to drift out of sync.
 *
 * WHY THIS EXISTS: Spark's preview step (/spark) was showing a normal
 * "I've prepared this" card with a Confirm button for customers who were
 * ALREADY LOCKED (have real invoices/payments/purchase_bills) — the
 * rejection only happened after the owner tapped Confirm, at execution
 * time inside recordOpeningPosition(). That is correct for financial
 * integrity but bad UX: the owner sees a misleading "this will work"
 * preview, taps Confirm, and is then told "not possible". This function
 * lets /spark check eligibility BEFORE building the preview card, so a
 * locked customer gets an explanatory message + no Confirm button
 * instead of a preview that fails.
 *
 * IMPORTANT — this does NOT replace the real guard inside
 * recordReceivableOpeningPosition()/recordPayableOpeningPosition(). That
 * guard still runs at confirm/execute time and is the actual financial
 * safety check (covers the race window between preview and confirm —
 * e.g. owner records a real payment in the few seconds between seeing
 * the preview and tapping Confirm). This function is a UX convenience
 * only; never treat its result as authorization to skip the real guard.
 *
 * @param {object} supabase  - Supabase client (service role)
 * @param {string} orgId     - organisation_id
 * @param {string} customerId - customers.id
 * @param {'receivable'|'payable'} direction
 * @returns {object} { allowed: boolean, reason: string|null }
 */
export async function isOpeningPositionAllowed(supabase, orgId, customerId, direction) {
  if (direction === 'receivable') {
    const [realInvoices, realPayments] = await Promise.all([
      hasRealTransaction(supabase, orgId, customerId, 'invoices'),
      hasRealTransaction(supabase, orgId, customerId, 'payments'),
    ]);
    if (realInvoices || realPayments) {
      return {
        allowed: false,
        reason: 'This customer already has invoices or payments, so an opening balance can only be set for a brand-new customer with no transaction history.',
      };
    }
    return { allowed: true, reason: null };
  }

  if (direction === 'payable') {
    const [realBills, realSupplierPayments] = await Promise.all([
      hasRealTransaction(supabase, orgId, customerId, 'purchase_bills'),
      hasRealTransaction(supabase, orgId, customerId, 'supplier_payments'),
    ]);
    if (realBills || realSupplierPayments) {
      return {
        allowed: false,
        reason: 'This entity already has purchase bills or payments made, so an opening balance can only be set for a brand-new entity with no transaction history.',
      };
    }
    return { allowed: true, reason: null };
  }

  return { allowed: false, reason: 'invalid_direction' };
}

/**
 * recordOpeningPosition() — entry point.
 *
 * @param {object} supabase  - Supabase client (service role)
 * @param {string} orgId     - organisation_id
 * @param {string} customerId - customers.id (single entity model — see
 *                              Finding 4/6 in AssistMe_Domain_Engine_Contracts.md;
 *                              "supplier" relationships are customers rows too)
 * @param {number} amount    - positive amount, the declared opening position
 * @param {'receivable'|'payable'} direction
 *   'receivable' = "they owe the owner" → OB invoice
 *   'payable'    = "the owner owes them" → OB purchase bill
 *
 * @returns {object} status: 'success' | 'partial_success' | 'failed',
 *   operation_id, events[], plus direction-specific fields.
 */
export async function recordOpeningPosition(supabase, orgId, customerId, amount, direction) {
  const start = Date.now();
  const operationId = randomUUID();

  console.log(`[recordOpeningPosition] start op=${operationId} customer=${customerId} amount=${amount} direction=${direction}`);

  try {
    if (!orgId || !customerId) {
      return { status: 'failed', operation_id: operationId, events: [], error: 'missing_org_or_customer' };
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return { status: 'failed', operation_id: operationId, events: [], error: 'invalid_amount' };
    }
    if (direction !== 'receivable' && direction !== 'payable') {
      return { status: 'failed', operation_id: operationId, events: [], error: 'invalid_direction' };
    }

    const result = direction === 'receivable'
      ? await recordReceivableOpeningPosition(supabase, orgId, customerId, amount, operationId)
      : await recordPayableOpeningPosition(supabase, orgId, customerId, amount, operationId);

    console.log(`[recordOpeningPosition] op=${operationId} complete in ${Date.now() - start}ms — status=${result.status}`);
    return result;

  } catch (err) {
    console.error(`[recordOpeningPosition] op=${operationId} unexpected error:`, err.message);
    return {
      status: 'failed',
      operation_id: operationId,
      events: [],
      error: 'server_error',
      message: err.message,
    };
  }
}
