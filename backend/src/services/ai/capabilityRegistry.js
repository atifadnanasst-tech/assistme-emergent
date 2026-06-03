/**
 * AssistMe — Capability Registry
 *
 * Location: /backend/src/services/ai/capabilityRegistry.js
 * Created: Session I-A, Jun 2026
 *
 * AUTHORITY: Code is source of truth. DB never governs what capabilities exist.
 * FIRST-PERSON RULE: "meri products" / "mera customer" always resolve to current org via JWT.
 * CAPABILITY DISCIPLINE: ~20-35 business capabilities. Never expand to leaf actions.
 */

export const CAPABILITY_REGISTRY = {

  query_daily_summary: {
    version: 1,
    description: 'Business snapshot: payments received today, overdue invoices, draft quotes.',
    confirmation: 'never',
    scope: ['org', 'finance'],
    is_financial: false,
    middleware_fn: 'getDailySummary',
    suggested_next_actions: ['query_overdue_payments', 'query_collection_insights'],
  },

  query_overdue_payments: {
    version: 1,
    description: 'All overdue invoices with customer name, amount due, days overdue. Use for "overdue", "kaun paise nahi diya", "baaki kiska hai".',
    confirmation: 'never',
    scope: ['org', 'finance', 'customers'],
    is_financial: false,
    middleware_fn: 'getOverduePayments',
    suggested_next_actions: ['send_payment_reminder'],
  },

  query_customers: {
    version: 1,
    description: 'Search or list customers by name, tag, or outstanding balance.',
    confirmation: 'never',
    scope: ['org', 'customers'],
    is_financial: false,
    middleware_fn: 'searchCustomers',
    suggested_next_actions: ['query_overdue_payments', 'mutate_customer'],
  },

  query_collection_insights: {
    version: 1,
    description: 'Collection efficiency: total outstanding, collected this week.',
    confirmation: 'never',
    scope: ['org', 'finance'],
    is_financial: false,
    middleware_fn: 'getCollectionInsights',
    suggested_next_actions: ['query_overdue_payments', 'send_payment_reminder'],
  },

  query_bank_summary: {
    version: 1,
    description: 'Bank account balances and total cash position.',
    confirmation: 'never',
    scope: ['org', 'finance'],
    is_financial: false,
    middleware_fn: 'getBankSummary',
    suggested_next_actions: ['query_daily_summary'],
  },

  query_inventory: {
    version: 1,
    description: 'Products at or below reorder point. Use for "low stock", "kya khatam ho raha hai".',
    confirmation: 'never',
    scope: ['org', 'ops', 'procurement', 'products'],
    is_financial: false,
    middleware_fn: 'getInventoryStatus',
    suggested_next_actions: ['mutate_inventory', 'query_suppliers'],
  },

  query_top_products: {
    version: 1,
    description: 'Top-selling products by revenue or quantity. Use for "sabse zyada bikne wala", "best seller".',
    confirmation: 'never',
    scope: ['org', 'products'],
    is_financial: false,
    middleware_fn: 'getTopProducts',
    suggested_next_actions: ['mutate_product', 'query_inventory'],
  },

  query_invoices: {
    version: 1,
    description: 'List or search invoices by status, customer, or date range.',
    confirmation: 'never',
    scope: ['org', 'finance'],
    is_financial: false,
    middleware_fn: 'getInvoices',
    suggested_next_actions: ['mutate_payment', 'send_payment_reminder'],
  },

  query_tasks: {
    version: 1,
    description: 'List pending or completed tasks.',
    confirmation: 'never',
    scope: ['org', 'ops'],
    is_financial: false,
    middleware_fn: 'getTasks',
    suggested_next_actions: ['mutate_task', 'set_reminder'],
  },

  query_suppliers: {
    version: 1,
    description: 'List suppliers, outstanding payables, or top suppliers.',
    confirmation: 'never',
    scope: ['org', 'procurement'],
    is_financial: false,
    middleware_fn: 'getSuppliers',
    suggested_next_actions: ['mutate_supplier', 'mutate_inventory'],
  },

  mutate_product: {
    version: 1,
    description: 'Create, update, archive, or bulk-update products. Handles price changes, category updates. Use for "product add karo", "price badha do", "attar category ka price 10% badha do".',
    confirmation: 'always',
    scope: ['org', 'products'],
    is_financial: false,
    middleware_fn: 'mutateProduct',
    suggested_next_actions: ['generate_document', 'query_top_products', 'query_inventory'],
  },

  mutate_inventory: {
    version: 1,
    description: 'Adjust stock quantity for one or more products.',
    confirmation: 'always',
    scope: ['org', 'ops', 'procurement', 'products'],
    is_financial: false,
    middleware_fn: 'mutateInventory',
    suggested_next_actions: ['query_inventory', 'query_suppliers'],
  },

  mutate_task: {
    version: 1,
    description: 'Create, update, complete, or cancel a task.',
    confirmation: 'preview',
    scope: ['org', 'ops'],
    is_financial: false,
    middleware_fn: 'mutateTask',
    suggested_next_actions: ['query_tasks'],
  },

  mutate_customer: {
    version: 1,
    description: 'Create or update a customer profile: name, phone, address, credit limit.',
    confirmation: 'always',
    scope: ['org', 'customers'],
    is_financial: false,
    middleware_fn: 'mutateCustomer',
    suggested_next_actions: ['query_customers', 'query_overdue_payments'],
  },

  mutate_invoice: {
    version: 1,
    description: 'Create, edit, cancel, or duplicate an invoice. Does NOT record payments — use mutate_payment for that.',
    confirmation: 'always',
    scope: ['org', 'finance'],
    is_financial: true,
    middleware_fn: 'mutateInvoice',
    suggested_next_actions: ['mutate_payment', 'send_payment_reminder', 'generate_document'],
  },

  mutate_quotation: {
    version: 1,
    description: 'Create, edit, send, or convert a quotation to invoice.',
    confirmation: 'always',
    scope: ['org', 'finance'],
    is_financial: true,
    middleware_fn: 'mutateQuotation',
    suggested_next_actions: ['mutate_invoice', 'generate_document'],
  },

  mutate_payment: {
    version: 1,
    description: 'Record payment received, mark invoice paid, record partial payment. Use for "payment aayi", "ABC ne paisa diya", "mark paid".',
    confirmation: 'always',
    scope: ['org', 'finance'],
    is_financial: true,
    middleware_fn: 'mutatePayment',
    suggested_next_actions: ['query_collection_insights', 'query_overdue_payments'],
  },

  mutate_expense: {
    version: 1,
    description: 'Log a business expense with category, amount, date.',
    confirmation: 'always',
    scope: ['org', 'finance'],
    is_financial: true,
    middleware_fn: 'mutateExpense',
    suggested_next_actions: ['query_bank_summary'],
  },

  mutate_supplier: {
    version: 1,
    description: 'Create or update a supplier profile.',
    confirmation: 'preview',
    scope: ['org', 'procurement'],
    is_financial: false,
    middleware_fn: 'mutateSupplier',
    suggested_next_actions: ['query_suppliers'],
  },

  mutate_tags: {
    version: 1,
    description: 'Add or remove tags on customers or products. Use for "VIP tag lagao", "ABC ko regular mark karo".',
    confirmation: 'never',
    scope: ['org', 'customers', 'products'],
    is_financial: false,
    middleware_fn: 'mutateTags',
    suggested_next_actions: ['query_customers'],
  },

  send_payment_reminder: {
    version: 1,
    description: 'Send payment reminder to customers with outstanding invoices. Use for "reminder bhejo", "ABC ko payment ke liye message karo".',
    confirmation: 'always',
    scope: ['org', 'finance', 'customers'],
    is_financial: false,
    middleware_fn: 'sendPaymentReminder',
    suggested_next_actions: ['query_overdue_payments'],
  },

  generate_document: {
    version: 1,
    description: 'Generate a PDF: invoice, quote, or product catalog. Use for "catalog banao", "invoice PDF nikalo".',
    confirmation: 'never',
    scope: ['org', 'finance', 'products'],
    is_financial: false,
    middleware_fn: 'generateDocument',
    suggested_next_actions: [],
  },

  set_reminder: {
    version: 1,
    description: 'Set a time-based reminder for a task or follow-up. Use for "kal remind karna", "Monday ko ABC ke liye reminder".',
    confirmation: 'preview',
    scope: ['org', 'ops'],
    is_financial: false,
    middleware_fn: 'setReminder',
    suggested_next_actions: ['query_tasks'],
  },
};

export function getCapabilitiesForScope(scope = 'org') {
  return Object.entries(CAPABILITY_REGISTRY)
    .filter(([, def]) => def.scope.includes('org') || def.scope.includes(scope))
    .map(([name, def]) => ({
      name,
      description: def.description,
      confirmation: def.confirmation,
    }));
}

export function getCapability(name) {
  return CAPABILITY_REGISTRY[name] || null;
}

export function getSuggestedNextActions(capabilityName) {
  return CAPABILITY_REGISTRY[capabilityName]?.suggested_next_actions || [];
}

export function requiresFullConfirmation(capabilityName) {
  const cap = CAPABILITY_REGISTRY[capabilityName];
  if (!cap) return true;
  if (cap.is_financial) return true;
  return cap.confirmation === 'always';
}
