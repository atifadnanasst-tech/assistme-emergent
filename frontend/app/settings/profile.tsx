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
  const [bankAccounts, setBankAccounts] = useState([]);
  const [bankAccountsLoading, setBankAccountsLoading] = useState(true);
  const [expandedAccountId, setExpandedAccountId] = useState(null);
  const [savingAccountId, setSavingAccountId] = useState(null);
  const [expandedSnapshot, setExpandedSnapshot] = useState(null);
  const [addingNewAccount, setAddingNewAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({ name: '', bank_name: '', account_holder_name: '', account_number: '', ifsc_code: '', branch_name: '' });
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [extractingBankImage, setExtractingBankImage] = useState(false);
  const [bankOcrToast, setBankOcrToast] = useState('');

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

  const loadBankAccounts = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/business-profile/bank-accounts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load bank accounts');
      const { bank_accounts } = await res.json();
      setBankAccounts(bank_accounts || []);
    } catch (err) {
      console.error('loadBankAccounts error:', err);
    } finally {
      setBankAccountsLoading(false);
    }
  }, [getToken]);

  useEffect(() => { loadProfile(); }, [loadProfile]);
  useEffect(() => { loadBankAccounts(); }, [loadBankAccounts]);

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

  // ── Bank Accounts -- each row saves independently via its own endpoint,
  // NOT bundled into the screen's main handleSave() payload below.
  const updateLocalBankField = (accountId, field, value) => {
    setBankAccounts((prev) => prev.map((a) => (a.id === accountId ? { ...a, [field]: value } : a)));
  };

  const handleSaveBankAccount = async (accountId) => {
    const account = bankAccounts.find((a) => a.id === accountId);
    if (!account) return;
    if (!account.name || !account.name.trim()) {
      Alert.alert('Required', 'Account name is required.');
      return;
    }
    setSavingAccountId(accountId);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/business-profile/bank-accounts/${accountId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: account.name,
          bank_name: account.bank_name,
          account_holder_name: account.account_holder_name,
          account_number: account.account_number,
          ifsc_code: account.ifsc_code,
          branch_name: account.branch_name,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Could Not Save', data.error || 'Please check the fields and try again.');
        return;
      }
      setExpandedAccountId(null);
      setExpandedSnapshot(null);
      await loadBankAccounts();
    } catch (err) {
      Alert.alert('Could Not Save', 'Please try again.');
    } finally {
      setSavingAccountId(null);
    }
  };

  const handleSetDefaultBankAccount = async (accountId) => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/business-profile/bank-accounts/${accountId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      });
      if (!res.ok) throw new Error('Failed to set default');
      await loadBankAccounts();
    } catch (err) {
      Alert.alert('Could Not Update', 'Please try again.');
    }
  };

  const handleBankImagePick = async (useCamera) => {
    try {
      const ImagePicker = await import('expo-image-picker');
      let result;
      if (useCamera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('Permission Required', 'Please allow camera access.');
          return;
        }
        result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.8 });
      } else {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('Permission Required', 'Please allow access to your photo library.');
          return;
        }
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', allowsEditing: false, quality: 0.8 });
      }
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setExtractingBankImage(true);
      const token = await getToken();
      if (!token) return;

      const filename = asset.uri.split('/').pop() || 'bankdoc.jpg';
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
      const { url, mime_type } = await uploadRes.json();

      const extractRes = await fetch(`${BACKEND_URL}/api/business-profile/bank-accounts/extract-from-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mime: mime_type }),
      });
      const extracted = await extractRes.json();
      if (!extractRes.ok || !extracted.success) {
        Alert.alert('Could Not Read Image', extracted.error || 'Please try again or enter details manually.');
        return;
      }
      setNewAccount((prev) => ({
        ...prev,
        bank_name: extracted.bank_name || prev.bank_name,
        account_holder_name: extracted.account_holder_name || prev.account_holder_name,
        account_number: extracted.account_number || prev.account_number,
        ifsc_code: extracted.ifsc_code || prev.ifsc_code,
        branch_name: extracted.branch_name || prev.branch_name,
      }));
      setBankOcrToast('Please check the details carefully. AI can make mistakes.');
      setTimeout(() => setBankOcrToast(''), 4000);
    } catch (err) {
      Alert.alert('Could Not Process Image', 'Please try again.');
    } finally {
      setExtractingBankImage(false);
    }
  };

  const handleCreateBankAccount = async () => {
    if (!newAccount.name.trim()) {
      Alert.alert('Required', 'Account name is required.');
      return;
    }
    setCreatingAccount(true);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${BACKEND_URL}/api/business-profile/bank-accounts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(newAccount),
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Could Not Add', data.error || 'Please check the fields and try again.');
        return;
      }
      setAddingNewAccount(false);
      setNewAccount({ name: '', bank_name: '', account_holder_name: '', account_number: '', ifsc_code: '', branch_name: '' });
      await loadBankAccounts();
    } catch (err) {
      Alert.alert('Could Not Add', 'Please try again.');
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleDeleteBankAccount = (accountId, accountName) => {
    Alert.alert(
      'Delete Bank Account',
      `Remove "${accountName}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const token = await getToken();
              if (!token) return;
              const res = await fetch(`${BACKEND_URL}/api/business-profile/bank-accounts/${accountId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok) throw new Error('Delete failed');
              if (expandedAccountId === accountId) setExpandedAccountId(null);
              await loadBankAccounts();
            } catch (err) {
              Alert.alert('Could Not Delete', 'Please try again.');
            }
          },
        },
      ]
    );
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

      {/* Signature -- relocated below Address, above Invoice Terms, left-aligned
          (distinct from Logo's centered top-of-screen treatment) */}
      <SettingsSection title="Signature">
        <View style={styles.signatureRow}>
          <TouchableOpacity
            style={styles.signatureThumb}
            onPress={handleSignatureUpload}
            disabled={signatureUploading || saving}
          >
            {signatureUploading ? (
              <ActivityIndicator size="small" color="#075E54" />
            ) : signatureUrl ? (
              <Image source={{ uri: signatureUrl }} style={styles.signatureThumbImage} resizeMode="contain" />
            ) : (
              <Ionicons name="create-outline" size={28} color="#CCCCCC" />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.signatureTextWrap}
            onPress={handleSignatureUpload}
            disabled={signatureUploading || saving}
          >
            <Text style={styles.logoLabel}>{signatureUrl ? 'Change Signature' : 'Upload Signature'}</Text>
            <Text style={styles.logoHint}>Appears above "Authorized Signatory" on invoices</Text>
          </TouchableOpacity>
        </View>
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

      {/* Bank Accounts -- each row saves independently via its own Save button,
          not the screen-level Save below. */}
      <SettingsSection title="Bank Accounts">
        {bankAccountsLoading ? (
          <ActivityIndicator size="small" color="#075E54" />
        ) : bankAccounts.length === 0 ? (
          <Text style={styles.bankEmptyText}>No bank accounts added yet.</Text>
        ) : (
          bankAccounts.map((acct) => {
            const isExpanded = expandedAccountId === acct.id;
            return (
              <View key={acct.id} style={styles.bankRow}>
                <View style={styles.bankRowHeader}>
                  <TouchableOpacity
                    style={styles.bankRowHeaderMain}
                    onPress={() => {
                      if (isExpanded) {
                        setExpandedAccountId(null);
                        setExpandedSnapshot(null);
                      } else {
                        setExpandedAccountId(acct.id);
                        setExpandedSnapshot({ ...acct });
                      }
                    }}
                  >
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={18} color="#666666" />
                    <Text style={styles.bankRowTitle}>
                      {acct.name}{acct.is_default ? ' (Default)' : ''}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDeleteBankAccount(acct.id, acct.name)}
                    style={styles.bankDeleteBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color="#CC3333" />
                  </TouchableOpacity>
                </View>

                {isExpanded && (
                  <View style={styles.bankExpanded}>
                    <SettingsField
                      label="Account Name"
                      value={acct.name}
                      onChangeText={(v) => updateLocalBankField(acct.id, 'name', v)}
                      editable={savingAccountId !== acct.id}
                    />
                    <SettingsField
                      label="Bank Name"
                      value={acct.bank_name || ''}
                      onChangeText={(v) => updateLocalBankField(acct.id, 'bank_name', v)}
                      editable={savingAccountId !== acct.id}
                    />
                    <SettingsField
                      label="Account Holder Name"
                      value={acct.account_holder_name || ''}
                      onChangeText={(v) => updateLocalBankField(acct.id, 'account_holder_name', v)}
                      placeholder="If different from business name"
                      editable={savingAccountId !== acct.id}
                    />
                    <SettingsField
                      label="Account Number"
                      value={acct.account_number || ''}
                      onChangeText={(v) => updateLocalBankField(acct.id, 'account_number', v)}
                      editable={savingAccountId !== acct.id}
                    />
                    <SettingsField
                      label="IFSC"
                      value={acct.ifsc_code || ''}
                      onChangeText={(v) => updateLocalBankField(acct.id, 'ifsc_code', v)}
                      editable={savingAccountId !== acct.id}
                    />
                    <SettingsField
                      label="Branch"
                      value={acct.branch_name || ''}
                      onChangeText={(v) => updateLocalBankField(acct.id, 'branch_name', v)}
                      editable={savingAccountId !== acct.id}
                    />
                    <TouchableOpacity
                      style={styles.bankDefaultRow}
                      onPress={() => handleSetDefaultBankAccount(acct.id)}
                      disabled={acct.is_default}
                    >
                      <Ionicons
                        name={acct.is_default ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={acct.is_default ? '#075E54' : '#999999'}
                      />
                      <Text style={styles.bankDefaultLabel}>Use as default payment account</Text>
                    </TouchableOpacity>
                    <View style={styles.bankRowActions}>
                      <TouchableOpacity
                        onPress={() => {
                          if (expandedSnapshot) {
                            setBankAccounts((prev) => prev.map((a) => (a.id === acct.id ? expandedSnapshot : a)));
                          }
                          setExpandedAccountId(null);
                          setExpandedSnapshot(null);
                        }}
                        disabled={savingAccountId === acct.id}
                      >
                        <Text style={styles.bankCancelText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.bankSaveBtn}
                        onPress={() => handleSaveBankAccount(acct.id)}
                        disabled={savingAccountId === acct.id}
                      >
                        <Text style={styles.bankSaveBtnText}>{savingAccountId === acct.id ? 'Saving...' : 'Save'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })
        )}

        {addingNewAccount ? (
          <View style={styles.bankExpanded}>
            <View style={styles.bankImportRow}>
              <Text style={styles.bankImportLabel}>Scan a passbook or cheque</Text>
              {extractingBankImage ? (
                <ActivityIndicator size="small" color="#075E54" />
              ) : (
                <View style={styles.bankImportIcons}>
                  <TouchableOpacity onPress={() => handleBankImagePick(true)} style={styles.bankImportIconBtn}>
                    <Ionicons name="camera-outline" size={20} color="#075E54" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleBankImagePick(false)} style={styles.bankImportIconBtn}>
                    <Ionicons name="images-outline" size={20} color="#075E54" />
                  </TouchableOpacity>
                </View>
              )}
            </View>
            {bankOcrToast ? (
              <View style={styles.bankOcrToast}>
                <Text style={styles.bankOcrToastText}>{bankOcrToast}</Text>
              </View>
            ) : null}
            <SettingsField
              label="Account Name"
              value={newAccount.name}
              onChangeText={(v) => setNewAccount({ ...newAccount, name: v })}
              placeholder="e.g. HDFC Current Account"
              editable={!creatingAccount}
            />
            <SettingsField
              label="Bank Name"
              value={newAccount.bank_name}
              onChangeText={(v) => setNewAccount({ ...newAccount, bank_name: v })}
              editable={!creatingAccount}
            />
            <SettingsField
              label="Account Holder Name"
              value={newAccount.account_holder_name}
              onChangeText={(v) => setNewAccount({ ...newAccount, account_holder_name: v })}
              placeholder="If different from business name"
              editable={!creatingAccount}
            />
            <SettingsField
              label="Account Number"
              value={newAccount.account_number}
              onChangeText={(v) => setNewAccount({ ...newAccount, account_number: v })}
              editable={!creatingAccount}
            />
            <SettingsField
              label="IFSC"
              value={newAccount.ifsc_code}
              onChangeText={(v) => setNewAccount({ ...newAccount, ifsc_code: v })}
              editable={!creatingAccount}
            />
            <SettingsField
              label="Branch"
              value={newAccount.branch_name}
              onChangeText={(v) => setNewAccount({ ...newAccount, branch_name: v })}
              editable={!creatingAccount}
            />
            <View style={styles.bankRowActions}>
              <TouchableOpacity
                onPress={() => { setAddingNewAccount(false); setNewAccount({ name: '', bank_name: '', account_holder_name: '', account_number: '', ifsc_code: '', branch_name: '' }); }}
                disabled={creatingAccount}
              >
                <Text style={styles.bankCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.bankSaveBtn} onPress={handleCreateBankAccount} disabled={creatingAccount}>
                <Text style={styles.bankSaveBtnText}>{creatingAccount ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity style={styles.addBankAccountBtn} onPress={() => setAddingNewAccount(true)}>
            <Ionicons name="add-circle" size={20} color="#075E54" />
            <Text style={styles.addBankAccountText}>Add Bank Account</Text>
          </TouchableOpacity>
        )}
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
  bankEmptyText: { fontSize: 13, color: '#999999', paddingVertical: 8 },
  bankRow: { borderBottomWidth: 1, borderBottomColor: '#F0F0F0', paddingVertical: 4 },
  bankRowHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 8 },
  bankRowHeaderMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  bankRowTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  bankDeleteBtn: { padding: 4 },
  bankExpanded: { paddingBottom: 12 },
  bankDefaultRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  bankDefaultLabel: { fontSize: 13, color: '#1A1A1A' },
  bankRowActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 16, marginTop: 4 },
  bankCancelText: { fontSize: 14, color: '#666666', paddingVertical: 8, paddingHorizontal: 8 },
  bankSaveBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  bankSaveBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  addBankAccountBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12 },
  addBankAccountText: { fontSize: 14, fontWeight: '700', color: '#075E54' },
  bankImportRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, marginBottom: 8 },
  bankImportLabel: { fontSize: 13, color: '#666666' },
  bankImportIcons: { flexDirection: 'row', gap: 16 },
  bankImportIconBtn: { padding: 4 },
  bankOcrToast: { backgroundColor: '#FFF8E1', borderRadius: 8, padding: 10, marginBottom: 8 },
  bankOcrToastText: { fontSize: 12, color: '#7B5800' },
  signatureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  signatureThumb: {
    width: 56, height: 56, borderRadius: 8, borderWidth: 1, borderColor: '#E0E0E0',
    backgroundColor: '#FAFAFA', alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  signatureThumbImage: { width: 52, height: 52 },
  signatureTextWrap: { flex: 1 },
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
