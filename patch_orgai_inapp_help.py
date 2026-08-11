#!/usr/bin/env python3
"""
Patch: In-app help via Org AI freeform chat (Task C of Org AI
v1-Completion). See ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Org AI
v1-Completion / In-app Help".

Adds a help-article lookup at the TOP of handleWorldIntelligence() in
freeform.js. This function is already the catch-all for greetings,
coaching, world knowledge, and "how to use AssistMe" questions -- so
placing the lookup here means:
  - Business-DATA questions still flow through the planner untouched
    (they never reach this function). Zero risk to existing behavior.
  - Only genuine how-to questions (which already land here) trigger a
    help-article search.
  - handleWorldIntelligence is called from 4 upstream paths, so one
    insertion covers all of them.

Behavior: call the search_help_articles RPC (plainto_tsquery, 'simple'
config, multilingual keywords). If a match is found, format its steps +
pitfalls through a STRICT guardrail prompt (app-usage only, never
technical/backend/DB/security, never invent steps not in the article) and
return it. If no match, fall through to the existing Brain 3 general
path exactly as before.

PREREQUISITE: search_help_articles() RPC must already exist in Supabase
(deploy the SQL before this patch). Fails safe if absent -- returns null,
falls through to normal Brain 3.

1 file changed: backend/src/services/ai/orgAi/freeform.js
"""

import sys

PATH = "backend/src/services/ai/orgAi/freeform.js"

with open(PATH, "r") as f:
    content = f.read()

anchor = """export async function handleWorldIntelligence({ message, orgId, supabase, orgContext, conversationHistory = [], conversationSummary = null, trigger = 'unknown' }) {
  const openai = orgContext?.openai;
  console.log('[Brain3]', { trigger, messagePreview: message?.substring(0, 40) });"""

new = """// ── In-app Help lookup (Org AI v1-Completion, Task C) ──────────────────────
// Feature Knowledge Registry retrieval. Calls the search_help_articles RPC
// (trigger-maintained tsvector, multilingual keywords: en + hi + roman-hi)
// and, on a match, narrates the article's steps/pitfalls through a strict
// app-usage-only guardrail. Returns a response object on hit, or null to
// let the caller fall through to general Brain 3 knowledge.
//
// GUARDRAIL: the model may ONLY use the provided article content. It must
// never surface backend/DB/infrastructure/security details, and must never
// invent steps that are not in the article. Content safety comes from the
// curated help_articles rows, not from trusting the model.
const HELP_GUARDRAIL_PROMPT = [
  'You are AssistMe\\'s in-app help assistant, guiding an MSME business owner',
  'on how to USE the AssistMe app.',
  'Answer ONLY using the help article provided below. Walk the owner through',
  'the steps in order, mentioning the on-screen buttons and screens named in',
  'the article. If the article lists pitfalls, weave in the relevant one.',
  'NEVER discuss databases, code, servers, infrastructure, APIs, security, or',
  'anything not present in the article. NEVER invent steps, screens, or buttons',
  'that are not in the article. Keep it short, friendly, and action-first.',
  'If the owner asked in Hindi or a mix, reply in that same style.',
].join(' ');

async function tryHelpArticle({ message, supabase, orgContext }) {
  try {
    if (!message || !supabase) return null;
    // Uses the search_help_articles RPC (matches the codebase convention of
    // search_products_fuzzy / search_customers_fuzzy -- search logic lives in
    // a Postgres function, called via .rpc(), rather than the PostgREST
    // .textSearch() client method which isn't used elsewhere here).
    const { data, error } = await supabase
      .rpc('search_help_articles', { p_query: message });
    if (error) {
      console.warn('[Help] search error (non-blocking):', error.message);
      return null;
    }
    if (!data || data.length === 0) return null;

    const article = data[0];
    const openai = orgContext?.openai;

    // Build a plain-text rendering of the article for the model to narrate.
    const stepsText = (article.steps || [])
      .map((s, i) => `${i + 1}. [${s.screen || ''}] ${s.text || ''}`)
      .join('\\n');
    const pitfallsText = (article.pitfalls || []).length
      ? '\\nGood to know:\\n' + (article.pitfalls || []).map(p => `- ${p}`).join('\\n')
      : '';
    const articleBlock = `HELP ARTICLE: ${article.title}\\nSteps:\\n${stepsText}${pitfallsText}`;

    // If OpenAI is unavailable, return the raw article steps directly --
    // still accurate, just un-narrated. Never fabricates.
    if (!openai) {
      return {
        response_text: `${article.title}\\n\\n${stepsText}${pitfallsText}`,
        message_type: 'help_article',
        capability_gap: false,
        normalized_intent: null,
        chart_data: null,
        next_action: null,
        execution_plan: null,
        pending_plan_id: null,
      };
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: HELP_GUARDRAIL_PROMPT },
        { role: 'user', content: `${articleBlock}\\n\\nOwner's question: ${message}` },
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    const response_text = completion.choices?.[0]?.message?.content?.trim();
    if (!response_text) {
      // Model returned nothing -- fall back to raw steps rather than failing.
      return {
        response_text: `${article.title}\\n\\n${stepsText}${pitfallsText}`,
        message_type: 'help_article',
        capability_gap: false,
        normalized_intent: null,
        chart_data: null,
        next_action: null,
        execution_plan: null,
        pending_plan_id: null,
      };
    }

    console.log('[Help]', { matchedSlug: article.slug });
    return {
      response_text,
      message_type: 'help_article',
      capability_gap: false,
      normalized_intent: null,
      chart_data: null,
      next_action: null,
      execution_plan: null,
      pending_plan_id: null,
    };
  } catch (err) {
    console.warn('[Help] lookup failed (non-blocking):', err.message);
    return null;
  }
}

export async function handleWorldIntelligence({ message, orgId, supabase, orgContext, conversationHistory = [], conversationSummary = null, trigger = 'unknown' }) {
  const openai = orgContext?.openai;
  console.log('[Brain3]', { trigger, messagePreview: message?.substring(0, 40) });

  // In-app help pre-check (Task C): if this looks like a how-to question the
  // help_articles registry can answer, return that instead of falling
  // through to general knowledge. Non-blocking -- any failure returns null
  // and the normal Brain 3 path continues.
  const helpResult = await tryHelpArticle({ message, supabase, orgContext });
  if (helpResult) return helpResult;"""

count = content.count(anchor)
if count != 1:
    print(f"ABORT: anchor found {count} times (expected exactly 1). No changes written.")
    sys.exit(1)

content = content.replace(anchor, new, 1)

with open(PATH, "w") as f:
    f.write(content)

print("Help-article pre-check added to handleWorldIntelligence.")
