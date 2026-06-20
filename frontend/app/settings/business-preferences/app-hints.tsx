import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function AppAndHintsScreen() {
  const router = useRouter();
  const [hintsEnabled, setHintsEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // Matches the exact check used in chat/[customer_id].tsx -- hints
      // are enabled unless this key is the literal string 'true'.
      const dismissed = await AsyncStorage.getItem('sparkHintDismissed');
      setHintsEnabled(dismissed !== 'true');
      setLoading(false);
    })();
  }, []);

  const toggleHints = async (value: boolean) => {
    setHintsEnabled(value);
    if (value) {
      // Same call the original Reset Spark Hints button used.
      await AsyncStorage.removeItem('sparkHintDismissed');
    } else {
      // Same value Spark itself writes when a hint is dismissed.
      await AsyncStorage.setItem('sparkHintDismissed', 'true');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>App & Hints</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <View style={styles.row}>
          <Ionicons name="sparkles-outline" size={24} color="#667781" />
          <View style={styles.rowTextWrap}>
            <Text style={styles.rowTitle}>Spark Hints</Text>
            <Text style={styles.rowSubtitle}>
              {hintsEnabled
                ? "Spark's onboarding tips will show next time you use it"
                : "Spark's onboarding tips are currently hidden"}
            </Text>
          </View>
          <Switch
            value={hintsEnabled}
            onValueChange={toggleHints}
            disabled={loading}
            trackColor={{ false: '#CCCCCC', true: '#25D366' }}
            thumbColor="#FFFFFF"
          />
        </View>
      </View>
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
  content: { padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  rowTextWrap: { flex: 1, marginLeft: 16, marginRight: 8 },
  rowTitle: { fontSize: 16, color: '#111111' },
  rowSubtitle: { fontSize: 13, color: '#667781', marginTop: 2 },
});
