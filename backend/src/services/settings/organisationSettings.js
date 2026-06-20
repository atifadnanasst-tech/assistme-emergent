/**
 * AssistMe — Organisation Settings Service
 * Location: /backend/src/services/settings/organisationSettings.js
 * Created: Reminders/Activity/Mentor workstream, Batch A.1, Jun 2026
 *
 * Single source of truth for Business Preferences. Every consumer --
 * settings routes today; future Watch Engine, Daily Brief, Mentor, and
 * Onboarding -- must call getOrganisationSettings() rather than reading
 * organisations.settings directly. Default generation, deep-merge, and
 * validation logic live in exactly one place.
 *
 * SETTINGS_REGISTRY is authoritative: who can edit a setting, what
 * values are allowed, and which subscription tier it requires (tier is
 * metadata only -- not enforced anywhere yet, Phase 3 territory). Any
 * settings path NOT in the registry is rejected, not silently allowed.
 *
 * Locked design decisions (see Batch A architecture discussion):
 * - organisations.settings holds ORG-WIDE preferences only. Per-user
 *   preferences (e.g. Spark hint dismissal) are device-local and never
 *   touch this table.
 * - Defaults are never persisted to the database. GET always returns
 *   defaults merged with whatever has actually been saved -- the row
 *   may not exist at all and the owner should never see a null.
 * - Defaults are industry-aware when organisations.industry is set,
 *   falling back to a generic default otherwise.
 * - PATCH is a true recursive deep merge, applied onto the currently
 *   SAVED settings (not onto the full default object) -- only real
 *   overrides are ever persisted.
 * - Onboarding/milestone progress does NOT live here -- that gets its
 *   own table when Batch E (Feature Adoption Engine) is built.
 */

// ── Priority area catalog -- fixed list, never free text. Drives
//    future Daily Brief / Watchlist / Mentor ranking. ─────────────
export const PRIORITY_AREA_CATALOG = [
  'collections', 'sales_growth', 'new_customer_acquisition', 'customer_retention',
  'inventory_health', 'vendor_supplier_payments', 'cash_flow', 'profitability',
  'delivery_operations', 'team_management',
];

const MENTOR_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ── Settings Registry -- THE authoritative contract. editable_by
//    gates writes, allowed_values/type/max_items drive validation,
//    tier is metadata for future Phase 3 gating. Paths match exactly
//    what flattenKeys() produces from a nested settings object. ────
export const SETTINGS_REGISTRY = {
  'working_hours.start':                    { editable_by: ['owner', 'admin'], tier: 'free', type: 'time' },
  'working_hours.end':                      { editable_by: ['owner', 'admin'], tier: 'free', type: 'time' },
  'notifications.attention_budget':         { editable_by: ['owner', 'admin'], tier: 'free', allowed_values: ['minimal', 'balanced', 'aggressive'] },
  'notifications.push_frequency':           { editable_by: ['owner', 'admin'], tier: 'free', allowed_values: ['low', 'normal', 'high'] },
  'notifications.daily_brief_time':         { editable_by: ['owner', 'admin'], tier: 'free', type: 'time' },
  'notifications.weekend_behavior':         { editable_by: ['owner', 'admin'], tier: 'free', allowed_values: ['normal', 'reduced', 'pause'] },
  'notifications.vacation_mode':            { editable_by: ['owner', 'admin'], tier: 'free', type: 'boolean' },
  'notifications.reminder_escalation_mode': { editable_by: ['owner', 'admin'], tier: 'free', allowed_values: ['notify_once', 'daily_until_done', 'escalate_if_overdue'] },
  'priorities.areas':                       { editable_by: ['owner', 'admin'], tier: 'free', type: 'array', allowed_values: PRIORITY_AREA_CATALOG, max_items: 5 },
  'mentor.weekly_day':                      { editable_by: ['owner', 'admin'], tier: 'business', allowed_values: MENTOR_WEEKDAYS },
  'mentor.aggressiveness':                  { editable_by: ['owner', 'admin'], tier: 'business', allowed_values: ['conservative', 'balanced', 'aggressive'] },
};

// ── Frontend-facing helper -- read allowed values for a picker
//    instead of duplicating enum literals anywhere else. ──────────
export function getAllowedValues(path) {
  return SETTINGS_REGISTRY[path]?.allowed_values || null;
}

// ── Industry-aware default priorities. Deliberately a small seed,
//    not an exhaustive taxonomy -- extend as real industry data
//    comes in via Batch E's onboarding capture. ──────────────────
const INDUSTRY_DEFAULT_PRIORITIES = {
  trading:       ['sales_growth', 'collections', 'cash_flow'],
  retail:        ['inventory_health', 'collections', 'customer_retention'],
  services:      ['collections', 'vendor_supplier_payments', 'cash_flow'],
  restaurant:    ['inventory_health', 'profitability', 'customer_retention'],
  manufacturing: ['vendor_supplier_payments', 'cash_flow', 'delivery_operations'],
};
const GENERIC_DEFAULT_PRIORITIES = ['collections', 'sales_growth', 'cash_flow'];

function getDefaultPriorities(industry) {
  if (industry && INDUSTRY_DEFAULT_PRIORITIES[industry]) {
    return INDUSTRY_DEFAULT_PRIORITIES[industry];
  }
  return GENERIC_DEFAULT_PRIORITIES;
}

// ── Build the full default settings object for an organisation.
//    Never written to the DB -- only ever computed and returned. ──
export function buildDefaultSettings(industry) {
  return {
    working_hours: { start: '08:00', end: '23:00' },
    notifications: {
      attention_budget: 'balanced',
      push_frequency: 'normal',
      daily_brief_time: '08:00',
      weekend_behavior: 'reduced',
      vacation_mode: false,
      reminder_escalation_mode: 'notify_once',
    },
    priorities: { areas: getDefaultPriorities(industry) },
    mentor: { weekly_day: 'sunday', aggressiveness: 'balanced' },
  };
}

// ── True recursive deep merge. Arrays are replaced wholesale, never
//    merged element-by-element -- priorities.areas is a chosen set,
//    not a thing to splice together. ──────────────────────────────
export function deepMerge(base, overrides) {
  if (Array.isArray(overrides)) return overrides;
  if (overrides === null || typeof overrides !== 'object') {
    return overrides === undefined ? base : overrides;
  }
  const baseObj = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  const result = { ...baseObj };
  for (const key of Object.keys(overrides)) {
    result[key] = deepMerge(result[key], overrides[key]);
  }
  return result;
}

// ── The single shared accessor every consumer should use. ────────
export async function getOrganisationSettings(orgId, supabase) {
  const { data: org } = await supabase.from('organisations')
    .select('industry, settings').eq('id', orgId).maybeSingle();
  const defaults = buildDefaultSettings(org?.industry || null);
  const saved = org?.settings || {};
  return deepMerge(defaults, saved);
}

// ── Flatten a nested object into registry-comparable dot paths,
//    e.g. {notifications:{weekend_behavior:'x'}} -> ['notifications.weekend_behavior'].
//    Arrays and booleans are leaves, never recursed into. ─────────
function flattenKeys(obj, prefix = '') {
  let keys = [];
  for (const k of Object.keys(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      keys = keys.concat(flattenKeys(obj[k], path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

function getValueAtPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// ── Registry-authoritative permission check. Fail-CLOSED: any path
//    not present in the registry is rejected, not silently allowed. ──
export function checkPatchPermission(patchObject, userRole) {
  const paths = flattenKeys(patchObject);
  for (const path of paths) {
    const entry = SETTINGS_REGISTRY[path];
    if (!entry) {
      return { allowed: false, blockedPath: path, reason: 'unknown_setting' };
    }
    if (!entry.editable_by.includes(userRole)) {
      return { allowed: false, blockedPath: path, reason: 'insufficient_role' };
    }
  }
  return { allowed: true };
}

// ── Registry-driven value validation. Independent of the permission
//    check above -- a path can be allowed for a role but still carry
//    an invalid value. ─────────────────────────────────────────────
export function validateSettingsPatch(patchObject) {
  const errors = [];
  const paths = flattenKeys(patchObject);
  for (const path of paths) {
    const entry = SETTINGS_REGISTRY[path];
    if (!entry) {
      errors.push(`Unknown setting: ${path}`);
      continue;
    }
    const value = getValueAtPath(patchObject, path);
    if (entry.type === 'array' || Array.isArray(value)) {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected an array`);
      } else {
        if (entry.allowed_values) {
          const invalid = value.filter(v => !entry.allowed_values.includes(v));
          if (invalid.length) errors.push(`${path}: invalid value(s) ${invalid.join(', ')}`);
        }
        if (entry.max_items && value.length > entry.max_items) {
          errors.push(`${path}: max ${entry.max_items} items allowed`);
        }
      }
    } else if (entry.allowed_values) {
      if (!entry.allowed_values.includes(value)) errors.push(`${path}: invalid value "${value}"`);
    } else if (entry.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
    } else if (entry.type === 'time') {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) errors.push(`${path}: expected a valid HH:MM time (00:00-23:59)`);
    }
  }
  return { valid: errors.length === 0, errors };
}
