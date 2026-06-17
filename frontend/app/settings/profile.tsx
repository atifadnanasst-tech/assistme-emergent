/**
 * AssistMe — settings/profile.tsx (BusinessProfileScreen)
 * Phase 2, Jun 2026
 *
 * Manual form for editing business identity.
 * Entry point: Home → 3-dot menu → Settings → Business Profile
 *
 * Backend:
 *   GET  /api/business-profile → { profile }
 *   PATCH /api/business-profile → { [field_key]: value } → { profile }
 *   POST /api/upload → FormData(file) → { url, mime_type, storage_path, size, name }
 *
 * Auth pattern matches products.tsx exactly:
 *   authService.getAccessToken() + clearSession + signOut + router.replace('/login')
 *
 * Uses reusable shell: SettingsScreenShell, SettingsSection, SettingsField
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, Image, ActivityIndicator, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { SettingsScreenShell } from '../../components/settings/SettingsScreenShell';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { SettingsField } from '../../components/settings/SettingsField';
import { Ionicons } from '@expo/vector-icons';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export default function BusinessProfileScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [signatureUploading, setSignatureUploading] = useState(false);
  const [subscriptionPlan, setSubscriptionPlan] = useState('free');
  const [showAssistmeBranding, setShowAssistmeBranding] = useState(true);

  // Form fields — field_key names match WRITABLE_FIELDS in setBusinessProfileCapability.js
  // and column names in business_profiles table (schema_sql_v3.txt verified)
  const [businessName, setBusinessName] = useState('');
  const [gstin, setGstin] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [termsText, setTermsText] = useState('');

  // Auth token — exact pattern from products.tsx
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

  // ── Load profile ──────────────────────────────────────────────────────────

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/business-profile`, {
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
      const { profile, subscription_plan } = await res.json();
      setSubscriptionPlan(subscription_plan || 'free');
      setShowAssistmeBranding(profile.show_assistme_branding ?? true);
      setBusinessName(profile.business_name || '');
      setGstin(profile.gstin || '');
      setPhone(profile.phone || '');
      setEmail(profile.email || '');
      setAddressLine1(profile.address_line1 || '');
      setAddressLine2(profile.address_line2 || '');
      setCity(profile.city || '');
      setStateName(profile.state || '');
      setPostalCode(profile.postal_code || '');
      setLogoUrl(profile.logo_url || null);
      setSignatureUrl(profile.signature_url || null);
      setTermsText(profile.terms_text || '');
    } catch (err) {
      setError('Could not load business profile. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [getToken, setIsAuthenticated, router]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  // ── Logo upload ───────────────────────────────────────────────────────────

  const handleLogoUpload = async () => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images' as any,
        allowsEditing: false,
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setLogoUploading(true);
      const token = await getToken();
      if (!token) return;

      const filename = asset.uri.split('/').pop() || 'logo.jpg';
      const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';

      const formData = new FormData();
      formData.append('file', { uri: asset.uri, name: filename, type: mime } as any);

      const uploadRes = await fetch(`${BACKEND_URL}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!uploadRes.ok) throw new Error('Upload failed');
      const { url } = await uploadRes.json();
      setLogoUrl(url);
    } catch (err) {
      Alert.alert('Upload Failed', 'Could not upload logo. Please try again.');
    } finally {
      setLogoUploading(false);
    }
  };

  // Mirrors handleLogoUpload exactly (UX-2, Jun 17 2026) -- same picker call,
  // same allowsEditing:false fix, same upload/permission/error pattern.
  const handleSignatureUpload = async () => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images' as any,
        allowsEditing: false,
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setSignatureUploading(true);
      const token = await getToken();
      if (!token) return;

      const filename = asset.uri.split('/').pop() || 'signature.jpg';
      const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';

      const formData = new FormData();
      formData.append('file', { uri: asset.uri, name: filename, type: mime } as any);

      const uploadRes = await fetch(`${BACKEND_URL}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!uploadRes.ok) throw new Error('Upload failed');
      const { url } = await uploadRes.json();
      setSignatureUrl(url);
    } catch (err) {
      Alert.alert('Upload Failed', 'Could not upload signature. Please try again.');
    } finally {
      setSignatureUploading(false);
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!businessName.trim()) {
      Alert.alert('Required', 'Business name is required.');
      return;
    }
    setSaving(true);
    try {
      const token = await getToken();
      if (!token) return;
      const payload: Record<string, string | null> = {
        business_name: businessName.trim(),
        gstin: gstin.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address_line1: addressLine1.trim() || null,
        address_line2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: stateName.trim() || null,
        postal_code: postalCode.trim() || null,
        logo_url: logoUrl || null,
        signature_url: signatureUrl || null,
        terms_text: termsText.trim() || null,
        show_assistme_branding: showAssistmeBranding,
      };
      const res = await fetch(`${BACKEND_URL}/api/business-profile`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      Alert.alert('Saved', 'Business profile updated successfully.');
    } catch (err: any) {
      Alert.alert('Save Failed', err.message || 'Could not save profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Footer ────────────────────────────────────────────────────────────────

  const footer = (
    <View style={styles.footer}>
      <Text style={styles.tipText}>
        💡 Tip: You can also update these fields from the AI tab.{'\n'}
        Example: "My GSTIN is 27AAAAA0000A1Z5"
      </Text>
      <TouchableOpacity
        style={[styles.saveBottomBtn, saving && styles.saveBottomBtnDisabled]}
        onPress={handleSave}
        disabled={saving}
      >
        {saving
          ? <ActivityIndicator size="small" color="#FFFFFF" />
          : <Text style={styles.saveBottomBtnText}>Save Business Profile</Text>
        }
      </TouchableOpacity>
      <View style={styles.bottomPad} />
    </View>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SettingsScreenShell
      title="Business Profile"
      loading={loading}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRetry={loadProfile}
      footer={footer}
    >
      {/* Logo */}
      <View style={styles.logoSection}>
        <TouchableOpacity
          style={styles.logoContainer}
          onPress={handleLogoUpload}
          disabled={logoUploading || saving}
        >
          {logoUploading ? (
            <ActivityIndicator size="small" color="#075E54" />
          ) : logoUrl ? (
            <Image source={{ uri: logoUrl }} style={styles.logoImage} resizeMode="contain" />
          ) : (
            <View style={styles.logoPlaceholder}>
              <Ionicons name="business-outline" size={36} color="#CCCCCC" />
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={handleLogoUpload} disabled={logoUploading || saving}>
          <Text style={styles.logoLabel}>{logoUrl ? 'Change Logo' : 'Upload Logo'}</Text>
        </TouchableOpacity>
        <Text style={styles.logoHint}>Appears on invoices and PDF documents</Text>
      </View>

      {/* Signature -- mirrors Logo section exactly, reuses same styles (UX-2) */}
      <View style={styles.logoSection}>
        <TouchableOpacity
          style={styles.logoContainer}
          onPress={handleSignatureUpload}
          disabled={signatureUploading || saving}
        >
          {signatureUploading ? (
            <ActivityIndicator size="small" color="#075E54" />
          ) : signatureUrl ? (
            <Image source={{ uri: signatureUrl }} style={styles.logoImage} resizeMode="contain" />
          ) : (
            <View style={styles.logoPlaceholder}>
              <Ionicons name="create-outline" size={36} color="#CCCCCC" />
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={handleSignatureUpload} disabled={signatureUploading || saving}>
          <Text style={styles.logoLabel}>{signatureUrl ? 'Change Signature' : 'Upload Signature'}</Text>
        </TouchableOpacity>
        <Text style={styles.logoHint}>Appears above "Authorized Signatory" on invoices</Text>
      </View>

      {/* Business Details */}
      <SettingsSection title="Business Details">
        <SettingsField
          label="Business Name"
          value={businessName}
          onChangeText={setBusinessName}
          placeholder="e.g. BW Solution Technologies"
          required
          editable={!saving}
          autoCapitalize="words"
        />
        <SettingsField
          label="GSTIN"
          value={gstin}
          onChangeText={(t) => setGstin(t.toUpperCase())}
          placeholder="e.g. 27AAAAA0000A1Z5"
          editable={!saving}
          autoCapitalize="characters"
          maxLength={15}
        />
        <View style={styles.row}>
          <SettingsField
            label="Phone"
            value={phone}
            onChangeText={setPhone}
            placeholder="9000000000"
            editable={!saving}
            keyboardType="phone-pad"
            maxLength={15}
            style={styles.flex1}
          />
          <View style={styles.rowGap} />
          <SettingsField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@business.com"
            editable={!saving}
            keyboardType="email-address"
            autoCapitalize="none"
            style={styles.flex1}
          />
        </View>
      </SettingsSection>

      {/* Address */}
      <SettingsSection title="Address">
        <SettingsField
          label="Address Line 1"
          value={addressLine1}
          onChangeText={setAddressLine1}
          placeholder="Street, Building, Area"
          editable={!saving}
        />
        <SettingsField
          label="Address Line 2"
          value={addressLine2}
          onChangeText={setAddressLine2}
          placeholder="Locality, Landmark (optional)"
          editable={!saving}
        />
        <View style={styles.row}>
          <SettingsField
            label="City"
            value={city}
            onChangeText={setCity}
            placeholder="Kolkata"
            editable={!saving}
            autoCapitalize="words"
            style={styles.flex1}
          />
          <View style={styles.rowGap} />
          <SettingsField
            label="State"
            value={stateName}
            onChangeText={setStateName}
            placeholder="West Bengal"
            editable={!saving}
            autoCapitalize="words"
            style={styles.flex1}
          />
        </View>
        <SettingsField
          label="Postal Code"
          value={postalCode}
          onChangeText={setPostalCode}
          placeholder="700017"
          editable={!saving}
          keyboardType="numeric"
          maxLength={6}
          style={styles.halfWidth}
        />
      </SettingsSection>

      {/* Invoice Terms */}
      <SettingsSection title="Invoice Terms">
        <SettingsField
          label="Terms & Conditions"
          value={termsText}
          onChangeText={setTermsText}
          placeholder="e.g. Payment due within 30 days."
          editable={!saving}
          multiline
          numberOfLines={4}
          hint="Appears at the bottom of your invoice PDF."
        />
      </SettingsSection>

      {/* Branding */}
      <SettingsSection title="Branding">
        <View style={styles.brandingRow}>
          <View style={styles.brandingTextWrap}>
            <Text style={styles.brandingLabel}>Show "Generated using AssistMe" on documents</Text>
            {subscriptionPlan !== 'business' && (
              <Text style={styles.brandingHint}>Available on the Business plan</Text>
            )}
          </View>
          <Switch
            value={showAssistmeBranding}
            onValueChange={setShowAssistmeBranding}
            disabled={subscriptionPlan !== 'business' || saving}
            trackColor={{ false: '#CCCCCC', true: '#25D366' }}
          />
        </View>
      </SettingsSection>
    </SettingsScreenShell>
  );
}

const styles = StyleSheet.create({
  logoSection: { alignItems: 'center', paddingVertical: 20 },
  logoContainer: {
    width: 90, height: 90, borderRadius: 12,
    borderWidth: 2, borderColor: '#E0E0E0', borderStyle: 'dashed',
    backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center',
    marginBottom: 8, overflow: 'hidden',
  },
  logoImage: { width: 90, height: 90 },
  logoPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  logoLabel: { fontSize: 14, color: '#075E54', fontWeight: '600', marginBottom: 4 },
  logoHint: { fontSize: 12, color: '#888888' },
  brandingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  brandingTextWrap: { flex: 1, marginRight: 12 },
  brandingLabel: { fontSize: 14, color: '#1A1A1A', fontWeight: '500' },
  brandingHint: { fontSize: 12, color: '#888888', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  rowGap: { width: 12 },
  flex1: { flex: 1 },
  halfWidth: { width: '50%' },
  footer: { marginTop: 8 },
  tipText: {
    fontSize: 12, color: '#888888', textAlign: 'center',
    fontStyle: 'italic', marginBottom: 16, lineHeight: 18,
  },
  saveBottomBtn: {
    backgroundColor: '#075E54', paddingVertical: 14,
    borderRadius: 10, alignItems: 'center',
  },
  saveBottomBtnDisabled: { opacity: 0.5 },
  saveBottomBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  bottomPad: { height: 40 },
});
