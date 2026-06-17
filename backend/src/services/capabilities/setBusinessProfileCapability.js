/**
 * AssistMe — setBusinessProfileCapability.js
 * Created: Phase 2, Jun 2026
 *
 * PURPOSE:
 *   Mutates the default business_profiles row for this org.
 *   Two call paths:
 *   1. AI single-field: called from execute-plan (capability = 'set_business_profile')
 *   2. Form bulk save: called from PATCH /api/business-profile (BusinessProfileScreen)
 *
 * SECURITY:
 *   - Only fields in WRITABLE_FIELDS whitelist are accepted.
 *   - AI sees only field_key — never table_name or column path.
 *   - organisation_id always sourced from JWT, never from client.
 *   - Financial fields never in whitelist. Ever.
 *
 * header_cache:
 *   Written on every successful save (AI or manual form).
 *   PDF generation reads profile.header_cache only — never re-assembles from raw fields.
 *   Shape verified against schema_sql_v3.txt lines 1539-1543:
 *   { business_name, gstin, address_line1, address_line2, city, state,
 *     postal_code, phone, email, logo_url, signature_url, terms_text }
 *   footer_text is assembled at PDF generation time from terms_text +
 *   system_config.pdf_footer_promo — intentionally NOT stored in header_cache.
 *
 * PROFILE-DB-01 (post-v1):
 *   Add DB-level unique constraint on (organisation_id) for default profiles.
 *   Application-level checks cannot fully prevent concurrent default profile
 *   creation. Accepted risk for v1 due to low concurrency and owner-only access.
 *
 * PROFILE-STYLE-01 (post-v1):
 *   invoice_template_profile field — stores detected invoice style preferences
 *   (logo placement, colors, header/footer layout) from owner-uploaded samples.
 *   Will be added to WRITABLE_FIELDS and header_cache when invoice styling ships.
 */

// ── Whitelist ─────────────────────────────────────────────────────────────────

const WRITABLE_FIELDS = {
  business_name: { column: 'business_name', label: 'Business Name', required: true  },
  gstin:         { column: 'gstin',          label: 'GSTIN',         required: false },
  phone:         { column: 'phone',          label: 'Phone',         required: false },
  email:         { column: 'email',          label: 'Email',         required: false },
  address_line1: { column: 'address_line1',  label: 'Address Line 1',required: false },
  address_line2: { column: 'address_line2',  label: 'Address Line 2',required: false },
  city:          { column: 'city',           label: 'City',          required: false },
  state:         { column: 'state',          label: 'State',         required: false },
  postal_code:   { column: 'postal_code',    label: 'Postal Code',   required: false },
  logo_url:      { column: 'logo_url',       label: 'Logo',          required: false },
  signature_url: { column: 'signature_url',  label: 'Signature',     required: false },
  terms_text:    { column: 'terms_text',     label: 'Terms & Conditions', required: false },
  show_assistme_branding: { column: 'show_assistme_branding', label: 'Show AssistMe Branding', required: false, type: 'boolean' },
};

// ── Field validation ──────────────────────────────────────────────────────────
// TODO POST-V1: centralize GSTIN normalization (currently exists in validation
// and persistence separately — acceptable for v1).

function _validateField(key, value) {
  if (value === null || value === undefined) return null;

  const v = String(value).trim();

  if (key === 'business_name') {
    if (!v) return 'Business name cannot be empty.';
  }

  if (key === 'email') {
    if (v && !v.includes('@')) return 'Email must contain @.';
  }

  if (key === 'gstin') {
    // Normalize to uppercase before validation — owners may paste lowercase
    const normalized = v.toUpperCase();
    if (normalized && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(normalized)) {
      return 'GSTIN format invalid. Example: 27AAAAA0000A1Z5';
    }
  }

  if (key === 'postal_code') {
    if (v && !/^[0-9]{6}$/.test(v)) return 'Postal code must be exactly 6 digits.';
  }

  if (key === 'phone') {
    if (v && v.length > 15) return 'Phone number too long (max 15 characters).';
  }

  return null;
}

// ── AI single-field update (execute-plan path) ────────────────────────────────

export async function setBusinessProfileCapability(params, orgId, supabase) {
  const { field_key, new_value } = params;

  if (!field_key) return _errorResult('No field specified.');
  if (new_value === undefined || new_value === null || String(new_value).trim() === '') {
    return _errorResult('No value provided.');
  }

  const fieldDef = WRITABLE_FIELDS[field_key];
  if (!fieldDef) {
    return _errorResult(
      `"${field_key}" cannot be updated via AI. Supported fields: ` +
      Object.keys(WRITABLE_FIELDS).join(', ') + '.'
    );
  }

  // Normalize GSTIN to uppercase before saving
  let parsedValue;
  if (fieldDef.type === 'boolean') {
    parsedValue = new_value === true || new_value === 'true';
  } else {
    parsedValue = String(new_value).trim();
    if (field_key === 'gstin') parsedValue = parsedValue.toUpperCase();
  }

  const validationError = _validateField(field_key, parsedValue);
  if (validationError) return _errorResult(validationError);

  const profile = await _getOrCreateDefaultProfile(orgId, supabase);
  if (!profile) return _errorResult('Could not access business profile. Please try again.');

  const previousValue = profile[fieldDef.column] ?? null;

  const updatePayload = {
    [fieldDef.column]: parsedValue,
    header_cache: _buildHeaderCache({ ...profile, [fieldDef.column]: parsedValue }),
    updated_at: new Date().toISOString(),
  };

  const { error: updateErr } = await supabase
    .from('business_profiles')
    .update(updatePayload)
    .eq('id', profile.id)
    .eq('organisation_id', orgId);

  if (updateErr) {
    console.error('[setBusinessProfileCapability] update failed:', updateErr.message);
    return _errorResult('Update failed. Please try again.');
  }

  console.log('[setBusinessProfileCapability]', {
    field_key, org: orgId, previous: previousValue, new: parsedValue,
  });

  return {
    response_text: `Done. ${fieldDef.label} updated to "${parsedValue}".`,
    chart_data: null,
    next_action: { text: '→ Want to update another field or preview your invoice PDF?' },
    message_type: 'ai_response',
    _mutation_result: {
      affected_count: 1,
      operation: 'set_business_profile',
      is_success: true,
      field_key,
      field_label: fieldDef.label,
      previous_value: previousValue,
      new_value: parsedValue,
      profile_id: profile.id,
    },
  };
}

// ── Bulk update (BusinessProfileScreen form save path) ────────────────────────

export async function updateBusinessProfileFields(orgId, fields, supabase) {
  if (!fields || Object.keys(fields).length === 0) {
    return { success: false, error: 'No fields provided.' };
  }

  for (const [key, value] of Object.entries(fields)) {
    const fieldDef = WRITABLE_FIELDS[key];
    if (!fieldDef) return { success: false, error: `Unknown field: ${key}` };

    if (fieldDef.required && (value === null || value === undefined || String(value).trim() === '')) {
      return { success: false, error: `${fieldDef.label} is required and cannot be empty.` };
    }

    const validationError = _validateField(key, value);
    if (validationError) return { success: false, error: validationError };
  }

  const updateCols = {};
  for (const [key, value] of Object.entries(fields)) {
    const fieldDef = WRITABLE_FIELDS[key];
    let finalValue;
    if (fieldDef.type === 'boolean') {
      finalValue = value === true || value === 'true';
    } else {
      finalValue = (value === '' || value === null) ? null : String(value).trim();
      if (key === 'gstin' && finalValue) finalValue = finalValue.toUpperCase();
    }
    updateCols[fieldDef.column] = finalValue;
  }

  const profile = await _getOrCreateDefaultProfile(orgId, supabase);
  if (!profile) return { success: false, error: 'Could not access business profile.' };

  const merged = { ...profile, ...updateCols };
  updateCols.header_cache = _buildHeaderCache(merged);
  updateCols.updated_at = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabase
    .from('business_profiles')
    .update(updateCols)
    .eq('id', profile.id)
    .eq('organisation_id', orgId)
    .select('*')
    .single();

  if (updateErr) {
    console.error('[updateBusinessProfileFields] failed:', updateErr.message);
    return { success: false, error: updateErr.message };
  }

  return { success: true, profile: updated };
}

// ── GET (form load path) ──────────────────────────────────────────────────────

export async function getBusinessProfile(orgId, supabase) {
  return _getOrCreateDefaultProfile(orgId, supabase);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _getOrCreateDefaultProfile(orgId, supabase) {
  // PROFILE-DB-01: No DB-level uniqueness guarantee on default profiles.
  // Using order+limit(1) instead of maybeSingle() so duplicate defaults
  // (if they ever appear due to race) do not break the fetch.
  const { data: rows, error: fetchErr } = await supabase
    .from('business_profiles')
    .select('*')
    .eq('organisation_id', orgId)
    .eq('is_active', true)
    .eq('is_default', true)
    .order('created_at', { ascending: true })
    .limit(1);

  if (fetchErr) {
    console.error('[setBusinessProfileCapability] fetch error:', fetchErr.message);
    return null;
  }

  if (rows && rows.length > 0) return rows[0];

  // No default profile — create one seeded from org name
  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();

  const defaultName = org?.name || 'My Business';

  const { data: created, error: createErr } = await supabase
    .from('business_profiles')
    .insert({
      organisation_id: orgId,
      business_name: defaultName,
      is_default: true,
      is_active: true,
      header_cache: _buildHeaderCache({ business_name: defaultName }),
    })
    .select('*')
    .single();

  if (createErr) {
    console.error('[setBusinessProfileCapability] create error:', createErr.message);
    return null;
  }

  console.log('[setBusinessProfileCapability] Created default profile for org:', orgId);
  return created;
}

function _buildHeaderCache(profile) {
  return {
    business_name: profile.business_name  || null,
    gstin:         profile.gstin          || null,
    address_line1: profile.address_line1  || null,
    address_line2: profile.address_line2  || null,
    city:          profile.city           || null,
    state:         profile.state          || null,
    postal_code:   profile.postal_code    || null,
    phone:         profile.phone          || null,
    email:         profile.email          || null,
    logo_url:      profile.logo_url       || null,
    signature_url: profile.signature_url  || null,
    terms_text:    profile.terms_text     || null,
  };
}

function _errorResult(message) {
  return {
    response_text: message,
    chart_data: null,
    next_action: null,
    message_type: 'ai_response',
    _mutation_result: { affected_count: 0, operation: 'failed', is_success: false },
  };
}

export { WRITABLE_FIELDS };
