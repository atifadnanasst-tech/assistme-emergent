/**
 * AssistMe — customer/[id]/business-profile.tsx (CustomerBusinessProfileScreen)
 * Aug 2026, ATT list item #9
 *
 * Editable business-profile form for a CUSTOMER (not the owner's own
 * business profile -- see settings/profile.tsx for that). Reuses the
 * exact same shell/section/field primitives as settings/profile.tsx
 * (SettingsScreenShell, SettingsSection, SettingsField) -- these were
 * already fully generic with no org-specific logic, so no new shared
 * abstraction was needed. Real code reuse via existing components,
 * zero risk to the existing, working owner's-profile screen. Designed
 * so a future session could migrate settings/profile.tsx's simpler
 * fields onto the same pattern too, without doing that migration now.
 *
 * Entry point: Customer chat -> 3-dot menu -> "Business Details"
 *
 * Backend:
 *   GET   /api/customer/:customer_id/business-profile
 *   PATCH /api/customer/:customer_id/business-profile
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../contexts/AuthContext';
import { authService } from '../../../lib/auth';
import { supabase } from '../../../lib/supabase';
import { SettingsScreenShell } from '../../../components/settings/SettingsScreenShell';
import { SettingsSection } from '../../../components/settings/SettingsSection';
import { SettingsField } from '../../../components/settings/SettingsField';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export default function CustomerBusinessProfileScreen() {
  const router = useRouter();
  const { id: customerId } = useLocalSearchParams<{ id: string }>();
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [company, setCompany] = useState('');
  const [taxId, setTaxId] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [billingLine1, setBillingLine1] = useState('');
  const [billingLine2, setBillingLine2] = useState('');
  const [billingCity, setBillingCity] = useState('');
  const [billingState, setBillingState] = useState('');
  const [billingPostal, setBillingPostal] = useState('');
  const [shippingLine1, setShippingLine1] = useState('');
  const [shippingLine2, setShippingLine2] = useState('');
  const [shippingCity, setShippingCity] = useState('');
  const [shippingState, setShippingState] = useState('');
  const [shippingPostal, setShippingPostal] = useState('');

  const getToken = useCallback(async () => {
    const token = await authService.getAccessToken();
    if (!token) {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      router.replace('/login');
      return null;
    }
    return token;
  }, [setIsAuthenticated, router]);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/customer/${customerId}/business-profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCompany(data.customer?.company || '');
      setTaxId(data.customer?.tax_id || '');
      setPhone(data.customer?.phone || '');
      setEmail(data.customer?.email || '');
      if (data.billing_address) {
        setBillingLine1(data.billing_address.line1 || '');
        setBillingLine2(data.billing_address.line2 || '');
        setBillingCity(data.billing_address.city || '');
        setBillingState(data.billing_address.state || '');
        setBillingPostal(data.billing_address.postal_code || '');
      }
      if (data.shipping_address) {
        setShippingLine1(data.shipping_address.line1 || '');
        setShippingLine2(data.shipping_address.line2 || '');
        setShippingCity(data.shipping_address.city || '');
        setShippingState(data.shipping_address.state || '');
        setShippingPostal(data.shipping_address.postal_code || '');
      }
    } catch (err) {
      setError('Could not load customer business profile. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [getToken, customerId]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/customer/${customerId}/business-profile`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company, tax_id: taxId, phone, email,
          billing_address: { line1: billingLine1, line2: billingLine2, city: billingCity, state: billingState, postal_code: billingPostal },
          shipping_address: { line1: shippingLine1, line2: shippingLine2, city: shippingCity, state: shippingState, postal_code: shippingPostal },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.back();
    } catch (err) {
      setError('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsScreenShell
      title="Customer Business Details"
      loading={loading}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRetry={loadProfile}
    >
      <SettingsSection title="Business Details">
        <SettingsField label="Company Name" value={company} onChangeText={setCompany} placeholder="e.g. Sharma Traders Pvt Ltd" />
        <SettingsField label="GSTIN" value={taxId} onChangeText={setTaxId} placeholder="e.g. 29AABCU9603R1ZM" autoCapitalize="characters" />
        <SettingsField label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <SettingsField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      </SettingsSection>

      <SettingsSection title="Billing Address">
        <SettingsField label="Address Line 1" value={billingLine1} onChangeText={setBillingLine1} />
        <SettingsField label="Address Line 2" value={billingLine2} onChangeText={setBillingLine2} />
        <SettingsField label="City" value={billingCity} onChangeText={setBillingCity} />
        <SettingsField label="State" value={billingState} onChangeText={setBillingState} hint="Used to determine CGST/SGST vs IGST on invoices" />
        <SettingsField label="Postal Code" value={billingPostal} onChangeText={setBillingPostal} keyboardType="numeric" />
      </SettingsSection>

      <SettingsSection title="Shipping Address">
        <SettingsField label="Address Line 1" value={shippingLine1} onChangeText={setShippingLine1} />
        <SettingsField label="Address Line 2" value={shippingLine2} onChangeText={setShippingLine2} />
        <SettingsField label="City" value={shippingCity} onChangeText={setShippingCity} />
        <SettingsField label="State" value={shippingState} onChangeText={setShippingState} />
        <SettingsField label="Postal Code" value={shippingPostal} onChangeText={setShippingPostal} keyboardType="numeric" />
      </SettingsSection>
    </SettingsScreenShell>
  );
}
