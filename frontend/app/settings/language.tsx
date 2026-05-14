import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../../lib/auth';
import { LANGUAGE_OPTIONS, getLanguageLabel, DEFAULT_LANGUAGE } from '../../constants/languages';

export default function LanguageScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState(DEFAULT_LANGUAGE);
  const [customerLanguageAuto, setCustomerLanguageAuto] = useState(false);

  useEffect(() => {
    loadLanguageSettings();
  }, []);

  const loadLanguageSettings = async () => {
    try {
      const token = await authService.getAccessToken();
      if (!token) {
        Alert.alert('Error', 'Authentication required');
        router.back();
        return;
      }

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/organisations`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (res.status === 401) {
        Alert.alert('Session Expired', 'Please log in again');
        router.back();
        return;
      }

      if (!res.ok) {
        throw new Error('Failed to load settings');
      }

      const data = await res.json();
      setSelectedLanguage(data.primary_language || DEFAULT_LANGUAGE);
      setCustomerLanguageAuto(data.customer_language_auto || false);
    } catch (err) {
      console.error('Load language settings error:', err);
      Alert.alert('Error', 'Failed to load language settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = await authService.getAccessToken();
      if (!token) {
        Alert.alert('Error', 'Authentication required');
        return;
      }

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/organisations`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          primary_language: selectedLanguage,
          customer_language_auto: customerLanguageAuto,
        }),
      });

      if (res.status === 401) {
        Alert.alert('Session Expired', 'Please log in again');
        return;
      }

      if (!res.ok) {
        throw new Error('Failed to save');
      }

      // Brief success feedback
      Alert.alert('Saved', 'Language settings updated', [
        { text: 'OK', onPress: () => router.back() }
      ]);
    } catch (err) {
      console.error('Save language error:', err);
      Alert.alert('Error', 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const filteredLanguages = LANGUAGE_OPTIONS.filter(lang => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      lang.label.toLowerCase().includes(query) ||
      lang.code.toLowerCase().includes(query)
    );
  }).sort((a, b) => a.label.localeCompare(b.label));

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#075E54" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Language</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#075E54" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Language</Text>
      </View>

      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#999" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search languages..."
          placeholderTextColor="#999"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearBtn}>
            <Ionicons name="close-circle" size={20} color="#999" />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={styles.scrollView}>
        <View style={styles.languageList}>
          {filteredLanguages.map(lang => (
            <TouchableOpacity
              key={lang.code}
              style={styles.languageItem}
              onPress={() => setSelectedLanguage(lang.code)}
            >
              <Text style={styles.languageLabel}>{lang.label}</Text>
              {selectedLanguage === lang.code && (
                <Ionicons name="checkmark" size={24} color="#075E54" />
              )}
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.toggleContainer}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleLabel}>Use customer's preferred language</Text>
            <Text style={styles.toggleSubtext}>
              Respond to customers in their preferred language when available
            </Text>
          </View>
          <Switch
            value={customerLanguageAuto}
            onValueChange={setCustomerLanguageAuto}
            trackColor={{ false: '#DDD', true: '#B3E5DB' }}
            thumbColor={customerLanguageAuto ? '#075E54' : '#FFF'}
          />
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  backBtn: {
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF',
    marginHorizontal: 16,
    marginVertical: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E5E5',
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: '#1A1A1A',
    paddingVertical: 4,
  },
  clearBtn: {
    padding: 4,
  },
  scrollView: {
    flex: 1,
  },
  languageList: {
    backgroundColor: '#FFF',
    marginHorizontal: 16,
    borderRadius: 8,
    overflow: 'hidden',
  },
  languageItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  languageLabel: {
    fontSize: 16,
    color: '#1A1A1A',
  },
  toggleContainer: {
    backgroundColor: '#FFF',
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 24,
    padding: 16,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  toggleLabel: {
    fontSize: 16,
    color: '#1A1A1A',
    marginBottom: 4,
  },
  toggleSubtext: {
    fontSize: 13,
    color: '#666',
  },
  footer: {
    backgroundColor: '#FFF',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E5E5',
  },
  saveBtn: {
    backgroundColor: '#075E54',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveBtnText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
