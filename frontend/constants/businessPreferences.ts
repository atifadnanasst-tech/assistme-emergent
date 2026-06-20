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
  { value: 'reduced', label: 'Reduced', description: 'The default -- fewer pushes on weekends' },
  { value: 'pause', label: 'Pause', description: 'No pushes at all on weekends' },
];

export const REMINDER_ESCALATION_OPTIONS: OptionDef[] = [
  { value: 'notify_once', label: 'Notify once', description: 'The default -- one alert, no follow-up' },
  { value: 'daily_until_done', label: 'Daily until done', description: 'Keeps reminding every day until resolved' },
  { value: 'escalate_if_overdue', label: 'Escalate if overdue', description: 'Increasing urgency the longer it sits' },
];
