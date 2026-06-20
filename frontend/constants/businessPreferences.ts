// Mirrors SETTINGS_REGISTRY allowed_values in
// backend/src/services/settings/organisationSettings.js.
// Deliberate, documented duplication -- the backend remains canonical
// for validation (any value not in the registry is rejected at PATCH
// time regardless of what this file says). Replace with a fetched
// GET /api/organisations/settings/schema only if settings complexity
// grows materially -- see AssistMe_Reminders_Activity_Mentor_Build_Checklist.md
// for the documented trigger conditions.

export interface OptionDef {
  value: string;
  label: string;
  description: string;
}

export const ATTENTION_BUDGET_OPTIONS: OptionDef[] = [
  { value: 'minimal', label: 'Minimal', description: 'Daily Brief and critical alerts only' },
  { value: 'balanced', label: 'Balanced', description: 'The default -- everything Watch Engine produces' },
  { value: 'aggressive', label: 'Aggressive', description: 'Includes proactive Mentor nudges and growth opportunities' },
];

export const PUSH_FREQUENCY_OPTIONS: OptionDef[] = [
  { value: 'low', label: 'Low', description: 'Fewer interruptions, more batching' },
  { value: 'normal', label: 'Normal', description: 'The default' },
  { value: 'high', label: 'High', description: 'More frequent updates' },
];

export const WEEKEND_BEHAVIOR_OPTIONS: OptionDef[] = [
  { value: 'normal', label: 'Normal', description: 'Same as weekdays' },
  { value: 'reduced', label: 'Reduced', description: 'The default -- saved now, takes effect once notification scheduling is built' },
  { value: 'pause', label: 'Pause', description: 'Saved now, takes effect once notification scheduling is built' },
];

export const REMINDER_ESCALATION_OPTIONS: OptionDef[] = [
  { value: 'notify_once', label: 'Notify once', description: 'The default -- one alert, no follow-up' },
  { value: 'daily_until_done', label: 'Daily until done', description: 'Keeps reminding every day until resolved' },
  { value: 'escalate_if_overdue', label: 'Escalate if overdue', description: 'Increasing urgency the longer it sits' },
];

// Mirrors PRIORITY_AREA_CATALOG (the values) in organisationSettings.js.
// Labels/descriptions are presentation-only and have no backend counterpart --
// the backend only knows and validates the value strings.
export const PRIORITY_AREA_OPTIONS: OptionDef[] = [
  { value: 'collections', label: 'Collections', description: 'Getting paid on time' },
  { value: 'sales_growth', label: 'Sales Growth', description: 'Growing revenue' },
  { value: 'new_customer_acquisition', label: 'New Customer Acquisition', description: 'Bringing in new business' },
  { value: 'customer_retention', label: 'Customer Retention', description: 'Keeping existing customers active' },
  { value: 'inventory_health', label: 'Inventory Health', description: 'Stock levels and movement' },
  { value: 'vendor_supplier_payments', label: 'Vendor & Supplier Payments', description: 'Paying what you owe, on time' },
  { value: 'cash_flow', label: 'Cash Flow', description: 'Money in vs money out' },
  { value: 'profitability', label: 'Profitability', description: 'Margins, not just revenue' },
  { value: 'delivery_operations', label: 'Delivery & Operations', description: 'Getting goods to customers' },
  { value: 'team_management', label: 'Team Management', description: 'Staff productivity and workload' },
];
