/**
 * AssistMe — bankAccountsService.js
 * Bank Accounts CRUD for the Business Profile screen, Jun 2026.
 *
 * Owner-scoped only (Business Profile / Branding Engine spec, Part 7).
 * v1 doctrine: there is exactly one business_profiles row per org today
 * (no multi-profile UI exists), so every account added here auto-links to
 * that one profile with zero "link this account to profile X" ceremony --
 * the business_profile_bank_accounts join table is used exactly as the
 * schema designed it, not bypassed; it just operates in its simplest
 * configuration because there's nothing else to link to yet.
 *
 * Ordering rule (locked): the account whose join row has is_default = true
 * always renders first, regardless of sort_order; everything else follows
 * in ascending sort_order. Same rule getDocumentBrandingProfile() already
 * uses for PDF rendering -- this file is the write side of that same data.
 *
 * Delete: soft-deletes both bank_accounts (deleted_at + is_active:false)
 * AND its business_profile_bank_accounts relationship row (deleted_at +
 * is_default:false), with the link soft-delete's own error checked
 * explicitly -- if it silently failed, a stale is_default:true could
 * survive on the deleted row while a new row also gets marked default,
 * recreating the exact two-defaults inconsistency this file exists to
 * prevent. All default-state writes scope to .is('deleted_at', null) so
 * a soft-deleted link can never participate in default mutations even
 * if some other path ever leaves one in an unexpected state.
 */
import { getBusinessProfile } from './setBusinessProfileCapability.js';

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER_REGEX = /^\d{6,20}$/;

export async function listBankAccounts(orgId, supabase) {
  const profile = await getBusinessProfile(orgId, supabase);
  if (!profile) return [];

  const { data: links } = await supabase
    .from('business_profile_bank_accounts')
    .select('bank_account_id, is_default, sort_order')
    .eq('business_profile_id', profile.id)
    .is('deleted_at', null);

  if (!links || links.length === 0) return [];

  const accountIds = links.map((l) => l.bank_account_id);
  const { data: accounts } = await supabase
    .from('bank_accounts')
    .select('id, name, bank_name, account_number, ifsc_code, branch_name')
    .in('id', accountIds)
    .is('deleted_at', null)
    .eq('is_active', true);

  const accountsById = {};
  (accounts || []).forEach((a) => { accountsById[a.id] = a; });

  return links
    .map((l) => {
      const acc = accountsById[l.bank_account_id];
      return acc ? { ...acc, is_default: l.is_default, sort_order: l.sort_order } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
}

export async function createBankAccount(orgId, fields, supabase) {
  const { name, bank_name, account_number, ifsc_code, branch_name } = fields || {};
  if (!name || !name.trim()) {
    return { success: false, error: 'Account name is required.' };
  }

  let normalizedIfsc = null;
  if (ifsc_code && ifsc_code.trim()) {
    normalizedIfsc = ifsc_code.trim().toUpperCase();
    if (!IFSC_REGEX.test(normalizedIfsc)) {
      return { success: false, error: 'IFSC code format looks incorrect (expected e.g. HDFC0001234).' };
    }
  }

  let normalizedAccountNumber = null;
  if (account_number && account_number.trim()) {
    normalizedAccountNumber = account_number.trim();
    if (!ACCOUNT_NUMBER_REGEX.test(normalizedAccountNumber)) {
      return { success: false, error: 'Account number should contain only digits (6-20 characters).' };
    }
  }

  const profile = await getBusinessProfile(orgId, supabase);
  if (!profile) return { success: false, error: 'Could not access business profile.' };

  const { data: account, error: insertErr } = await supabase
    .from('bank_accounts')
    .insert({
      organisation_id: orgId,
      name: name.trim(),
      bank_name: bank_name?.trim() || null,
      account_number: normalizedAccountNumber,
      ifsc_code: normalizedIfsc,
      branch_name: branch_name?.trim() || null,
    })
    .select()
    .single();
  if (insertErr || !account) {
    console.error('[bankAccountsService] create insert failed:', insertErr);
    return { success: false, error: 'Could not create bank account.' };
  }

  const { data: existingLinks } = await supabase
    .from('business_profile_bank_accounts')
    .select('id')
    .eq('business_profile_id', profile.id)
    .is('deleted_at', null);
  const isFirst = !existingLinks || existingLinks.length === 0;

  const { data: maxSortRow } = await supabase
    .from('business_profile_bank_accounts')
    .select('sort_order')
    .eq('business_profile_id', profile.id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSortOrder = (maxSortRow?.sort_order || 0) + 1;

  const { error: linkErr } = await supabase.from('business_profile_bank_accounts').insert({
    organisation_id: orgId,
    business_profile_id: profile.id,
    bank_account_id: account.id,
    is_default: isFirst,
    sort_order: nextSortOrder,
  });
  if (linkErr) {
    console.error('[bankAccountsService] link insert failed, rolling back orphaned account row:', linkErr);
    await supabase.from('bank_accounts').delete().eq('id', account.id);
    return { success: false, error: 'Could not save bank account. Please try again.' };
  }

  return { success: true, account: { ...account, is_default: isFirst } };
}

export async function updateBankAccount(orgId, accountId, fields, supabase) {
  fields = fields || {};
  const updateCols = {};

  if (fields.name !== undefined) {
    if (!fields.name || !fields.name.trim()) {
      return { success: false, error: 'Account name is required.' };
    }
    updateCols.name = fields.name.trim();
  }
  if (fields.bank_name !== undefined) updateCols.bank_name = fields.bank_name?.trim() || null;
  if (fields.account_number !== undefined) {
    if (fields.account_number && fields.account_number.trim()) {
      const normalized = fields.account_number.trim();
      if (!ACCOUNT_NUMBER_REGEX.test(normalized)) {
        return { success: false, error: 'Account number should contain only digits (6-20 characters).' };
      }
      updateCols.account_number = normalized;
    } else {
      updateCols.account_number = null;
    }
  }
  if (fields.branch_name !== undefined) updateCols.branch_name = fields.branch_name?.trim() || null;
  if (fields.ifsc_code !== undefined) {
    if (fields.ifsc_code && fields.ifsc_code.trim()) {
      const normalized = fields.ifsc_code.trim().toUpperCase();
      if (!IFSC_REGEX.test(normalized)) {
        return { success: false, error: 'IFSC code format looks incorrect (expected e.g. HDFC0001234).' };
      }
      updateCols.ifsc_code = normalized;
    } else {
      updateCols.ifsc_code = null;
    }
  }

  if (Object.keys(updateCols).length > 0) {
    updateCols.updated_at = new Date().toISOString();
    const { error } = await supabase.from('bank_accounts')
      .update(updateCols).eq('id', accountId).eq('organisation_id', orgId);
    if (error) {
      console.error('[bankAccountsService] update failed:', error);
      return { success: false, error: 'Could not update bank account.' };
    }
  }

  if (fields.is_default === true) {
    const profile = await getBusinessProfile(orgId, supabase);
    if (!profile) return { success: false, error: 'Could not access business profile.' };
    await supabase.from('business_profile_bank_accounts')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('business_profile_id', profile.id)
      .is('deleted_at', null);
    await supabase.from('business_profile_bank_accounts')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('business_profile_id', profile.id)
      .eq('bank_account_id', accountId)
      .is('deleted_at', null);
  }

  return { success: true };
}

export async function deleteBankAccount(orgId, accountId, supabase) {
  const profile = await getBusinessProfile(orgId, supabase);

  let wasDefault = false;
  if (profile) {
    const { data: link } = await supabase.from('business_profile_bank_accounts')
      .select('is_default').eq('business_profile_id', profile.id)
      .eq('bank_account_id', accountId).maybeSingle();
    wasDefault = link?.is_default === true;
  }

  const { error } = await supabase.from('bank_accounts')
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq('id', accountId)
    .eq('organisation_id', orgId);
  if (error) {
    console.error('[bankAccountsService] delete failed:', error);
    return { success: false, error: 'Could not delete bank account.' };
  }

  if (profile) {
    const { error: linkDeleteErr } = await supabase.from('business_profile_bank_accounts')
      .update({ deleted_at: new Date().toISOString(), is_default: false, updated_at: new Date().toISOString() })
      .eq('business_profile_id', profile.id)
      .eq('bank_account_id', accountId);
    if (linkDeleteErr) {
      console.error('[bankAccountsService] CRITICAL: account soft-deleted but join-row close-out failed -- possible stale is_default on a deleted link:', linkDeleteErr);
    }
  }

  if (wasDefault && profile) {
    const remaining = await listBankAccounts(orgId, supabase);
    if (remaining.length > 0) {
      await supabase.from('business_profile_bank_accounts')
        .update({ is_default: true, updated_at: new Date().toISOString() })
        .eq('business_profile_id', profile.id)
        .eq('bank_account_id', remaining[0].id)
        .is('deleted_at', null);
    }
  }

  return { success: true };
}
