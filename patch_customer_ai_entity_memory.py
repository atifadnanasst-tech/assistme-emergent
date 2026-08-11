#!/usr/bin/env python3
"""
Patch: Wire Customer AI (ai-query) to read the distillation engine's
entity_memory output. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Customer
AI distillation wiring".

Problem: the distillation engine writes ~25 durable per-customer facts into
entity_memory (identity, relationships, preferences, payment_pattern,
buying_pattern, customer_summary, etc.), but the Customer AI surface
(ai-query) never read them -- only Spark did. So the surface where distilled
customer intelligence is most useful (chatting inside a customer's AI tab)
was blind to it.

Fix (2 additive changes to backend/src/index.js, ai-query handler):
  A. Read entity_memory for this customer, mirroring Spark's proven,
     production-safe read (same table, same org+entity filters, same silent
     try/catch). Adds two staleness filters that Spark does NOT have, using
     columns the distillation engine already populates:
       - expires_at IS NULL OR expires_at > now()  -> drops expired temporary
         signals (payment_delay, upcoming_visit, urgent_request, etc. all
         carry real TTL-based expiry timestamps written at insert time)
       - confidence >= 0.6  -> drops low-confidence distilled guesses
     Read-only, one-directional. On any failure the catch leaves
     customerMemory empty and the handler behaves exactly as today ->
     graceful degradation, regression-safe.
  B. Inject the memory as a read-only context block appended to the existing
     "== CAPABILITY REGISTRY ==" section of the system prompt. Purely
     additive prompt text -- does not touch the tool-call loop, VIZ
     extraction, action-card detection, message-save path, or response shape.

Placement rationale: the read sits in the context-gathering block that
already runs before the system prompt is assembled (right after the customer
language fetch, alongside bizProfile), and the injection extends a prompt
section that already lists the customer data the AI may draw on.
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

# ─────────────────────────────────────────────────────────────────────────
# A. Read filtered entity_memory (mirrors Spark's Layer 2, + staleness filters)
# ─────────────────────────────────────────────────────────────────────────
anchor_a = """    const customerLanguageName = customerLanguage
      ? (LANGUAGE_NAMES[customerLanguage] || customerLanguage)
      : null;"""

new_a = """    const customerLanguageName = customerLanguage
      ? (LANGUAGE_NAMES[customerLanguage] || customerLanguage)
      : null;

    // Distillation engine output — durable per-customer facts (identity,
    // relationships, preferences, payment/buying patterns, customer_summary).
    // Mirrors Spark's proven entity_memory read, with two extra staleness
    // filters using columns the engine already populates: expired temporary
    // signals are dropped (expires_at), and low-confidence guesses are
    // dropped (confidence >= 0.6). Read-only; silent catch keeps behaviour
    // identical to before on any failure. See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md
    // -> "Customer AI distillation wiring".
    let customerMemory = '';
    try {
      const nowIso = new Date().toISOString();
      const { data: memRows } = await supabase
        .from('entity_memory')
        .select('memory_key, memory_value, expires_at, confidence')
        .eq('organisation_id', organisationId)
        .eq('entity_type', 'customer')
        .eq('entity_id', customerId)
        .is('deleted_at', null)
        .gte('confidence', 0.6);
      if (memRows?.length > 0) {
        const fresh = memRows.filter(m => !m.expires_at || m.expires_at > nowIso);
        if (fresh.length > 0) {
          customerMemory = fresh.map(m => `${m.memory_key}: ${m.memory_value}`).join('\\n');
        }
      }
    } catch (memErr) {
      console.warn('[ai-query] entity_memory read failed (non-blocking):', memErr.message);
    }"""

replacements.append(("A", anchor_a, new_a))

# ─────────────────────────────────────────────────────────────────────────
# B. Inject memory into the CAPABILITY REGISTRY prompt section
# ─────────────────────────────────────────────────────────────────────────
anchor_b = """- Message history: past conversations with this customer
Use this knowledge to infer answers to any owner query about this customer."""

new_b = """- Message history: past conversations with this customer
${customerMemory ? `\\n== DISTILLED CUSTOMER MEMORY (durable facts learned over time) ==\\n${customerMemory}\\nUse these facts as background context. They are learned signals, not live financial data — for exact amounts always call a tool. If a memory conflicts with current tool data, trust the tool.\\n` : ''}
Use this knowledge to infer answers to any owner query about this customer."""

replacements.append(("B", anchor_b, new_b))

# ─────────────────────────────────────────────────────────────────────────
# Apply with match-count validation
# ─────────────────────────────────────────────────────────────────────────
for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Both patches applied successfully (A, B).")
