import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function AppAndHintsScreen() {
  const router = useRouter();

  const resetSparkHints = async () => {
    await AsyncStorage.removeItem('sparkHintDismissed');
    Alert.alert('Done', 'Spark hints will show again on your next Spark tap.');
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
        <TouchableOpacity style={styles.row} onPress={resetSparkHints}>
          <Ionicons name="sparkles-outline" size={24} color="#667781" />
          <View style={styles.rowTextWrap}>
            <Text style={styles.rowTitle}>Reset Spark Hints</Text>
            <Text style={styles.rowSubtitle}>Show Spark's onboarding tips again next time you use it</Text>
          </View>
        </TouchableOpacity>
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
  rowTextWrap: { flex: 1, marginLeft: 16 },
  rowTitle: { fontSize: 16, color: '#111111' },
  rowSubtitle: { fontSize: 13, color: '#667781', marginTop: 2 },
});
