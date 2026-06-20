import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../../../lib/auth';
import SettingsSaveBar from '../../../components/settings/SettingsSaveBar';
import { PRIORITY_AREA_OPTIONS } from '../../../constants/businessPreferences';

const MAX_PRIORITIES = 5;

export default function BusinessPrioritiesScreen() {
  const router = useRouter();
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const [current, setCurrent] = useState<string[]>([]);

  const dirty = JSON.stringify([...current].sort()) !== JSON.stringify([...saved].sort());
  const atLimit = current.length >= MAX_PRIORITIES;

  const loadSettings = async () => {
    try {
      const token = await authService.getAccessToken();
      const res = await fetch(`${backendUrl}/api/organisations/settings`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const areas = data?.settings?.priorities?.areas;
      if (Array.isArray(areas)) {
        setSaved(areas);
        setCurrent(areas);
      }
    } catch (err) {
      console.error('[BusinessPriorities] load error:', err);
      Alert.alert('Error', 'Could not load your current settings. Showing defaults.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSettings(); }, []);

  const toggleArea = (value: string) => {
    if (current.includes(value)) {
      setCurrent(current.filter((v) => v !== value));
    } else {
      if (current.length >= MAX_PRIORITIES) return;
      setCurrent([...current, value]);
    }
  };

  const handleDiscard = () => setCurrent(saved);

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = await authService.getAccessToken();
      const res = await fetch(`${backendUrl}/api/organisations/settings`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorities: { areas: current } }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Save failed');
      }
      const data = await res.json();
      const areas = data?.settings?.priorities?.areas;
      if (Array.isArray(areas)) {
        setSaved(areas);
        setCurrent(areas);
      }
    } catch (err) {
      console.error('[BusinessPriorities] save error:', err);
      Alert.alert('Error', 'Could not save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Business Priorities</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      ) : (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          <Text style={styles.description}>
            Choose up to {MAX_PRIORITIES} things that matter most to your business right now. AssistMe uses these to decide what's worth interrupting you about -- in the Daily Brief, Watchlist, and Mentor.
          </Text>
          <Text style={styles.counter}>{current.length} of {MAX_PRIORITIES} selected</Text>

          {PRIORITY_AREA_OPTIONS.map((opt) => {
            const isSelected = current.includes(opt.value);
            const isDisabled = atLimit && !isSelected;
            return (
              <TouchableOpacity
                key={opt.value}
                style={styles.row}
                onPress={() => toggleArea(opt.value)}
                disabled={isDisabled}
              >
                <Ionicons
                  name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={20}
                  color={isSelected ? '#075E54' : isDisabled ? '#E0E0E0' : '#CCCCCC'}
                />
                <View style={styles.textWrap}>
                  <Text style={[styles.label, isDisabled && styles.labelDisabled]}>{opt.label}</Text>
                  <Text style={[styles.optDescription, isDisabled && styles.labelDisabled]}>{opt.description}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {!loading && (
        <SettingsSaveBar dirty={dirty} saving={saving} onSave={handleSave} onDiscard={handleDiscard} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '600', color: '#FFFFFF', marginLeft: 8 },
  headerSpacer: { width: 40 },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingBottom: 32 },
  description: { fontSize: 13, color: '#667781', lineHeight: 18, marginBottom: 8 },
  counter: { fontSize: 12, fontWeight: '600', color: '#075E54', marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  textWrap: { marginLeft: 12, flex: 1 },
  label: { fontSize: 15, color: '#111111' },
  optDescription: { fontSize: 12, color: '#667781', marginTop: 1 },
  labelDisabled: { color: '#CCCCCC' },
});
