/**
 * AssistMe — recordSupplierPayment() Domain Service
 * Location: /backend/src/services/business/recordSupplierPayment.js
 * Created: Session F, May 2026
 *
 * THIRD CANONICAL BUSINESS PRIMITIVE (mirrors recordPayment.js pattern exactly).
 * Called by every outgoing payment path. Never duplicated. Never bypassed.
 *
 * Callers (present and future):
 *   - POST /api/supplier-payments       (manual UI — RecordPaymentSheet)
 *   - case 'record_supplier_payment'    (Spark AI execution in entity chat)
 *
 * NOT called by GPT directly. Deterministic tool only.
 * GPT extracts intent and parameters. This function executes. Never the reverse.
 *
 * ENTITY MODEL:
 *   All entities live in the customers table. customer_id is the single identity.
 *   supplier_payments.supplier_id (legacy column) is null for all new payments.
 *   supplier_payments.customer_id (new column) is used for all new payments.
 *
 * PAYMENT DIRECTION:
 *   This primitive handles OUTGOING payments only — money leaving our bank.
 *   Incoming payments (customers paying us) use recordPayment.js exclusively.
 *   Direction is always: our bank → entity (debit to us, credit to them).
 *
 * FIFO ALLOCATION:
 *   Without a specific bill_id: allocates against oldest unpaid purchase_bills
 *   first (ascending issue_date). Same FIFO logic as recordPayment.js.
 *   With a specific bill_id: applies entire amount to that bill only.
 *
 * OVERPAYMENT:
 *   FIFO path rejects if amount exceeds total outstanding across all bills.
 *   Returns error: 'amount_exceeds_total_due' with total_due and unallocated_amount.
 *   Specific-bill path rejects if amount exceeds that bill's remaining due.
 *
 * BANK TRANSACTION:
 *   Writes bank_transactions row with type='debit' when bank_account_id provided.
 *   No bank write if bank_account_id is null — payment recorded but unreconciled.
 *   This matches recordPayment.js behaviour exactly.
 *
 * V1 KNOWN DEBT (matches recordPayment.js and recordPurchaseBill.js):
 *   No Postgres transaction wrapping. Partial failure leaves payment written
 *   but purchase_bill potentially not updated. Documented for Phase 2 hardening.
 *
 * Returns events[] — callers own ALL rendering, chat messages, notifications.
 * Zero UI awareness. Zero narration. Zero chat writes.
 *
 * Entity memory keys managed here:
 *   last_supplier_payment_date   — most recent payment date (YYYY-MM-DD)
 *   last_supplier_payment_amount — most recent payment amount (string)
 */

import { randomUUID } from 'crypto';

const istToday = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};

export async function recordSupplierPayment(supabase, orgId, customerId, amount, opts = {}) {
  const start = Date.now();
  const operationId = randomUUID();
  const events = [];

  console.log(`[recordSupplierPayment] start op=${operationId} entity=${customerId} amount=${amount}`);

  try {
    if (!orgId || !customerId) {
      return { status: 'failed', operation_id: operationId, events, error: 'missing_org_or_entity' };
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return { status: 'failed', operation_id: operationId, events, error: 'invalid_amount' };
    }

    const date = opts.paymentDate || istToday();
    const paymentMethod = opts.paymentMethod || null;
    const billId = opts.billId || null;
    const bankAccountId = opts.bankAccountId || null;

    const { data: entity, error: entityErr } = await supabase
      .from('customers')
      .select('id, name')
      .eq('id', customerId)
      .eq('organisation_id', orgId)
      .is('deleted_at', null)
      .maybeSingle();

    if (entityErr || !entity) {
      return { status: 'failed', operation_id: operationId, events, error: 'entity_not_found' };
    }

    let billsToProcess = [];

    if (billId) {
      const { data: bill, error: billFetchErr } = await supabase
        .from('purchase_bills')
        .select('id, bill_number, total_amount, amount_paid, amount_due, status')
        .eq('id', billId)
        .eq('organisation_id', orgId)
        .eq('customer_id', customerId)
        .is('deleted_at', null)
        .maybeSingle();

      if (billFetchErr || !bill) {
        return { status: 'failed', operation_id: operationId, events, error: 'bill_not_found' };
      }
      if (bill.status === 'paid') {
        return { status: 'failed', operation_id: operationId, events, error: 'bill_already_paid' };
      }

      const maxPayable = Math.round((Number(bill.total_amount) - Number(bill.amount_paid)) * 100) / 100;
      if (amount > maxPayable + 0.01) {
        return { status: 'failed', operation_id: operationId, events, error: 'amount_exceeds_due', max_payable: maxPayable };
      }

      billsToProcess = [{ ...bill, allocate: amount }];

    } else {
      const { data: unpaid, error: unpaidErr } = await supabase
        .from('purchase_bills')
        .select('id, bill_number, total_amount, amount_paid, amount_due, status')
        .eq('organisation_id', orgId)
        .eq('customer_id', customerId)
        .eq('is_historical', false)
        .not('status', 'in', '("paid","cancelled")')
        .is('deleted_at', null)
        .order('issue_date', { ascending: true });

      if (unpaidErr || !unpaid || unpaid.length === 0) {
        return { status: 'failed', operation_id: operationId, events, error: 'no_unpaid_bills' };
      }

      const totalAllocatable = unpaid.reduce((s, b) => {
        return Math.round((s + Math.round((Number(b.total_amount) - Number(b.amount_paid)) * 100) / 100) * 100) / 100;
      }, 0);

      if (amount > totalAllocatable + 0.01) {
        return {
          status: 'failed',
          operation_id: operationId,
          events,
          error: 'amount_exceeds_total_due',
          total_due: totalAllocatable,
          unallocated_amount: Math.round((amount - totalAllocatable) * 100) / 100,
        };
      }

      let remaining = amount;
      for (const bill of unpaid) {
        if (remaining <= 0.01) break;
        const due = Math.round((Number(bill.total_amount) - Number(bill.amount_paid)) * 100) / 100;
        if (due <= 0) continue;
        const allocate = Math.round(Math.min(remaining, due) * 100) / 100;
        billsToProcess.push({ ...bill, allocate });
        remaining = Math.round((remaining - allocate) * 100) / 100;
      }

      if (billsToProcess.length === 0) {
        return { status: 'failed', operation_id: operationId, events, error: 'no_unpaid_bills' };
      }
    }

    let totalApplied = 0;
    const billsPaidFull = [];

    for (const bill of billsToProcess) {
      const newAmountPaid = Math.round((Number(bill.amount_paid) + bill.allocate) * 100) / 100;
      const newAmountDue = Math.round(Math.max(0, Number(bill.total_amount) - newAmountPaid) * 100) / 100;
      const newStatus = newAmountDue <= 0.01 ? 'paid' : 'partial';

      const { error: billErr } = await supabase
        .from('purchase_bills')
        .update({ amount_paid: newAmountPaid, amount_due: newAmountDue, status: newStatus })
        .eq('id', bill.id)
        .eq('organisation_id', orgId);

      if (billErr) {
        console.error(`[recordSupplierPayment] op=${operationId} bill update FAILED bill=${bill.id}:`, billErr.message);
        return {
          status: events.length > 0 ? 'partial_success' : 'failed',
          operation_id: operationId,
          events,
          completed_steps: events.map(e => e.bill_id),
          failed_step: 'bill_update',
          failed_bill_id: bill.id,
          error: 'bill_update_failed',
        };
      }

      const { error: spErr } = await supabase
        .from('supplier_payments')
        .insert({
          organisation_id: orgId,
          customer_id: customerId,
          supplier_id: null,
          bill_id: bill.id,
          amount: bill.allocate,
          payment_date: date,
          payment_method: paymentMethod,
          notes: opts.notes || null,
          bank_account_id: bankAccountId || null,
        });

      if (spErr) {
        console.error(`[recordSupplierPayment] op=${operationId} supplier_payments INSERT FAILED:`, spErr.message);
        return {
          status: 'partial_success',
          operation_id: operationId,
          events,
          completed_steps: events.map(e => e.bill_id),
          failed_step: 'supplier_payments_insert',
          failed_bill_id: bill.id,
          error: 'payment_insert_failed',
          reconciliation_note: `Bill ${bill.id} updated but payment row not written. op=${operationId}`,
        };
      }

      totalApplied = Math.round((totalApplied + bill.allocate) * 100) / 100;
      if (newStatus === 'paid') billsPaidFull.push(bill.id);

      events.push({
        type: 'supplier_payment_recorded',
        operation_id: operationId,
        bill_id: bill.id,
        bill_number: bill.bill_number,
        amount_applied: bill.allocate,
        remaining_due: newAmountDue,
        bill_status: newStatus,
        payment_date: date,
        payment_method: paymentMethod,
        entity_name: entity.name,
      });
    }

    if (bankAccountId && totalApplied > 0) {
      try {
        await supabase.from('bank_transactions').insert({
          organisation_id: orgId,
          bank_account_id: bankAccountId,
          type: 'debit',
          amount: totalApplied,
          currency: 'INR',
          description: `Payment to ${entity.name}`,
          transaction_date: date,
          reference: billsToProcess.length === 1
            ? billsToProcess[0].bill_number
            : `MULTI-${operationId.slice(0, 8)}`,
          reference_type: billsToProcess.length === 1 ? 'purchase_bill' : 'multi_bill_payment',
          reference_id: billsToProcess.length === 1 ? billsToProcess[0].id : null,
        });

        events.push({
          type: 'bank_debited',
          operation_id: operationId,
          bank_account_id: bankAccountId,
          amount: totalApplied,
        });
      } catch (btErr) {
        console.warn('[recordSupplierPayment] bank_transactions write failed (non-fatal):', btErr.message);
      }
    }

    try {
      await supabase.from('entity_memory').upsert({
        organisation_id: orgId,
        entity_type: 'customer',
        entity_id: customerId,
        memory_key: 'last_supplier_payment_date',
        memory_value: date,
        confidence: 1.0,
      }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

      await supabase.from('entity_memory').upsert({
        organisation_id: orgId,
        entity_type: 'customer',
        entity_id: customerId,
        memory_key: 'last_supplier_payment_amount',
        memory_value: String(totalApplied),
        confidence: 1.0,
      }, { onConflict: 'organisation_id,entity_type,entity_id,memory_key' });

    } catch (memErr) {
      console.warn('[recordSupplierPayment] entity_memory write failed (non-fatal):', memErr.message);
    }

    console.log(`[recordSupplierPayment] op=${operationId} complete in ${Date.now() - start}ms — INR ${totalApplied} across ${billsToProcess.length} bill(s)`);

    return {
      status: 'success',
      operation_id: operationId,
      events,
      total_applied: totalApplied,
      bills_affected: billsToProcess.length,
      bills_paid_full: billsPaidFull,
      entity_name: entity.name,
    };

  } catch (err) {
    console.error(`[recordSupplierPayment] op=${operationId} unexpected error:`, err.message);
    return {
      status: 'failed',
      operation_id: operationId,
      events,
      error: 'server_error',
      message: err.message,
    };
  }
}
