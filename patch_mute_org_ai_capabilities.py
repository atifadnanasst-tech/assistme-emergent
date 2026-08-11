#!/usr/bin/env python3
"""
Patch: Mute 10 unreachable Org AI capabilities for v1. See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI v1-Completion" for full
audit context.

Problem: these 10 capabilities are registered in capabilityRegistry.js but
have no execution wiring anywhere (verified: no capability function exists
in backend/src/services/capabilities/, and no execute-plan branch exists
for any of them). Today they fail gracefully ("coming soon", HTTP 501) if
the planner happens to select one -- not a crash, but a wasted round trip
and a confusing "why did it offer this if it can't do it" experience.

Fix: mute at the SOURCE -- getCapabilitiesForScope() is the single function
that builds the capability list shown in the planner's system prompt
(planner.js). Filtering here means the LLM never even sees these 10 as
options, so it can never select them in the first place. This is a
mvp_muted flag on the registry entry, not a deletion -- the full
capability definition (description, params, etc.) stays in the codebase
for a clean post-v1 activation, exactly like the muted Home Screen pills
pattern used earlier this session.

Also adds a defense-in-depth check in validator.js: if a muted capability
name somehow reaches validatePlan() anyway (e.g. hallucinated from
conversation history, or a stale client), it's now treated the same as an
unknown capability -- logged to missing_capabilities, never silently
included in a valid plan.

2 files changed:
  backend/src/services/ai/capabilityRegistry.js
  backend/src/services/ai/validator.js
"""

import sys

REGISTRY_PATH = "backend/src/services/ai/capabilityRegistry.js"
VALIDATOR_PATH = "backend/src/services/ai/validator.js"

# ─────────────────────────────────────────────────────────────────────────
# PART 1 — capabilityRegistry.js
# ─────────────────────────────────────────────────────────────────────────
with open(REGISTRY_PATH, "r") as f:
    registry_content = f.read()

# Each entry: add `mvp_muted: true,` right after `confirmation: '...',`
# Comment explains why, pointing at the backlog doc for full context.
mute_replacements = [
    (
        """  mutate_inventory: {
    version: 1,
    description: 'Adjust stock quantity for one or more products.',
    confirmation: 'always',""",
        """  mutate_inventory: {
    version: 1,
    description: 'Adjust stock quantity for one or more products.',
    confirmation: 'always',
    // MUTED FOR v1 -- no execution wiring exists yet (no capability
    // function, no execute-plan branch). See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
    // -> "Org AI v1-Completion". Full definition kept for post-v1 activation.
    mvp_muted: true,""",
    ),
    (
        """  mutate_task: {
    version: 1,
    description: 'Create, update, complete, or cancel a task.',
    confirmation: 'preview',""",
        """  mutate_task: {
    version: 1,
    description: 'Create, update, complete, or cancel a task.',
    confirmation: 'preview',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  mutate_customer: {
    version: 1,
    description: 'Create or update a customer profile: name, phone, address, credit limit.',
    confirmation: 'always',""",
        """  mutate_customer: {
    version: 1,
    description: 'Create or update a customer profile: name, phone, address, credit limit.',
    confirmation: 'always',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  mutate_quotation: {
    version: 1,
    description: 'Create, edit, send, or convert a quotation to invoice.',
    confirmation: 'always',""",
        """  mutate_quotation: {
    version: 1,
    description: 'Create, edit, send, or convert a quotation to invoice.',
    confirmation: 'always',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  mutate_expense: {
    version: 1,
    description: 'Log a business expense with category, amount, date.',
    confirmation: 'always',""",
        """  mutate_expense: {
    version: 1,
    description: 'Log a business expense with category, amount, date.',
    confirmation: 'always',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  mutate_supplier: {
    version: 1,
    description: 'Create or update a supplier profile.',
    confirmation: 'preview',""",
        """  mutate_supplier: {
    version: 1,
    description: 'Create or update a supplier profile.',
    confirmation: 'preview',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  mutate_tags: {
    version: 1,
    description: 'Add or remove tags on customers or products. Use for "VIP tag lagao", "ABC ko regular mark karo".',
    confirmation: 'never',""",
        """  mutate_tags: {
    version: 1,
    description: 'Add or remove tags on customers or products. Use for "VIP tag lagao", "ABC ko regular mark karo".',
    confirmation: 'never',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  send_payment_reminder: {
    version: 1,
    description: 'Send payment reminder to customers with outstanding invoices. Use for "reminder bhejo", "ABC ko payment ke liye message karo".',
    confirmation: 'always',""",
        """  send_payment_reminder: {
    version: 1,
    description: 'Send payment reminder to customers with outstanding invoices. Use for "reminder bhejo", "ABC ko payment ke liye message karo".',
    confirmation: 'always',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  generate_document: {
    version: 1,
    description: 'Generate a PDF: invoice, quote, or product catalog. Use for "catalog banao", "invoice PDF nikalo".',
    confirmation: 'never',""",
        """  generate_document: {
    version: 1,
    description: 'Generate a PDF: invoice, quote, or product catalog. Use for "catalog banao", "invoice PDF nikalo".',
    confirmation: 'never',
    // MUTED FOR v1 -- see mutate_inventory above for rationale.
    mvp_muted: true,""",
    ),
    (
        """  set_reminder: {
    version: 1,
    description: 'Set a time-based reminder for a task or follow-up. Use for "kal remind karna", "Monday ko ABC ke liye reminder".',
    confirmation: 'preview',""",
        """  set_reminder: {
    version: 1,
    description: 'Set a time-based reminder for a task or follow-up. Use for "kal remind karna", "Monday ko ABC ke liye reminder".',
    confirmation: 'preview',
    // MUTED FOR v1 -- see mutate_inventory above for rationale. Note:
    // Spark's set_reminder is a SEPARATE, already-working pipeline --
    // this mute only affects the Org AI planner surface.
    mvp_muted: true,""",
    ),
]

for label, (old, new) in enumerate(mute_replacements):
    count = registry_content.count(old)
    if count != 1:
        print(f"ABORT: registry anchor #{label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for old, new in mute_replacements:
    registry_content = registry_content.replace(old, new, 1)

# Filter mvp_muted entries out of getCapabilitiesForScope() -- the single
# function that builds what the planner's system prompt sees.
anchor_filter = """export function getCapabilitiesForScope(scope = 'org') {
  return Object.entries(CAPABILITY_REGISTRY)
    .filter(([, def]) => def.scope.includes('org') || def.scope.includes(scope))
    .map(([name, def]) => ({
      name,
      description: def.description,
      confirmation: def.confirmation,
    }));
}"""

new_filter = """export function getCapabilitiesForScope(scope = 'org') {
  return Object.entries(CAPABILITY_REGISTRY)
    // mvp_muted capabilities are excluded from what the planner is told
    // it can do -- see ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI
    // v1-Completion". Full definitions remain in the registry for a clean
    // post-v1 activation (just flip mvp_muted off, nothing else to change).
    .filter(([, def]) => !def.mvp_muted)
    .filter(([, def]) => def.scope.includes('org') || def.scope.includes(scope))
    .map(([name, def]) => ({
      name,
      description: def.description,
      confirmation: def.confirmation,
    }));
}"""

count = registry_content.count(anchor_filter)
if count != 1:
    print(f"ABORT: getCapabilitiesForScope anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

registry_content = registry_content.replace(anchor_filter, new_filter, 1)

with open(REGISTRY_PATH, "w") as f:
    f.write(registry_content)

print("capabilityRegistry.js: 10 capabilities muted, getCapabilitiesForScope filtered.")

# ─────────────────────────────────────────────────────────────────────────
# PART 2 — validator.js (defense-in-depth)
# ─────────────────────────────────────────────────────────────────────────
with open(VALIDATOR_PATH, "r") as f:
    validator_content = f.read()

anchor_validator = """    const cap = getCapability(capName);
    if (!cap) {
      unknownCapabilities.push(capName);
      console.warn('[MISSING_CAPABILITY]', capName, '| org:', orgId);
      await logMissingCapability({ supabase, orgId, userPrompt, detectedIntent: capName });
      continue;
    }"""

new_validator = """    const cap = getCapability(capName);
    if (!cap) {
      unknownCapabilities.push(capName);
      console.warn('[MISSING_CAPABILITY]', capName, '| org:', orgId);
      await logMissingCapability({ supabase, orgId, userPrompt, detectedIntent: capName });
      continue;
    }

    // Defense-in-depth: mvp_muted capabilities are already filtered out of
    // what the planner is told it can use (capabilityRegistry.js), so this
    // should never trigger in normal operation. Guards against a muted
    // capability name leaking through via conversation history or a stale
    // client -- treated the same as an unknown capability, never silently
    // included in a valid plan.
    if (cap.mvp_muted) {
      unknownCapabilities.push(capName);
      console.warn('[MUTED_CAPABILITY]', capName, '| org:', orgId);
      await logMissingCapability({ supabase, orgId, userPrompt, detectedIntent: capName });
      continue;
    }"""

count = validator_content.count(anchor_validator)
if count != 1:
    print(f"ABORT: validator anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

validator_content = validator_content.replace(anchor_validator, new_validator, 1)

with open(VALIDATOR_PATH, "w") as f:
    f.write(validator_content)

print("validator.js: mvp_muted defense-in-depth check added.")
print("All patches applied successfully.")
