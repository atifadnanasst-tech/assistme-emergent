#!/usr/bin/env python3
"""
Patch: Fix Org AI "top customers" mislabeling bug. See
ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI Financial Narration
Mislabeling" for full context.

Problem (found via live screenshot, confirmed in code): topCustomers()
computes this-month INVOICED REVENUE per customer -- nothing to do with
outstanding balance. Its narration prompt already says "by revenue," but
gpt-4o-mini still sometimes drifts and writes "based on outstanding
balances" in the actual response text shown to the owner. The underlying
number is correct (it genuinely is that customer's revenue this month);
the sentence describing it is wrong. This risks a trader making a wrong
collections decision believing a revenue figure is a balance owed.

Fix (2 independent, additive changes):
  A. narration.js: strengthen the top_customers prompt with an explicit
     negative constraint forbidding balance/outstanding/owe language --
     addresses the root cause.
  B. orgAi/index.js topCustomers(): prepend a deterministic, correctly-
     labeled prefix to response_text -- guarantees correct framing
     regardless of what the model generates, defense-in-depth.

2 files changed:
  backend/src/services/ai/orgAi/narration.js
  backend/src/services/ai/orgAi/index.js
"""

import sys

NARRATION_PATH = "backend/src/services/ai/orgAi/narration.js"
INDEX_PATH = "backend/src/services/ai/orgAi/index.js"

# ─────────────────────────────────────────────────────────────────────────
# A. Strengthen the top_customers prompt (root-cause fix)
# ─────────────────────────────────────────────────────────────────────────
with open(NARRATION_PATH, "r") as f:
    narration_content = f.read()

anchor_prompt = "  top_customers:          'You are a business assistant for an MSME trader. Summarize who the top customers are by revenue in 2-3 short lines. Be specific with numbers. No preamble.',"

new_prompt = "  top_customers:          'You are a business assistant for an MSME trader. Summarize who the top customers are by REVENUE (total invoiced this month) in 2-3 short lines. This is revenue, NOT outstanding balance or amount owed -- never use the words \"outstanding\", \"owe\", \"owes\", \"balance\", or \"due\" anywhere in your response. Be specific with numbers. No preamble.',"

count = narration_content.count(anchor_prompt)
if count != 1:
    print(f"ABORT: narration prompt anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

narration_content = narration_content.replace(anchor_prompt, new_prompt, 1)

with open(NARRATION_PATH, "w") as f:
    f.write(narration_content)

print("narration.js: top_customers prompt strengthened with negative constraint.")

# ─────────────────────────────────────────────────────────────────────────
# B. Deterministic label prefix (defense-in-depth)
# ─────────────────────────────────────────────────────────────────────────
with open(INDEX_PATH, "r") as f:
    index_content = f.read()

anchor_return = """  // Step 6: GPT narration
  const response_text = await narrate({
    ranked: ranked.slice(0, 3),
    grandTotal,
    currency: orgCurrency,
    topName: ranked[0]?.name,
    topAmount: ranked[0]?.total,
  }, 'top_customers', openai, { language });

  console.log('[orgAi] topCustomers ms=' + (Date.now() - start));
  return { response_text, chart_data, next_action };
}"""

new_return = """  // Step 6: GPT narration
  // Deterministic label prefix -- guarantees the owner always reads the
  // correct metric name regardless of model wording, even if the LLM
  // narration below still drifts despite the strengthened prompt. See
  // ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI Financial Narration
  // Mislabeling" for the bug this fixes (revenue was being mislabeled as
  // outstanding balance in the actual chat response).
  const rawNarration = await narrate({
    ranked: ranked.slice(0, 3),
    grandTotal,
    currency: orgCurrency,
    topName: ranked[0]?.name,
    topAmount: ranked[0]?.total,
  }, 'top_customers', openai, { language });
  const response_text = `📈 Top customers by revenue this month:\n${rawNarration}`;

  console.log('[orgAi] topCustomers ms=' + (Date.now() - start));
  return { response_text, chart_data, next_action };
}"""

count = index_content.count(anchor_return)
if count != 1:
    print(f"ABORT: index.js return anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

index_content = index_content.replace(anchor_return, new_return, 1)

with open(INDEX_PATH, "w") as f:
    f.write(index_content)

print("index.js: deterministic label prefix added to topCustomers() response_text.")
print("All patches applied successfully.")
