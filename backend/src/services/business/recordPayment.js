/**
 * AssistMe — recordPayment() Domain Service
 * Location: /backend/src/services/business/recordPayment.js
 * Created: Session D, May 2026
 *
 * FIRST CANONICAL BUSINESS PRIMITIVE.
 * Called by every payment path. Never duplicated. Never bypassed.
 *
 * Callers:
 *   - POST /api/payments          (manual UI form — current dead route, now activated)
 *   - case 'record_payment'       (Spark AI execution in customer chat)
 *
 * NOT called by GPT directly. Deterministic tool only.
 * GPT reads results and narrates. It never writes financial data.
 *
 * Returns events[] — callers own ALL rendering, chat messages, notifications.
 * This function has zero UI awareness. Zero narration. Zero chat writes.
 * Owner acknowledgement messages are composed by callers from events data.
 *
 * Entity memory keys managed here:
 *   last_payment_amount   — most recent payment total (string)
 *   last_payment_date     — most recent payment date (YYYY-MM-DD)
 *   avg_payment_days      — rolling avg days from invoice issue to payment
 *                           (self-correcting, non-blocking, auto-populates)
 *
 * TODO (future, not blocking v1):
 *   - Move to Postgres RPC for true transaction atomicity
 *   - Derive outstanding_balance from invoices ledger, not mutable aggregate
 *   - Extract avg_payment_days to async analytics pipeline at scale
 *   - Idempotency: reject duplicate operation_id on payments table
 */

import { randomUUID } from 'crypto';

const istToday = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};

async function recalculateAvgPaymentDays(supabase, orgId, customerId) {
  try {
    const { data: payments } = await supabase
      .from('payments')
      .select('payment_date, invoice_id')
      .eq('organisation_id', orgId)
      .eq('customer_id', customerId)
      .eq('is_historical', false)
      .is('deleted_at', null)
      .order('payment_date', { ascending: false })
      .limit(10);

    if (!payments || payments.length === 0) return;

    const invoiceIds = payments.map(p => p.invoice_id).filter(Boolean);
    if (invoiceIds.length === 0) return;

    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, issue_date')
      .in('id', invoiceIds);

    if (!invoices || invoices.length === 0) return;

    const issueMap = {};
    for (const inv of invoices) issueMap[inv.id] = inv.issue_date;

    const gaps = [];
    for (const p of payments) {
      const issueDate = issueMap[p.invoice_id];
      if (!issueDate || !p.payment_date) continue;
      const diffDays = Math.round((new Date(p.payment_date) - new Date(issueDate)) / 86400000);
      if (diffDays >= 0) gaps.push(diffDays);
    }

    if (gaps.length === 0) return;

    const avg = Math.round(gaps.reduce((s, d) => s + d, 0) / gaps.length);

    await supabase.from('entity_memory').upsert({
      organisation_id: orgId,
      entity_type: 'customer',
      entity_id: customerId,
      memory_key: 'avg_payment_days',
      memory_value: String(avg),
      confidence: Math.min(1.0, gaps.length / 10),
    }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

  } catch (err) {
    console.warn('[recordPayment] avg_payment_days calc failed (non-fatal):', err.message);
  }
}

export async function resolveReminders(supabase, orgId, customerId, context = {}) {
  try {
    const { trigger = 'payment', invoicesPaidFull = [] } = context;

    if (trigger === 'payment' && invoicesPaidFull.length === 0) {
      return { resolved: 0, suggested: 0 };
    }

    const { data: tasks } = await supabase
      .from('tasks')
      .select('id, custom_fields')
      .eq('organisation_id', orgId)
      .eq('status', 'pending')
      .eq('entity_type', 'reminder')
      .eq('entity_id', customerId)
      .is('deleted_at', null);

    if (!tasks || tasks.length === 0) return { resolved: 0, suggested: 0 };

    const toResolve = [];
    let suggested = 0;

    for (const task of tasks) {
      const linkedInvoice = task.custom_fields?.invoice_id;
      if (linkedInvoice && invoicesPaidFull.includes(linkedInvoice)) {
        toResolve.push(task.id);
      } else if (!linkedInvoice) {
        suggested++;
      }
    }

    if (toResolve.length > 0) {
      await supabase
        .from('tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .in('id', toResolve)
        .eq('organisation_id', orgId);
    }

    return { resolved: toResolve.length, suggested };

  } catch (err) {
    console.warn('[resolveReminders] failed (non-fatal):', err.message);
    return { resolved: 0, suggested: 0 };
  }
}

export async function recordPayment(
  supabase, orgId, customerId, amount, paymentDate, paymentMethod = null, invoiceId = null
) {
  const start = Date.now();
  const operationId = randomUUID();
  const events = [];
  const invoicesPaidFull = [];

  console.log(`[recordPayment] start op=${operationId} customer=${customerId} amount=${amount} date=${paymentDate}`);

  try {
    if (!orgId || !customerId) return { status: 'failed', operation_id: operationId, events, error: 'missing_org_or_customer' };
    if (!amount || typeof amount !== 'number' || amount <= 0) return { status: 'failed', operation_id: operationId, events, error: 'invalid_amount' };

    const date = paymentDate || istToday();

    let invoicesToProcess = [];

    if (invoiceId) {
      const { data: inv, error: invFetchErr } = await supabase
        .from('invoices')
        .select('id, invoice_number, total_amount, amount_paid, amount_due, status')
        .eq('id', invoiceId)
        .eq('organisation_id', orgId)
        .eq('customer_id', customerId)
        .is('deleted_at', null)
        .maybeSingle();

      if (invFetchErr || !inv) return { status: 'failed', operation_id: operationId, events, error: 'invoice_not_found' };
      if (inv.status === 'paid') return { status: 'failed', operation_id: operationId, events, error: 'invoice_already_paid' };

      const maxPayable = Math.round((Number(inv.total_amount) - Number(inv.amount_paid)) * 100) / 100;
      if (amount > maxPayable + 0.01) {
        return { status: 'failed', operation_id: operationId, events, error: 'amount_exceeds_due', max_payable: maxPayable };
      }

      invoicesToProcess = [{ ...inv, allocate: amount }];

    } else {
      const { data: unpaid, error: unpaidErr } = await supabase
        .from('invoices')
        .select('id, invoice_number, total_amount, amount_paid, amount_due, status')
        .eq('organisation_id', orgId)
        .eq('customer_id', customerId)
        .eq('is_historical', false)
        .not('status', 'in', '("paid","cancelled","draft")')
        .is('deleted_at', null)
        .order('issue_date', { ascending: true });

      if (unpaidErr || !unpaid || unpaid.length === 0) {
        return { status: 'failed', operation_id: operationId, events, error: 'no_unpaid_invoices' };
      }

      let remaining = amount;
      for (const inv of unpaid) {
        if (remaining <= 0.01) break;
        const due = Math.round((Number(inv.total_amount) - Number(inv.amount_paid)) * 100) / 100;
        if (due <= 0) continue;
        const allocate = Math.round(Math.min(remaining, due) * 100) / 100;
        invoicesToProcess.push({ ...inv, allocate });
        remaining = Math.round((remaining - allocate) * 100) / 100;
      }

      if (invoicesToProcess.length === 0) {
        return { status: 'failed', operation_id: operationId, events, error: 'no_unpaid_invoices' };
      }
    }

    let totalApplied = 0;

    for (const inv of invoicesToProcess) {
      const newAmountPaid = Math.round((Number(inv.amount_paid) + inv.allocate) * 100) / 100;
      const newAmountDue = Math.round(Math.max(0, Number(inv.total_amount) - newAmountPaid) * 100) / 100;
      const newStatus = newAmountDue <= 0.01 ? 'paid' : 'partial';

      const { error: invErr } = await supabase
        .from('invoices')
        .update({ amount_paid: newAmountPaid, amount_due: newAmountDue, status: newStatus })
        .eq('id', inv.id)
        .eq('organisation_id', orgId);

      if (invErr) {
        console.error(`[recordPayment] op=${operationId} invoice update FAILED invoice=${inv.id}:`, invErr.message);
        return {
          status: events.length > 0 ? 'partial_success' : 'failed',
          operation_id: operationId,
          events,
          completed_steps: events.map(e => e.invoice_id),
          failed_step: 'invoice_update',
          failed_invoice_id: inv.id,
          error: 'invoice_update_failed',
        };
      }

      const { error: payErr } = await supabase
        .from('payments')
        .insert({
          organisation_id: orgId,
          customer_id: customerId,
          invoice_id: inv.id,
          amount: inv.allocate,
          payment_date: date,
          payment_method: paymentMethod || null,
          is_historical: false,
          import_metadata: { operation_id: operationId },
        });

      if (payErr) {
        console.error(`[recordPayment] op=${operationId} payments INSERT FAILED invoice=${inv.id}:`, payErr.message);
        return {
          status: 'partial_success',
          operation_id: operationId,
          events,
          completed_steps: events.map(e => e.invoice_id),
          failed_step: 'payments_insert',
          failed_invoice_id: inv.id,
          error: 'payment_insert_failed',
          reconciliation_note: `Invoice ${inv.id} updated but payment row not written. op=${operationId}`,
        };
      }

      totalApplied = Math.round((totalApplied + inv.allocate) * 100) / 100;
      if (newStatus === 'paid') invoicesPaidFull.push(inv.id);

      events.push({
        type: 'payment_recorded',
        operation_id: operationId,
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        amount_applied: inv.allocate,
        remaining_due: newAmountDue,
        invoice_status: newStatus,
        payment_date: date,
        payment_method: paymentMethod,
      });
    }

    const { data: cust } = await supabase
      .from('customers')
      .select('outstanding_balance')
      .eq('id', customerId)
      .eq('organisation_id', orgId)
      .maybeSingle();

    const currentBalance = Number(cust?.outstanding_balance || 0);
    const newBalance = Math.max(0, Math.round((currentBalance - totalApplied) * 100) / 100);

    const { error: balErr } = await supabase
      .from('customers')
      .update({ outstanding_balance: newBalance })
      .eq('id', customerId)
      .eq('organisation_id', orgId);

    if (balErr) {
      console.warn(`[recordPayment] op=${operationId} balance update failed (non-fatal):`, balErr.message);
    }

    const { resolved, suggested } = await resolveReminders(supabase, orgId, customerId, {
      trigger: 'payment',
      invoicesPaidFull,
    });

    if (resolved > 0) {
      events.push({ type: 'reminders_resolved', operation_id: operationId, count: resolved });
    }

    if (suggested > 0) {
      events.push({
        type: 'unlinked_reminders_pending',
        operation_id: operationId,
        count: suggested,
        message: `${suggested} reminder(s) may no longer be needed. Review and close manually.`,
      });
    }

    try {
      await supabase.from('entity_memory').upsert({
        organisation_id: orgId, entity_type: 'customer', entity_id: customerId,
        memory_key: 'last_payment_amount', memory_value: String(totalApplied), confidence: 1.0,
      }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

      await supabase.from('entity_memory').upsert({
        organisation_id: orgId, entity_type: 'customer', entity_id: customerId,
        memory_key: 'last_payment_date', memory_value: date, confidence: 1.0,
      }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });
    } catch (memErr) {
      console.warn(`[recordPayment] op=${operationId} entity_memory write failed (non-fatal):`, memErr.message);
    }

    recalculateAvgPaymentDays(supabase, orgId, customerId).catch(() => {});

    const partialEvents = events.filter(e => e.type === 'payment_recorded' && e.remaining_due > 0.01);
    if (partialEvents.length > 0) {
      let suggestedDays = 7;
      try {
        const { data: mem } = await supabase
          .from('entity_memory')
          .select('memory_value')
          .eq('organisation_id', orgId)
          .eq('entity_type', 'customer')
          .eq('entity_id', customerId)
          .eq('memory_key', 'avg_payment_days')
          .maybeSingle();
        if (mem?.memory_value) suggestedDays = Math.max(1, parseInt(mem.memory_value) || 7);
      } catch {}

      const totalRemaining = partialEvents.reduce((s, e) => s + e.remaining_due, 0);
      const suggestedDate = new Date(Date.now() + suggestedDays * 86400000).toISOString().split('T')[0];

      events.push({
        type: 'reminder_suggestion',
        operation_id: operationId,
        remaining_due: Math.round(totalRemaining * 100) / 100,
        suggested_days: suggestedDays,
        suggested_date: suggestedDate,
        invoice_ids: partialEvents.map(e => e.invoice_id),
      });
    }

    console.log(`[recordPayment] op=${operationId} complete in ${Date.now() - start}ms — ₹${totalApplied} across ${invoicesToProcess.length} invoice(s)`);

    return {
      status: 'success',
      operation_id: operationId,
      events,
      total_applied: totalApplied,
      new_balance: newBalance,
    };

  } catch (err) {
    console.error(`[recordPayment] op=${operationId} unexpected error:`, err.message);
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'server_error',
      message: err.message,
    };
  }
}
