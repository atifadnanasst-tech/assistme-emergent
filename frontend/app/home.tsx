import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';

interface FilterTab {
  id: string;
  name: string;
  count: number | null;
  is_custom: boolean;
}

interface InsightStrip {
  content: string;
  items: Array<{ id: string; text: string; completed: boolean }>;
}

interface Conversation {
  customer_id: string;
  name: string;
  initials: string;
  avatar_color: string;
  last_message: string;
  last_message_at: string;
  outstanding_amount: number | null;
  is_overdue: boolean;
  unread_count: number;
  health_score: number | null;
}

interface HomeData {
  insight_strip: InsightStrip | null;
  filter_tabs: FilterTab[];
  conversations: Conversation[];
  subscription_plan?: string;
  language?: string | null;
}

export default function HomeScreen() {
  const router = useRouter();
  const { setIsAuthenticated } = useAuth();
  
  const [homeData, setHomeData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showThreeDotMenu, setShowThreeDotMenu] = useState(false);
  const [showToolsSheet, setShowToolsSheet] = useState(false);

  useEffect(() => {
    loadHomeData();
  }, []);

  const loadHomeData = async (filterTab?: string) => {
    try {
      const token = await authService.getAccessToken();
      if (!token) {
        router.replace('/login');
        return;
      }

      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const url = filterTab && filterTab !== 'all' 
        ? `${backendUrl}/api/home?filter=${filterTab}`
        : `${backendUrl}/api/home`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        await authService.clearSession();
        await supabase.auth.signOut();
        setIsAuthenticated(false);
        router.replace('/login');
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to load home data');
      }

      const data: HomeData = await response.json();
      setHomeData(data);
      
      // Set default active tab to 'all' if not set
      if (!activeTab) {
        setActiveTab('all');
      }
      
    } catch (error) {
      if (error.name === 'AbortError') {
        // Timeout - silent fail
        console.warn('Request timeout');
      } else {
        console.error('Load home data error:', error);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleTabPress = (tabId: string) => {
    if (tabId === activeTab) {
      // Same tab tapped - force reload
      loadHomeData(tabId === 'all' ? undefined : tabId);
    } else {
      setActiveTab(tabId);
      setLoading(true);
      loadHomeData(tabId === 'all' ? undefined : tabId);
    }
  };

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadHomeData(activeTab === 'all' ? undefined : activeTab || undefined);
  }, [activeTab]);

  const handleLogout = async () => {
    try {
      const token = await authService.getAccessToken();
      if (token) {
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        await fetch(`${backendUrl}/api/auth/sign-out`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
      }
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      await authService.clearSession();
      await supabase.auth.signOut();
      setIsAuthenticated(false);
      router.replace('/login');
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (diffHours < 24) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'long' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const renderConversationItem = ({ item }: { item: Conversation }) => (
    <TouchableOpacity
      style={styles.conversationRow}
      onPress={() => router.push(`/chat/${item.customer_id}`)}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: item.avatar_color }]}>
        <Text style={styles.avatarText}>{item.initials}</Text>
      </View>

      {/* Content */}
      <View style={styles.conversationContent}>
        <View style={styles.conversationHeader}>
          <Text style={styles.customerName} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.timestamp}>
            {formatTimestamp(item.last_message_at)}
          </Text>
        </View>

        <View style={styles.conversationFooter}>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.last_message}
          </Text>
          
          {/* Badges */}
          <View style={styles.badges}>
            {item.outstanding_amount && item.outstanding_amount > 0 && (
              <View style={[
                styles.amountBadge,
                item.is_overdue && styles.amountBadgeOverdue
              ]}>
                <Text style={[
                  styles.amountText,
                  item.is_overdue && styles.amountTextOverdue
                ]}>
                  ₹{item.outstanding_amount.toLocaleString('en-IN')}
                </Text>
              </View>
            )}
            
            {item.unread_count > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadText}>{item.unread_count}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  if (loading && !homeData) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>AssistMe</Text>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      </SafeAreaView>
    );
  }

  const conversations = homeData?.conversations || [];
  const filterTabs = homeData?.filter_tabs || [];
  const insightStrip = homeData?.insight_strip;

  return (
    <>
      {/* Header SafeAreaView */}
      <SafeAreaView style={styles.headerSafeArea} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>AssistMe</Text>
          <View style={styles.headerIcons}>
            <TouchableOpacity style={styles.headerIcon}>
              <Ionicons name="search-outline" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.headerIcon}>
              <Ionicons name="checkmark-done-outline" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.headerIcon}
              onPress={() => setShowThreeDotMenu(true)}
            >
              <Ionicons name="ellipsis-vertical" size={24} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Filter Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterTabsContainer}
          contentContainerStyle={styles.filterTabsContent}
        >
          {/* All tab (always first) */}
          <TouchableOpacity
            style={[
              styles.filterTab,
              activeTab === 'all' && styles.filterTabActive
            ]}
            onPress={() => handleTabPress('all')}
          >
            <Text style={[
              styles.filterTabText,
              activeTab === 'all' && styles.filterTabTextActive
            ]}>
              All
            </Text>
          </TouchableOpacity>

          {/* Other tabs (skip "All" since it's hardcoded above) */}
          {filterTabs.filter((tab) => tab.name !== 'All').map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.filterTab,
                activeTab === tab.id && styles.filterTabActive
              ]}
              onPress={() => handleTabPress(tab.id)}
            >
              <Text style={[
                styles.filterTabText,
                activeTab === tab.id && styles.filterTabTextActive
              ]}>
                {tab.name}
              </Text>
              {tab.count !== null && tab.count > 0 && (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{tab.count}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}

          {/* Add custom list button */}
          <TouchableOpacity style={styles.addTabButton}>
            <Ionicons name="add" size={20} color="#075E54" />
          </TouchableOpacity>
        </ScrollView>

        {/* Insight Strip */}
        {insightStrip && insightStrip.content && (
          <View style={styles.insightStrip}>
            <Ionicons name="bulb" size={20} color="#8B6914" />
            <Text style={styles.insightText} numberOfLines={2}>
              {insightStrip.content}
            </Text>
            <TouchableOpacity>
              <Text style={styles.insightDetails}>Details ›</Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>

      {/* Conversation List */}
      <FlatList
        data={conversations}
        renderItem={renderConversationItem}
        keyExtractor={(item) => item.customer_id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={['#075E54']}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="chatbubbles-outline" size={64} color="#CCCCCC" />
            <Text style={styles.emptyStateText}>No conversations yet</Text>
            <Text style={styles.emptyStateSubtext}>
              Add your first customer to get started
            </Text>
          </View>
        }
        contentContainerStyle={conversations.length === 0 && styles.emptyListContent}
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push('/customer/new')}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </TouchableOpacity>

      {/* Bottom Navigation SafeAreaView */}
      <SafeAreaView style={styles.bottomNavSafeArea} edges={['bottom']}>
        <View style={styles.bottomNav}>
          <TouchableOpacity style={styles.navItemActive}>
            <View style={styles.navItemActivePill}>
              <Ionicons name="chatbubbles" size={24} color="#FFFFFF" />
              <Text style={styles.navItemTextActive}>Chats</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.navItem}
            onPress={() => router.push('/products')}
          >
            <Ionicons name="cube-outline" size={24} color="#667781" />
            <Text style={styles.navItemText}>Products</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.navItem}
            onPress={() => setShowToolsSheet(true)}
          >
            <Ionicons name="settings-outline" size={24} color="#667781" />
            <Text style={styles.navItemText}>Tools</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.navItem}
            onPress={() => router.push('/ai')}
          >
            <Ionicons name="sparkles-outline" size={24} color="#667781" />
            <Text style={styles.navItemText}>AI</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* 3-Dot Menu Overlay */}
      <Modal
        visible={showThreeDotMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowThreeDotMenu(false)}
      >
        <TouchableOpacity 
          style={styles.menuOverlay}
          activeOpacity={1}
          onPress={() => setShowThreeDotMenu(false)}
        >
          <View style={styles.menuCard}>
            <Text style={styles.menuSection}>COMMUNICATION</Text>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/group/new');
              }}
            >
              <Ionicons name="people-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>New Group</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/broadcast/new');
              }}
            >
              <Ionicons name="megaphone-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Broadcast</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/lists');
              }}
            >
              <Ionicons name="list-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Lists</Text>
            </TouchableOpacity>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>BUSINESS OPERATIONS</Text>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/settings/devices');
              }}
            >
              <Ionicons name="phone-portrait-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Linked Devices</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/settings/team');
              }}
            >
              <Ionicons name="person-add-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Invite Team Members</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                router.push('/products');
              }}
            >
              <Ionicons name="cube-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>See Inventory</Text>
            </TouchableOpacity>

            <View style={styles.menuDivider} />
            <Text style={styles.menuSection}>SYSTEM</Text>
            <TouchableOpacity 
              style={styles.menuItem}
              onPress={() => {
                setShowThreeDotMenu(false);
                setShowToolsSheet(true);
              }}
            >
              <Ionicons name="settings-outline" size={20} color="#667781" />
              <Text style={styles.menuItemText}>Settings</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Tools Bottom Sheet */}
      <Modal
        visible={showToolsSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowToolsSheet(false)}
      >
        <TouchableOpacity 
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setShowToolsSheet(false)}
        >
          <View style={styles.sheetContainer}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Settings & more</Text>
            
            <ScrollView style={styles.sheetContent}>
              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/profile'); }}>
                <Ionicons name="briefcase-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Business profile</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/staff'); }}>
                <Ionicons name="people-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Manage staff & roles</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/billing'); }}>
                <Ionicons name="card-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Subscription & billing</Text>
                {homeData?.subscription_plan && (
                  <View style={styles.planBadge}>
                    <Text style={styles.planBadgeText}>{homeData.subscription_plan.toUpperCase()}</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/catalogs'); }}>
                <Ionicons name="book-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Smart Catalogs</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/notifications'); }}>
                <Ionicons name="notifications-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Notification preferences</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/appearance'); }}>
                <Ionicons name="color-palette-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Appearance</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/social'); }}>
                <Ionicons name="share-social-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Add Social Media</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/export'); }}>
                <Ionicons name="download-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Export my data</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/help'); }}>
                <Ionicons name="help-circle-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Tutorials & help</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <View style={styles.sheetItem}>
                <Ionicons name="language-outline" size={24} color="#BBBBBB" />
                <Text style={styles.sheetItemTextDisabled}>Language</Text>
                {homeData?.language && (
                  <Text style={styles.sheetItemValueDisabled}>{homeData.language}</Text>
                )}
              </View>

              <TouchableOpacity style={styles.sheetItem} onPress={() => { setShowToolsSheet(false); router.push('/settings/disclaimer'); }}>
                <Ionicons name="document-text-outline" size={24} color="#667781" />
                <Text style={styles.sheetItemText}>Disclaimer</Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </TouchableOpacity>

              <View style={styles.sheetDivider} />

              <TouchableOpacity style={styles.sheetItemDanger} onPress={handleLogout}>
                <Ionicons name="log-out-outline" size={24} color="#D32F2F" />
                <Text style={styles.sheetItemTextDanger}>Sign out</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  headerSafeArea: {
    backgroundColor: '#075E54',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerIcons: {
    flexDirection: 'row',
    gap: 16,
  },
  headerIcon: {
    padding: 4,
  },
  filterTabsContainer: {
    backgroundColor: '#075E54',
  },
  filterTabsContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#075E54',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginRight: 8,
  },
  filterTabActive: {
    backgroundColor: '#075E54',
    borderColor: '#FFFFFF',
  },
  filterTabText: {
    fontSize: 14,
    color: '#075E54',
    fontWeight: '500',
  },
  filterTabTextActive: {
    color: '#FFFFFF',
  },
  tabBadge: {
    backgroundColor: '#D32F2F',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    paddingHorizontal: 6,
  },
  tabBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  addTabButton: {
    width: 40,
    height: 40,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  insightStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF8E1',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  insightText: {
    flex: 1,
    fontSize: 14,
    color: '#8B6914',
  },
  insightDetails: {
    fontSize: 14,
    color: '#8B6914',
    fontWeight: '600',
  },
  conversationRow: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  conversationContent: {
    flex: 1,
    marginLeft: 12,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  customerName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
  timestamp: {
    fontSize: 12,
    color: '#999999',
  },
  conversationFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMessage: {
    flex: 1,
    fontSize: 14,
    color: '#667781',
  },
  badges: {
    flexDirection: 'row',
    gap: 8,
  },
  amountBadge: {
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  amountBadgeOverdue: {
    backgroundColor: '#FFF0F0',
  },
  amountText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888888',
  },
  amountTextOverdue: {
    color: '#D32F2F',
  },
  unreadBadge: {
    backgroundColor: '#25D366',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyStateText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#999999',
    marginTop: 16,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#CCCCCC',
    marginTop: 8,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 100,
    width: 56,
    height: 56,
    backgroundColor: '#075E54',
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    zIndex: 10,
  },
  bottomNavSafeArea: {
    backgroundColor: '#FFFFFF',
  },
  bottomNav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F0',
  },
  navItem: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  navItemText: {
    fontSize: 12,
    color: '#667781',
    marginTop: 4,
  },
  navItemActive: {
    alignItems: 'center',
  },
  navItemActivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 6,
  },
  navItemTextActive: {
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 60,
    paddingRight: 16,
  },
  menuCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    minWidth: 250,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  menuSection: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999999',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 16,
  },
  menuItemText: {
    fontSize: 14,
    color: '#333333',
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#F0F0F0',
    marginVertical: 8,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#CCCCCC',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333333',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sheetContent: {
    paddingBottom: 16,
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 16,
  },
  sheetItemText: {
    flex: 1,
    fontSize: 16,
    color: '#333333',
  },
  sheetItemTextDisabled: {
    flex: 1,
    fontSize: 16,
    color: '#BBBBBB',
  },
  sheetItemValueDisabled: {
    fontSize: 14,
    color: '#BBBBBB',
    marginRight: 4,
  },
  planBadge: {
    backgroundColor: '#075E54',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
    marginRight: 8,
  },
  planBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  sheetDivider: {
    height: 1,
    backgroundColor: '#F0F0F0',
    marginVertical: 8,
  },
  sheetItemDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 16,
  },
  sheetItemTextDanger: {
    flex: 1,
    fontSize: 16,
    color: '#D32F2F',
    fontWeight: '600',
  },
});
