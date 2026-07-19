import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

// Disclaimer — Home Menu Audit, Step 2. Static legal text, no backend
// dependency. Export-my-data line intentionally kept general (not naming a
// specific working export tool) since that feature is still a stub as of
// this build -- strengthen the wording once Export my data ships for real.

export default function Disclaimer() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Disclaimer</Text>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <Text style={styles.paragraph}>
          AssistMe uses artificial intelligence to help you manage your business — including
          generating responses, insights, invoices, and reminders. AI can make mistakes. Always
          verify important information, especially financial figures, before relying on them or
          sharing them with customers.
        </Text>

        <Text style={styles.sectionHeading}>Your data, your responsibility</Text>
        <Text style={styles.paragraph}>
          You are responsible for the accuracy and safekeeping of the business data you enter into
          AssistMe, including customer details, invoices, and payment records. Please keep your own
          backup of important business data.
        </Text>

        <Text style={styles.paragraph}>
          AssistMe is a business management tool, not a substitute for professional financial,
          legal, tax, or accounting advice. For decisions with legal or tax consequences, consult a
          qualified professional.
        </Text>

        <Text style={styles.paragraph}>
          We work to keep AssistMe available and reliable, but we do not guarantee uninterrupted
          access, and we are not liable for losses arising from service interruptions, data loss,
          or reliance on AI-generated content.
        </Text>

        <Text style={styles.paragraph}>
          This disclaimer may be updated from time to time. Continued use of AssistMe means you
          accept the current version.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backBtn: { marginRight: 12 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  body: { flex: 1 },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '700',
    color: '#075E54',
    marginTop: 8,
    marginBottom: 8,
  },
  paragraph: {
    fontSize: 14,
    lineHeight: 21,
    color: '#333333',
    marginBottom: 16,
  },
});
