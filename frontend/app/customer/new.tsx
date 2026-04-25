import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput,
  ActivityIndicator, Alert, Linking, KeyboardAvoidingView, Platform,
  Modal, Pressable, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
// expo-contacts loaded dynamically to avoid crash on APKs without native module
let Contacts: any = null;
try { Contacts = require('expo-contacts'); } catch { Contacts = null; }
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { authService } from '../../lib/auth';

interface DeviceContact {
  id: string;
  name: string;
  phone: string;
}

export default function NewChatScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();

  // UI State
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [helpModalVisible, setHelpModalVisible] = useState(false);
  const [showNewContactForm, setShowNewContactForm] = useState(false);

  // Contacts
  const [contactsPermission, setContactsPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
  const [contacts, setContacts] = useState<DeviceContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  // New Contact Form
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formBusiness, setFormBusiness] = useState('');
  const [formBalance, setFormBalance] = useState('');
  const [formErrors, setFormErrors] = useState<{ name?: string; phone?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  const avatarColors = ['#E53935', '#8E24AA', '#1E88E5', '#43A047', '#F57C00', '#00897B'];

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      router.replace('/login');
      return null;
    }
    return token;
  };

  useEffect(() => {
    requestContactsPermission();
  }, []);

  const requestContactsPermission = async () => {
    if (!Contacts) {
      setContactsPermission('denied');
      return;
    }
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      setContactsPermission(status as 'granted' | 'denied' | 'undetermined');
      if (status === 'granted') {
        loadDeviceContacts();
      }
    } catch (error) {
      console.error('Contacts permission error:', error);
      setContactsPermission('denied');
    }
  };

  const loadDeviceContacts = async () => {
    try {
      setLoadingContacts(true);
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
      });
      
      const withPhone = data
        .filter(c => c.phoneNumbers && c.phoneNumbers.length > 0)
        .map(c => ({
          id: c.id,
          name: c.name || 'Unknown',
          phone: c.phoneNumbers![0].number || '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      setContacts(withPhone);
    } catch (error) {
      console.error('Load contacts error:', error);
    } finally {
      setLoadingContacts(false);
    }
  };

  const handleAddContact = async (name: string, phone: string) => {
    try {
      setLoading(true);
      const token = await getToken();
      if (!token) return;

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, phone }),
      });

      const data = await res.json();

      if (res.status === 201 || res.status === 409) {
        // Success or duplicate - both navigate to chat
        router.replace(`/chat/${data.customer_id}`);
      } else {
        Alert.alert('Error', 'Could not add contact. Please try again.');
      }
    } catch (error) {
      console.error('Add contact error:', error);
      Alert.alert('Error', 'Could not add contact. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveNewContact = async () => {
    // Validation
    const errors: { name?: string; phone?: string } = {};
    
    if (!formName.trim()) {
      errors.name = 'Name is required';
    }
    
    const normalizedPhone = formPhone.replace(/\D/g, '');
    if (normalizedPhone.length < 10) {
      errors.phone = 'Enter a valid phone number';
    }

    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      setSubmitting(true);
      const token = await getToken();
      if (!token) return;

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/customers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: formName.trim(),
          phone: normalizedPhone,
          business_name: formBusiness.trim() || undefined,
          opening_balance: formBalance ? parseFloat(formBalance) : undefined,
        }),
      });

      const data = await res.json();

      if (res.status === 201 || res.status === 409) {
        router.replace(`/chat/${data.customer_id}`);
      } else {
        Alert.alert('Error', data.message || 'Could not add contact. Please try again.');
      }
    } catch (error) {
      console.error('Save new contact error:', error);
      Alert.alert('Error', 'Could not add contact. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleShareInvite = async () => {
    try {
      await Share.share({
        message: "I use AssistMe to manage my business. Download it and connect with me!",
        title: "Join me on AssistMe",
      });
    } catch (error) {
      console.error('Share error:', error);
    }
  };

  const filteredContacts = contacts.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.phone.includes(searchQuery)
  );

  const renderQuickAction = (icon: string, label: string, onPress: () => void) => (
    <TouchableOpacity style={s.quickActionRow} onPress={onPress}>
      <Ionicons name={icon as any} size={24} color="#075E54" />
      <Text style={s.quickActionLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={20} color="#999" style={{ marginLeft: 'auto' }} />
    </TouchableOpacity>
  );

  const renderContact = ({ item, index }: { item: DeviceContact; index: number }) => {
    const avatarColor = avatarColors[index % avatarColors.length];
    const initial = item.name[0]?.toUpperCase() || '?';

    return (
      <TouchableOpacity
        style={s.contactRow}
        onPress={() => handleAddContact(item.name, item.phone)}
        disabled={loading}
      >
        <View style={[s.avatar, { backgroundColor: avatarColor }]}>
          <Text style={s.avatarText}>{initial}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.contactName}>{item.name}</Text>
          <Text style={s.contactPhone}>{item.phone}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>New Chat</Text>
        <TouchableOpacity onPress={() => setSearchVisible(!searchVisible)} style={s.headerBtn}>
          <Ionicons name="search" size={24} color="#FFF" />
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      {searchVisible && (
        <View style={s.searchContainer}>
          <Ionicons name="search" size={20} color="#667781" style={{ marginRight: 8 }} />
          <TextInput
            style={s.searchInput}
            placeholder="Search name or number"
            placeholderTextColor="#667781"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={20} color="#667781" />
            </TouchableOpacity>
          )}
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <FlatList
          data={filteredContacts}
          keyExtractor={item => item.id}
          renderItem={renderContact}
          contentContainerStyle={{ paddingBottom: 20 }}
          ListHeaderComponent={
            <>
              {/* Quick Actions */}
              <View style={s.quickActionsSection}>
                {renderQuickAction('person-add', 'New Contact', () => setShowNewContactForm(!showNewContactForm))}
                <View style={s.divider} />
                {renderQuickAction('share-social', 'Share Invite Link', handleShareInvite)}
                <View style={s.divider} />
                {renderQuickAction('help-circle', 'Contacts Help', () => setHelpModalVisible(true))}
              </View>

              {/* New Contact Form */}
              {showNewContactForm && (
                <View style={s.formContainer}>
                  <Text style={s.formTitle}>New Contact</Text>

                  <View style={s.formField}>
                    <TextInput
                      style={s.formInput}
                      placeholder="Customer name"
                      value={formName}
                      onChangeText={text => {
                        setFormName(text);
                        if (formErrors.name) setFormErrors(prev => ({ ...prev, name: undefined }));
                      }}
                    />
                    {formErrors.name && <Text style={s.errorText}>{formErrors.name}</Text>}
                  </View>

                  <View style={s.formField}>
                    <TextInput
                      style={s.formInput}
                      placeholder="e.g. 919876543210"
                      keyboardType="phone-pad"
                      value={formPhone}
                      onChangeText={text => {
                        setFormPhone(text);
                        if (formErrors.phone) setFormErrors(prev => ({ ...prev, phone: undefined }));
                      }}
                    />
                    {formErrors.phone && <Text style={s.errorText}>{formErrors.phone}</Text>}
                  </View>

                  <View style={s.formField}>
                    <TextInput
                      style={s.formInput}
                      placeholder="Business or shop name (optional)"
                      value={formBusiness}
                      onChangeText={setFormBusiness}
                    />
                  </View>

                  <View style={s.formField}>
                    <TextInput
                      style={s.formInput}
                      placeholder="Amount they owe you (optional)"
                      keyboardType="numeric"
                      value={formBalance}
                      onChangeText={setFormBalance}
                    />
                  </View>

                  <TouchableOpacity
                    style={[s.saveBtn, submitting && { opacity: 0.6 }]}
                    onPress={handleSaveNewContact}
                    disabled={submitting}
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                      <Text style={s.saveBtnText}>Save Contact</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}

              {/* Contacts Section Header */}
              {contactsPermission === 'granted' && (
                <View style={s.sectionHeader}>
                  <Text style={s.sectionLabel}>CONTACTS</Text>
                </View>
              )}

              {/* Permission Denied State */}
              {contactsPermission === 'denied' && (
                <View style={s.permissionDenied}>
                  <Text style={s.permissionText}>
                    Enable contacts permission in Settings to see your contacts
                  </Text>
                  <TouchableOpacity style={s.settingsBtn} onPress={() => Linking.openSettings()}>
                    <Text style={s.settingsBtnText}>Open Settings</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Loading Contacts */}
              {loadingContacts && (
                <View style={s.loadingContainer}>
                  <ActivityIndicator size="small" color="#075E54" />
                  <Text style={s.loadingText}>Loading contacts...</Text>
                </View>
              )}
            </>
          }
          ListEmptyComponent={
            !loadingContacts && contactsPermission === 'granted' && searchQuery ? (
              <View style={s.emptyState}>
                <Text style={s.emptyText}>No contacts found</Text>
              </View>
            ) : null
          }
        />
      </KeyboardAvoidingView>

      {/* Contacts Help Modal */}
      <Modal visible={helpModalVisible} transparent animationType="fade" onRequestClose={() => setHelpModalVisible(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setHelpModalVisible(false)}>
          <Pressable style={s.modalContent} onPress={e => e.stopPropagation()}>
            <Text style={s.modalTitle}>Contacts Help</Text>
            <View style={s.helpItem}>
              <Ionicons name="search" size={20} color="#075E54" />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.helpItemTitle}>How to find a contact</Text>
                <Text style={s.helpItemBody}>They need AssistMe installed</Text>
              </View>
            </View>
            <View style={s.helpItem}>
              <Ionicons name="alert-circle" size={20} color="#075E54" />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.helpItemTitle}>Can't find a contact?</Text>
                <Text style={s.helpItemBody}>Share your invite link</Text>
              </View>
            </View>
            <View style={s.helpItem}>
              <Ionicons name="share-social" size={20} color="#075E54" />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.helpItemTitle}>Invite a phone contact</Text>
                <Text style={s.helpItemBody}>Use Share Invite Link above</Text>
              </View>
            </View>
            <TouchableOpacity style={s.modalCloseBtn} onPress={() => setHelpModalVisible(false)}>
              <Text style={s.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {loading && (
        <View style={s.loadingOverlay}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E0E0E0' },
  searchInput: { flex: 1, fontSize: 16, color: '#000' },
  quickActionsSection: { backgroundColor: '#FFF', marginBottom: 8 },
  quickActionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  quickActionLabel: { fontSize: 16, color: '#000', flex: 1 },
  divider: { height: 1, backgroundColor: '#E0E0E0', marginHorizontal: 16 },
  formContainer: { backgroundColor: '#FFF', padding: 16, marginBottom: 8 },
  formTitle: { fontSize: 18, fontWeight: '700', color: '#075E54', marginBottom: 16 },
  formField: { marginBottom: 12 },
  formInput: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, backgroundColor: '#FFF' },
  errorText: { color: '#D32F2F', fontSize: 12, marginTop: 4 },
  saveBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  saveBtnText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  sectionHeader: { backgroundColor: '#F5F5F5', paddingHorizontal: 16, paddingVertical: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: '#667781', letterSpacing: 0.5 },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', paddingVertical: 12, paddingHorizontal: 16, gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  contactName: { fontSize: 16, fontWeight: '600', color: '#000' },
  contactPhone: { fontSize: 13, color: '#667781', marginTop: 2 },
  permissionDenied: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  permissionText: { fontSize: 15, color: '#667781', textAlign: 'center', marginBottom: 16 },
  settingsBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 },
  settingsBtnText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  loadingContainer: { alignItems: 'center', paddingVertical: 20 },
  loadingText: { color: '#667781', fontSize: 14, marginTop: 8 },
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { color: '#667781', fontSize: 15 },
  loadingOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', paddingHorizontal: 24 },
  modalContent: { backgroundColor: '#FFF', borderRadius: 16, padding: 24 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#075E54', marginBottom: 20 },
  helpItem: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 16 },
  helpItemTitle: { fontSize: 15, fontWeight: '600', color: '#000', marginBottom: 4 },
  helpItemBody: { fontSize: 14, color: '#667781' },
  modalCloseBtn: { backgroundColor: '#075E54', borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  modalCloseBtnText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
});
