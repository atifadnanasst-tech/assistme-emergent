#!/usr/bin/env python3
"""
Patch: Wire usage tracking into Org AI (Step 2c of Subscription & Billing).
See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription & Billing".

Org AI's completion calls are spread across 4 files, unlike Customer AI's
clean 2-call-site pattern in one handler. Design choice made deliberately
for safety: orgId/supabase are added as NEW OPTIONAL parameters to
planExecution() and narrate() -- existing callers who don't pass them are
completely unaffected (100% backward compatible), and tracking only fires
when both are actually supplied. This means even if a call site were missed
somewhere, the worst case is "usage isn't tracked there" (silent, harmless),
never "something breaks."

ATOMIC APPLICATION: every anchor across all 4 files is validated FIRST.
Nothing is written to any file unless every single anchor check passes.
This prevents a partial-patch state (some files modified, others not) if
any one anchor turns out to be stale.
"""

import sys

files = {
    "narration": "backend/src/services/ai/orgAi/narration.js",
    "index": "backend/src/services/ai/orgAi/index.js",
    "planner": "backend/src/services/ai/planner.js",
    "freeform": "backend/src/services/ai/orgAi/freeform.js",
}

content = {}
for key, path in files.items():
    with open(path, "r") as f:
        content[key] = f.read()

replacements = []

# A. narration.js
replacements.append(("narration", "A-completion", """    }, { signal: controller.signal });

    return completion.choices[0]?.message?.content?.trim() || fallback;
  } catch (e) {
    console.warn('[orgAi] narrate fallback used. key:', functionKey, 'reason:', e.message);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}""", """    }, { signal: controller.signal });

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget,
    // tracking only. Only fires if the caller supplied orgId+supabase in
    // options; every existing/future caller that doesn't is unaffected.
    if (options.orgId && options.supabase) {
      recordAiUsage({
        orgId: options.orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase: options.supabase,
      }).catch(() => {});
    }

    return completion.choices[0]?.message?.content?.trim() || fallback;
  } catch (e) {
    console.warn('[orgAi] narrate fallback used. key:', functionKey, 'reason:', e.message);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}""", 1))

replacements.append(("narration", "A-import", "export async function narrate(data, functionKey, openai, options = {}) {",
"""import { recordAiUsage } from '../billing/usageTracking.js';

export async function narrate(data, functionKey, openai, options = {}) {""", 1))

# B. orgAi/index.js
replacements.append(("index", "B1-singleline", ", { language });", ", { language, orgId, supabase });", 17))

replacements.append(("index", "B2-multiline", """  const response_text = await narrate(
    { total, count, topPayerName, currency: orgCurrency, avgLast7: Math.round(avgLast7) },
    'collections_today',
    openai,
    { language }
  );""", """  const response_text = await narrate(
    { total, count, topPayerName, currency: orgCurrency, avgLast7: Math.round(avgLast7) },
    'collections_today',
    openai,
    { language, orgId, supabase }
  );""", 1))

# C. planner.js
replacements.append(("planner", "C-signature",
"export async function planExecution({ userMessage, scope = 'org', orgContext = {}, conversationHistory = [], openai }) {",
"export async function planExecution({ userMessage, scope = 'org', orgContext = {}, conversationHistory = [], openai, orgId, supabase }) {", 1))

replacements.append(("planner", "C-completion", """    clearTimeout(timeoutId);

    const raw = completion.choices[0].message.content;""", """    clearTimeout(timeoutId);

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget,
    // tracking only. Only fires if the caller supplied orgId+supabase.
    if (orgId && supabase) {
      recordAiUsage({
        orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    }

    const raw = completion.choices[0].message.content;""", 1))

# D. freeform.js
replacements.append(("freeform", "D1-callsite",
"planResult = await planExecution({ userMessage: message, scope, orgContext, conversationHistory, openai });",
"planResult = await planExecution({ userMessage: message, scope, orgContext, conversationHistory, openai, orgId, supabase });", 1))

replacements.append(("freeform", "D2a-signature",
"async function tryHelpArticle({ message, supabase, orgContext }) {",
"async function tryHelpArticle({ message, supabase, orgContext, orgId }) {", 1))

replacements.append(("freeform", "D2b-callsite",
"const helpResult = await tryHelpArticle({ message, supabase, orgContext });",
"const helpResult = await tryHelpArticle({ message, supabase, orgContext, orgId });", 1))

replacements.append(("freeform", "D2c-completion", """    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: HELP_GUARDRAIL_PROMPT },
        { role: 'user', content: `${articleBlock}\\n\\nOwner's question: ${message}` },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    const response_text = completion.choices?.[0]?.message?.content?.trim();""", """    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: HELP_GUARDRAIL_PROMPT },
        { role: 'user', content: `${articleBlock}\\n\\nOwner's question: ${message}` },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget.
    if (orgId && supabase) {
      recordAiUsage({
        orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    }

    const response_text = completion.choices?.[0]?.message?.content?.trim();""", 1))

replacements.append(("freeform", "D3-completion", """    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 500,
      temperature: 0.5,
    });

    const response_text = completion.choices?.[0]?.message?.content?.trim()
      || "Could you tell me a bit more about what you're trying to do? I can help with business questions, customers, payments, products, sales, or how to use AssistMe.";""", """    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 500,
      temperature: 0.5,
    });

    // Usage tracking (Subscription & Billing, Step 2c) -- fire-and-forget.
    if (orgId && supabase) {
      recordAiUsage({
        orgId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    }

    const response_text = completion.choices?.[0]?.message?.content?.trim()
      || "Could you tell me a bit more about what you're trying to do? I can help with business questions, customers, payments, products, sales, or how to use AssistMe.";""", 1))

all_ok = True
for file_key, label, old, new, expected in replacements:
    actual = content[file_key].count(old)
    status = "OK" if actual == expected else "MISMATCH"
    if actual != expected:
        all_ok = False
    print(f"{label}: expected {expected}, found {actual} -- {status}")

if not all_ok:
    print("\nABORT: one or more anchors did not match expected count. NO FILES WRITTEN.")
    sys.exit(1)

for file_key, label, old, new, expected in replacements:
    content[file_key] = content[file_key].replace(old, new, expected if expected > 1 else 1)

content["planner"] = "import { recordAiUsage } from './billing/usageTracking.js';\n" + content["planner"]
content["freeform"] = "import { recordAiUsage } from '../billing/usageTracking.js';\n" + content["freeform"]

for key, path in files.items():
    with open(path, "w") as f:
        f.write(content[key])

print("\nAll files validated and written successfully: narration.js, orgAi/index.js, planner.js, freeform.js")
