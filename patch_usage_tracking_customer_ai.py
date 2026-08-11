#!/usr/bin/env python3
"""
Patch: Wire usage tracking into Customer AI (Step 2b of Subscription &
Billing). See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription &
Billing".

Adds recordAiUsage() calls after BOTH OpenAI completions in the Customer AI
ai-query handler (backend/src/index.js) -- the initial tool-calling call and
the follow-up natural-language call after tool execution. Both are real,
separately-billed API calls and both need tracking.

Calls are FIRE-AND-FORGET (not awaited): recordAiUsage() itself already
never throws (see usageTracking.js), and not awaiting it means recording
usage adds ZERO latency to the actual response the customer/owner is
waiting on. A .catch() is added anyway as pure defense-in-depth, even
though it should never fire.

Step 2 note: this is TRACKING ONLY. No enforcement/blocking exists yet.
This wiring cannot change any existing behavior a user would notice --
worst case if something is wrong here, a usage row fails to update and a
warning gets logged, nothing else.

2 changes to backend/src/index.js.
"""

import sys

PATH = "backend/src/index.js"

with open(PATH, "r") as f:
    content = f.read()

replacements = []

anchor_a = """import { getFinancialPosition } from './services/ai/queryEngine/primitives.js';"""

new_a = """import { getFinancialPosition } from './services/ai/queryEngine/primitives.js';
import { recordAiUsage } from './services/billing/usageTracking.js';"""

replacements.append(("A", anchor_a, new_a))

anchor_b = """      completion = await client.chat.completions.create({
        model: 'gpt-4o-mini', messages, tools: AI_QUERY_TOOLS, tool_choice: 'auto', temperature: 0.1,
      }, { signal: controller1.signal });
      clearTimeout(t1);
    } catch (e) {
      clearTimeout(t1);
      return c.json({ error: 'ai_error', message: 'AI temporarily unavailable' }, 500);
    }"""

new_b = """      completion = await client.chat.completions.create({
        model: 'gpt-4o-mini', messages, tools: AI_QUERY_TOOLS, tool_choice: 'auto', temperature: 0.1,
      }, { signal: controller1.signal });
      clearTimeout(t1);
      // Usage tracking (Subscription & Billing, Step 2b) -- fire-and-forget,
      // tracking only, no enforcement. Never awaited: adds zero latency to
      // the response the customer/owner is waiting on.
      recordAiUsage({
        orgId: organisationId, model: 'gpt-4o-mini',
        inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
        supabase,
      }).catch(() => {});
    } catch (e) {
      clearTimeout(t1);
      return c.json({ error: 'ai_error', message: 'AI temporarily unavailable' }, 500);
    }"""

replacements.append(("B", anchor_b, new_b))

anchor_c = """        const completion2 = await client.chat.completions.create({
          model: 'gpt-4o-mini', messages, temperature: 0.2,
        }, { signal: controller2.signal });
        clearTimeout(t2);
        responseText = completion2.choices[0].message.content || 'No response';"""

new_c = """        const completion2 = await client.chat.completions.create({
          model: 'gpt-4o-mini', messages, temperature: 0.2,
        }, { signal: controller2.signal });
        clearTimeout(t2);
        responseText = completion2.choices[0].message.content || 'No response';
        // Usage tracking (Subscription & Billing, Step 2b) -- fire-and-forget.
        recordAiUsage({
          orgId: organisationId, model: 'gpt-4o-mini',
          inputTokens: completion2.usage?.prompt_tokens, outputTokens: completion2.usage?.completion_tokens,
          supabase,
        }).catch(() => {});"""

replacements.append(("C", anchor_c, new_c))

for label, old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ABORT: anchor {label} found {count} times (expected exactly 1). No changes written.")
        sys.exit(1)

for label, old, new in replacements:
    content = content.replace(old, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Customer AI usage-tracking wiring applied successfully (A, B, C).")
