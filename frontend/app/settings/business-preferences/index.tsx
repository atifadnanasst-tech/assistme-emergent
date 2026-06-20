import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

interface CategoryItem {
  key: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
  comingSoon?: boolean;
}

const CATEGORIES: CategoryItem[] = [
  {
    key: 'hours',
    title: 'Hours & Availability',
    subtitle: 'Working hours, when AssistMe can reach you',
    icon: 'time-outline',
    route: '/settings/business-preferences/hours',
  },
  {
    key: 'notifications',
    title: 'Notifications & Attention',
    subtitle: 'How often, and how much, AssistMe should nudge you',
    icon: 'notifications-outline',
    route: '/settings/business-preferences/notifications',
  },
  {
    key: 'priorities',
    title: 'Business Priorities',
    subtitle: 'What matters most to your business right now',
    icon: 'flag-outline',
    route: '/settings/business-preferences/priorities',
  },
  {
    key: 'mentor',
    title: 'Goals & Mentor',
    subtitle: 'Growth targets and coaching, tailored to your business',
    icon: 'trophy-outline',
    route: '/settings/business-preferences/mentor',
    comingSoon: true,
  },
  {
    key: 'app',
    title: 'App & Hints',
    subtitle: 'Spark hints, and other app behavior',
    icon: 'sparkles-outline',
    route: '/settings/business-preferences/app-hints',
  },
];

export default function BusinessPreferencesHub() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Business Preferences</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.key}
            style={styles.card}
            onPress={() => router.push(cat.route as any)}
          >
            <View style={styles.cardIconWrap}>
              <Ionicons name={cat.icon} size={26} color="#075E54" />
            </View>
            <View style={styles.cardTextWrap}>
              <View style={styles.cardTitleRow}>
                <Text style={styles.cardTitle}>{cat.title}</Text>
                {cat.comingSoon && (
                  <View style={styles.comingSoonBadge}>
                    <Text style={styles.comingSoonBadgeText}>Coming Soon</Text>
                  </View>
                )}
              </View>
              <Text style={styles.cardSubtitle}>{cat.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
          </TouchableOpacity>
        ))}
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
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '600', color: '#FFFFFF', marginLeft: 8 },
  headerSpacer: { width: 40 },
  content: { padding: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E8F5E9',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  cardTextWrap: { flex: 1 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#111111' },
  cardSubtitle: { fontSize: 13, color: '#667781', marginTop: 2 },
  comingSoonBadge: {
    backgroundColor: '#F0F0F0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: 8,
  },
  comingSoonBadgeText: { fontSize: 11, color: '#667781', fontWeight: '600' },
});
