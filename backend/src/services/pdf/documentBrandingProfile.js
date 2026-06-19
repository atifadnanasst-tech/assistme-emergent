/**
 * AssistMe — documentBrandingProfile.js
 * Document Branding Engine, Jun 2026
 *
 * Pure read/assembly function. Centralizes everything generateDocumentPDF()
 * needs to render a document's header, footer, and bank-details block.
 * No side effects, no database writes, independently testable.
 *
 * Bank account ordering rule (locked, spec Part 7):
 *   The account whose business_profile_bank_accounts row has is_default = true
 *   always renders first, regardless of sort_order. All other accounts follow
 *   in ascending sort_order. sort_order never competes with is_default.
 *
 * Tier gate: show_assistme_branding only takes effect for organisations on
 * the 'business' subscription_plan. Free/Pro always show the strip.
 *
 * Two-step fetch + JS merge for bank accounts (not a Supabase embedded join):
 * matches the existing project convention — Supabase client does not support
 * column-to-column comparisons in filters, so related rows are fetched
 * separately and combined in JS elsewhere in this codebase (e.g. customer_addresses).
 */

export async function getDocumentBrandingProfile(organisationId, supabase) {
  // ── Business profile — same scoping rule generateDocumentPDF already used ──
  const { data: bizProfile } = await supabase
    .from('business_profiles')
    .select('id, business_name, gstin, address_line1, address_line2, city, state, postal_code, phone, email, logo_url, signature_url, terms_text, show_assistme_branding')
    .eq('organisation_id', organisationId)
    .eq('is_default', true)
    .eq('is_active', true)
    .is('deleted_at', null)
    .maybeSingle();

  const biz = bizProfile || {};

  // ── Bank accounts ───────────────────────────────────────────────────────
  let bankAccounts = [];
  if (biz.id) {
    try {
      const { data: links } = await supabase
        .from('business_profile_bank_accounts')
        .select('bank_account_id, is_default, sort_order')
        .eq('business_profile_id', biz.id)
        .is('deleted_at', null);

      if (links && links.length > 0) {
        const accountIds = links.map((l) => l.bank_account_id);
        const { data: accounts } = await supabase
          .from('bank_accounts')
          .select('id, name, bank_name, account_holder_name, account_number, ifsc_code, branch_name')
          .in('id', accountIds)
          .is('deleted_at', null)
          .eq('is_active', true);

        const accountsById = {};
        (accounts || []).forEach((a) => { accountsById[a.id] = a; });

        bankAccounts = links
          .map((l) => {
            const acc = accountsById[l.bank_account_id];
            return acc ? { ...acc, _is_default: l.is_default, _sort_order: l.sort_order || 0 } : null;
          })
          .filter(Boolean) // drop links whose account was soft-deleted or made inactive
          .sort((a, b) => {
            if (a._is_default && !b._is_default) return -1;
            if (!a._is_default && b._is_default) return 1;
            return a._sort_order - b._sort_order;
          })
          .map(({ _is_default, _sort_order, ...account }) => account); // strip join metadata, keep only document-facing fields
      }
    } catch (err) {
      console.error('[getDocumentBrandingProfile] bank account fetch failed:', err.message);
    }
  }

  // ── Tier-gated AssistMe footer strip ────────────────────────────────────
  let showAssistmeStrip = true;
  let assistmeStripText = null;
  try {
    const { data: org } = await supabase
      .from('organisations')
      .select('subscription_plan')
      .eq('id', organisationId)
      .single();
    const plan = org?.subscription_plan || 'free';

    if (plan === 'business' && biz.show_assistme_branding === false) {
      showAssistmeStrip = false;
    }

    if (showAssistmeStrip) {
      // Bug fix Jun 17 2026: system_config can legitimately have multiple active
      // rows for the same key (global default + targeted overrides, e.g. country:IN) --
      // .maybeSingle() throws when 2+ rows match, which silently produced null text
      // here (error was never checked). Fixed by taking the highest-priority active
      // row instead of assuming exactly one. NOT yet doing real targeting-match
      // (comparing each row's `targeting` jsonb against actual org attributes) --
      // AssistMe's entire user base is India-market today and there's no
      // organisations.country column to match against yet, so "highest priority
      // wins" already produces the right real-world result. True targeting-match
      // is a separate, larger feature, deferred, not silently smuggled into this fix.
      const { data: sysConfigRows } = await supabase
        .from('system_config')
        .select('value, priority')
        .eq('key', 'pdf_footer_promo')
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .limit(1);
      assistmeStripText = sysConfigRows?.[0]?.value || null;
    }
  } catch (err) {
    console.error('[getDocumentBrandingProfile] tier/footer check failed:', err.message);
  }

  return {
    business_name: biz.business_name || null,
    gstin: biz.gstin || null,
    address_line1: biz.address_line1 || null,
    address_line2: biz.address_line2 || null,
    city: biz.city || null,
    state: biz.state || null,
    postal_code: biz.postal_code || null,
    phone: biz.phone || null,
    email: biz.email || null,
    logo_url: biz.logo_url || null,
    signature_url: biz.signature_url || null,
    terms_text: biz.terms_text || null,
    bank_accounts: bankAccounts,
    show_assistme_strip: showAssistmeStrip,
    assistme_strip_text: assistmeStripText,
  };
}
