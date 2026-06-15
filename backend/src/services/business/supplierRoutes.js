/**
 * AssistMe — Supplier Routes
 *
 * Location: /backend/src/services/business/supplierRoutes.js
 * Created: Session F, May 2026
 *
 * ENTITY MODEL:
 *   All entities live in the customers table. customer_id is the single identity.
 *   "Supplier" describes the relationship direction, not a separate table.
 *   See ASSISTME_ENTITY_ARCHITECTURE_DOCTRINE.md
 *
 * LEGACY NOTE:
 *   orgAi/index.js lowStock function still reads from the suppliers table
 *   via supplier_products.supplier_id. This is the old path for entities
 *   predating the entity model. It coexists safely — no conflict.
 *   Migration path: when supplier_products gains a customer_id column,
 *   lowStock will be updated to join customers instead. Not blocking v1.
 *
 * Routes registered here:
 *   GET  /api/suppliers              — list entities with purchase bills + payable balance
 *   GET  /api/suppliers/:id          — entity profile + purchase-side stats + net position
 *   PATCH /api/suppliers/:id         — update name, phone, payment_terms_days, notes, company
 *   POST /api/purchase-bills         — create purchase bill (calls recordPurchaseBill primitive)
 *   GET  /api/purchase-bills         — list purchase bills for an entity
 *   POST /api/supplier-payments      — record outgoing payment (calls recordSupplierPayment primitive)
 *
 * Registration:
 *   import { registerSupplierRoutes } from './services/business/supplierRoutes.js';
 *   registerSupplierRoutes(app, supabase, authenticateChat);
 *
 * Dependencies passed in (never imported as globals):
 *   app              — Hono app instance
 *   supabase         — Supabase client
 *   authenticateChat — auth helper, same as all other routes
 *
 * PHONE NORMALIZATION:
 *   India-specific (v1). 10-digit numbers prefixed with 91.
 *   Mirrors POST /api/customers pattern exactly. Intentional for AssistMe v1.
 *
 * PAYMENT TERMS:
 *   Clamped 1-365 days. Invalid values default to 30.
 */

import { recordPurchaseBill } from './recordPurchaseBill.js';
import { recordSupplierPayment } from './recordSupplierPayment.js';

export function registerSupplierRoutes(app, supabase, authenticateChat) {

  app.get('/api/suppliers', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const { data: bills, error: billsErr } = await supabase
        .from('purchase_bills')
        .select('customer_id, amount_due, total_amount, issue_date')
        .eq('organisation_id', organisationId)
        .eq('is_historical', false)
        .is('deleted_at', null)
        .not('customer_id', 'is', null);

      if (billsErr) {
        console.error('[GET /api/suppliers] bills query error:', billsErr.message);
        return c.json({ error: 'server_error' }, 500);
      }

      if (!bills || bills.length === 0) {
        return c.json({ suppliers: [] });
      }

      const aggregates = {};
      for (const bill of bills) {
        const cid = bill.customer_id;
        if (!aggregates[cid]) {
          aggregates[cid] = { payable_balance: 0, total_purchased: 0, last_bill_date: null };
        }
        aggregates[cid].payable_balance = Math.round((aggregates[cid].payable_balance + Number(bill.amount_due)) * 100) / 100;
        aggregates[cid].total_purchased = Math.round((aggregates[cid].total_purchased + Number(bill.total_amount)) * 100) / 100;
        if (!aggregates[cid].last_bill_date || bill.issue_date > aggregates[cid].last_bill_date) {
          aggregates[cid].last_bill_date = bill.issue_date;
        }
      }

      const customerIds = Object.keys(aggregates);

      const { data: customers, error: custErr } = await supabase
        .from('customers')
        .select('id, name, phone, payment_terms_days, custom_fields')
        .in('id', customerIds)
        .eq('organisation_id', organisationId)
        .is('deleted_at', null);

      if (custErr) {
        console.error('[GET /api/suppliers] customers query error:', custErr.message);
        return c.json({ error: 'server_error' }, 500);
      }

      const suppliers = (customers || []).map(cust => {
        const agg = aggregates[cust.id] || {};
        const avatarColor = cust.custom_fields?.avatar_color || '#075E54';
        const nameParts = (cust.name || '').trim().split(/\s+/);
        const initials = nameParts.slice(0, 2).map(p => p[0]).join('').toUpperCase();
        return {
          customer_id: cust.id,
          name: cust.name,
          phone: cust.phone,
          initials,
          avatar_color: avatarColor,
          payment_terms_days: cust.payment_terms_days || 30,
          payable_balance: agg.payable_balance || 0,
          total_purchased: agg.total_purchased || 0,
          last_bill_date: agg.last_bill_date || null,
        };
      });

      suppliers.sort((a, b) => b.payable_balance - a.payable_balance);

      return c.json({ suppliers });
    } catch (err) {
      console.error('[GET /api/suppliers] error:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.get('/api/suppliers/:id', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;
      const entityId = c.req.param('id');

      const { data: entity, error: entityErr } = await supabase
        .from('customers')
        .select('id, name, phone, company, payment_terms_days, notes, outstanding_balance, custom_fields')
        .eq('id', entityId)
        .eq('organisation_id', organisationId)
        .is('deleted_at', null)
        .maybeSingle();

      if (entityErr || !entity) return c.json({ error: 'entity_not_found' }, 404);

      const { data: bills } = await supabase
        .from('purchase_bills')
        .select('total_amount, amount_due, amount_paid, status, issue_date, due_date')
        .eq('organisation_id', organisationId)
        .eq('customer_id', entityId)
        .eq('is_historical', false)
        .is('deleted_at', null)
        .order('issue_date', { ascending: false });

      const allBills = bills || [];
      const totalPurchased = allBills.reduce((s, b) => s + Number(b.total_amount), 0);
      const payableBalance = allBills.reduce((s, b) => s + Number(b.amount_due), 0);
      const billCount = allBills.length;
      const avgBillValue = billCount > 0 ? Math.round((totalPurchased / billCount) * 100) / 100 : null;
      const lastBillDate = allBills.length > 0 ? allBills[0].issue_date : null;
      const today = new Date().toISOString().split('T')[0];
      const overdueBills = allBills.filter(b => b.due_date && b.due_date < today && b.status !== 'paid');
      const netPosition = Math.round((Number(entity.outstanding_balance) - payableBalance) * 100) / 100;

      return c.json({
        customer_id: entity.id,
        name: entity.name,
        phone: entity.phone,
        company: entity.company,
        payment_terms_days: entity.payment_terms_days || 30,
        notes: entity.notes,
        avatar_color: entity.custom_fields?.avatar_color || '#075E54',
        purchase_side: {
          bill_count: billCount,
          total_purchased: Math.round(totalPurchased * 100) / 100,
          payable_balance: Math.round(payableBalance * 100) / 100,
          avg_bill_value: avgBillValue,
          last_bill_date: lastBillDate,
          overdue_bill_count: overdueBills.length,
        },
        sales_side: {
          outstanding_receivable: Number(entity.outstanding_balance),
        },
        net_position: netPosition,
      });
    } catch (err) {
      console.error('[GET /api/suppliers/:id] error:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.patch('/api/suppliers/:id', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;
      const entityId = c.req.param('id');

      const { data: entity } = await supabase
        .from('customers')
        .select('id')
        .eq('id', entityId)
        .eq('organisation_id', organisationId)
        .is('deleted_at', null)
        .maybeSingle();

      if (!entity) return c.json({ error: 'entity_not_found' }, 404);

      const body = await c.req.json().catch(() => ({}));
      const updates = {};

      if (body.name !== undefined) updates.name = body.name.trim();
      if (body.phone !== undefined) {
        let normalizedPhone = String(body.phone).replace(/\D/g, '');
        if (normalizedPhone.length === 10) normalizedPhone = '91' + normalizedPhone;
        updates.phone = normalizedPhone;
      }
      if (body.payment_terms_days !== undefined) {
        const terms = Number(body.payment_terms_days);
        updates.payment_terms_days = (terms > 0 && terms <= 365) ? terms : 30;
      }
      if (body.notes !== undefined) updates.notes = body.notes;
      if (body.company !== undefined) updates.company = body.company;

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'no_fields_to_update' }, 400);
      }

      const { error: updateErr } = await supabase
        .from('customers')
        .update(updates)
        .eq('id', entityId)
        .eq('organisation_id', organisationId);

      if (updateErr) {
        console.error('[PATCH /api/suppliers/:id] update error:', updateErr.message);
        return c.json({ error: 'server_error' }, 500);
      }

      console.log('[PATCH /api/suppliers/:id] Updated entity:', entityId);
      return c.json({ success: true });
    } catch (err) {
      console.error('[PATCH /api/suppliers/:id] error:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.post('/api/purchase-bills', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json().catch(() => ({}));
      const { customer_id, items, issue_date, due_date, bill_number, supplier_bill_number, notes } = body;

      if (!customer_id) return c.json({ error: 'validation', message: 'customer_id is required' }, 400);
      if (!items || !Array.isArray(items) || items.length === 0) return c.json({ error: 'validation', message: 'items are required' }, 400);

      const result = await recordPurchaseBill(supabase, organisationId, customer_id, items, {
        issueDate: issue_date,
        dueDate: due_date,
        billNumber: bill_number,
        supplierBillNumber: supplier_bill_number,
        notes,
      });

      if (result.status === 'failed') {
        return c.json({ error: result.error, message: result.message }, 400);
      }

      return c.json(result, 201);
    } catch (err) {
      console.error('[POST /api/purchase-bills] error:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.get('/api/purchase-bills', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const customerId = c.req.query('customer_id');
      if (!customerId) return c.json({ error: 'customer_id query param required' }, 400);

      const limit = parseInt(c.req.query('limit') || '20', 10);

      // Opening Position Transactions (historical_source='opening_balance')
      // excluded -- onboarding records, not real purchase bills. See
      // AssistMe_Financial_Calculation_Rules.md -> "Opening Position Rules"
      const { data: bills, error: billsErr } = await supabase
        .from('purchase_bills')
        .select('id, bill_number, supplier_bill_number, status, issue_date, due_date, total_amount, amount_paid, amount_due, currency, notes')
        .eq('organisation_id', organisationId)
        .eq('customer_id', customerId)
        .eq('is_historical', false)
        .or('historical_source.is.null,historical_source.neq.opening_balance')
        .is('deleted_at', null)
        .order('issue_date', { ascending: false })
        .limit(limit);

      if (billsErr) return c.json({ error: 'server_error' }, 500);

      return c.json({ bills: bills || [] });
    } catch (err) {
      console.error('[GET /api/purchase-bills] error:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.post('/api/supplier-payments', async (c) => {
    try {
      const auth = await authenticateChat(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const { organisationId } = auth;

      const body = await c.req.json().catch(() => ({}));
      const { customer_id, amount, payment_date, payment_method, bill_id, bank_account_id, notes } = body;

      if (!customer_id) return c.json({ error: 'validation', message: 'customer_id is required' }, 400);
      if (!amount || typeof amount !== 'number' || amount <= 0) return c.json({ error: 'validation', message: 'Valid amount is required' }, 400);

      const result = await recordSupplierPayment(supabase, organisationId, customer_id, amount, {
        paymentDate: payment_date,
        paymentMethod: payment_method,
        billId: bill_id,
        bankAccountId: bank_account_id,
        notes,
      });

      if (result.status === 'failed') {
        return c.json({ error: result.error, total_due: result.total_due, max_payable: result.max_payable }, 400);
      }

      return c.json(result, 201);
    } catch (err) {
      console.error('[POST /api/supplier-payments] error:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  });

}
