import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import RazorpayCheckout from 'react-native-razorpay';
import { authService } from '../../lib/auth';

interface WalletTier {
  amountInr: number;
  aiCredits: number;
}

const WALLET_TIERS: WalletTier[] = [
  { amountInr: 100, aiCredits: 80 },
  { amountInr: 200, aiCredits: 160 },
  { amountInr: 500, aiCredits: 400 },
  { amountInr: 1000, aiCredits: 800 },
  { amountInr: 2000, aiCredits: 1600 },
];

interface TierInfo {
  tier: 'free' | 'pro' | 'business';
  displayName: string;
  priceLabel: string;
  rank: number;
}

const TIER_INFO: TierInfo[] = [
  { tier: 'free', displayName: 'Free', priceLabel: 'Free', rank: 0 },
  { tier: 'pro', displayName: 'Pro', priceLabel: '₹499 + GST /month', rank: 1 },
  { tier: 'business', displayName: 'Business', priceLabel: '₹1999 + GST /month', rank: 2 },
];

interface UsageSummary {
  plan: string;
  walletCreditsRemaining: number;
  subscriptionPeriodEndFormatted: string | null;
  currentPeriod: {
    periodType: string;
    costUsedPaisa: number;
    ceilingPaisa: number;
    percentUsed: number;
    periodEndFormatted: string;
  };
}

export default function SubscriptionBilling() {
  const router = useRouter();
  const [purchasingTier, setPurchasingTier] = useState<number | null>(null);
  const [subscribingTier, setSubscribingTier] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const currentTier = usage?.plan || 'free';

  const fetchUsageSummary = useCallback(async () => {
    try {
      const token = await authService.getAccessToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/billing/usage-summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUsage(data);
      }
    } catch (err) {
      console.error('Usage summary fetch error:', err);
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    fetchUsageSummary();
  }, [fetchUsageSummary]);

  const handleBuyCredits = async (tier: WalletTier) => {
    if (purchasingTier !== null) return;
    setPurchasingTier(tier.amountInr);
    try {
      const token = await authService.getAccessToken();
      if (!token) {
        router.back();
        return;
      }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      const orderRes = await fetch(`${backendUrl}/api/wallet/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountInr: tier.amountInr }),
      });
      if (!orderRes.ok) {
        Alert.alert('Could not start purchase', 'Please try again.');
        return;
      }
      const order = await orderRes.json();

      const checkoutOptions = {
        description: `${order.aiCredits} AI Credits`,
        currency: 'INR',
        key: order.keyId,
        amount: String(order.amountPaise),
        order_id: order.orderId,
        name: 'AssistMe',
        theme: { color: '#075E54' },
      };

      let paymentResult;
      try {
        paymentResult = await RazorpayCheckout.open(checkoutOptions);
      } catch (checkoutErr: any) {
        if (checkoutErr?.code !== 0) {
          Alert.alert('Payment not completed', checkoutErr?.description || 'Please try again.');
        }
        return;
      }

      const verifyRes = await fetch(`${backendUrl}/api/wallet/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          razorpay_order_id: paymentResult.razorpay_order_id,
          razorpay_payment_id: paymentResult.razorpay_payment_id,
          razorpay_signature: paymentResult.razorpay_signature,
        }),
      });

      if (verifyRes.ok) {
        const result = await verifyRes.json();
        Alert.alert('Success', `${result.aiCredits} AI Credits added to your account.`);
        fetchUsageSummary();
      } else {
        Alert.alert(
          'Payment received',
          'Your payment went through. Credits may take a moment to appear.'
        );
      }
    } catch (err) {
      console.error('Wallet purchase error:', err);
      Alert.alert('Something went wrong', 'Please try again, or contact support if this continues.');
    } finally {
      setPurchasingTier(null);
    }
  };

  const getProgressBarColorStyle = (percentUsed: number) => {
    if (percentUsed >= 90) return styles.progressFillRed;
    if (percentUsed >= 75) return styles.progressFillOrange;
    return null;
  };

  const openCheckoutAndVerify = async (subscriptionId: string, keyId: string, targetTier: TierInfo, token: string) => {
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const checkoutOptions = {
      description: `AssistMe ${targetTier.displayName} — monthly subscription`,
      key: keyId,
      subscription_id: subscriptionId,
      name: 'AssistMe',
      theme: { color: '#075E54' },
    };

    let paymentResult;
    try {
      paymentResult = await RazorpayCheckout.open(checkoutOptions);
    } catch (checkoutErr: any) {
      if (checkoutErr?.code !== 0) {
        Alert.alert('Not completed', checkoutErr?.description || 'Please try again.');
      }
      return;
    }

    const verifyRes = await fetch(`${backendUrl}/api/subscription/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        razorpay_subscription_id: paymentResult.razorpay_subscription_id,
        razorpay_payment_id: paymentResult.razorpay_payment_id,
        razorpay_signature: paymentResult.razorpay_signature,
        tier: targetTier.tier,
      }),
    });

    if (verifyRes.ok) {
      Alert.alert('Success', `You're now on the ${targetTier.displayName} plan.`);
      fetchUsageSummary();
    } else {
      Alert.alert('Payment received', "Your payment went through. Your plan may take a moment to update.");
    }
  };

  const handleFreshSubscribe = async (targetTier: TierInfo) => {
    if (subscribingTier !== null) return;
    setSubscribingTier(targetTier.tier);
    try {
      const token = await authService.getAccessToken();
      if (!token) { router.back(); return; }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      const subRes = await fetch(`${backendUrl}/api/subscription/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tier: targetTier.tier }),
      });
      if (!subRes.ok) {
        Alert.alert('Could not start subscription', 'Please try again.');
        return;
      }
      const sub = await subRes.json();
      await openCheckoutAndVerify(sub.subscriptionId, sub.keyId, targetTier, token);
    } catch (err) {
      console.error('Subscribe error:', err);
      Alert.alert('Something went wrong', 'Please try again, or contact support if this continues.');
    } finally {
      setSubscribingTier(null);
    }
  };

  const handleChangeTier = async (targetTier: TierInfo) => {
    if (subscribingTier !== null) return;
    setSubscribingTier(targetTier.tier);
    try {
      const token = await authService.getAccessToken();
      if (!token) { router.back(); return; }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      const res = await fetch(`${backendUrl}/api/subscription/change-tier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newTier: targetTier.tier }),
      });
      if (!res.ok) {
        Alert.alert('Could not switch plans', 'Please try again.');
        return;
      }
      const result = await res.json();

      if (result.instant) {
        Alert.alert('Success', `You're now on the ${targetTier.displayName} plan.`);
        fetchUsageSummary();
      } else if (result.needsReauth) {
        await openCheckoutAndVerify(result.subscriptionId, result.keyId, targetTier, token);
      }
    } catch (err) {
      console.error('Change tier error:', err);
      Alert.alert('Something went wrong', 'Please try again, or contact support if this continues.');
    } finally {
      setSubscribingTier(null);
    }
  };

  const handleCancelToFree = async () => {
    if (subscribingTier !== null) return;
    setSubscribingTier('free');
    try {
      const token = await authService.getAccessToken();
      if (!token) { router.back(); return; }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

      const res = await fetch(`${backendUrl}/api/subscription/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        Alert.alert('Could not cancel', 'Please try again.');
        return;
      }
      Alert.alert(
        'Cancellation scheduled',
        "You'll keep your current plan's features until this billing period ends, then move to Free."
      );
    } catch (err) {
      console.error('Cancel error:', err);
      Alert.alert('Something went wrong', 'Please try again, or contact support if this continues.');
    } finally {
      setSubscribingTier(null);
    }
  };

  const handleTierTap = (targetTier: TierInfo) => {
    if (subscribingTier !== null || targetTier.tier === currentTier) return;
    const currentInfo = TIER_INFO.find((t) => t.tier === currentTier)!;

    if (currentTier === 'free') {
      handleFreshSubscribe(targetTier);
      return;
    }

    if (targetTier.tier === 'free') {
      const dateText = usage?.subscriptionPeriodEndFormatted
        ? `on ${usage.subscriptionPeriodEndFormatted}`
        : 'once your current billing period ends';
      Alert.alert(
        'Move to Free?',
        `You'll lose access to features beyond the Free plan ${dateText}. You can resubscribe any time.`,
        [
          { text: 'Keep current plan', style: 'cancel' },
          { text: 'Move to Free', style: 'destructive', onPress: handleCancelToFree },
        ]
      );
      return;
    }

    if (targetTier.rank > currentInfo.rank) {
      handleChangeTier(targetTier);
    } else {
      Alert.alert(
        `Switch to ${targetTier.displayName}?`,
        'Some features and your monthly AI usage ceiling will change. You may need to quickly re-confirm your payment method to complete the switch.',
        [
          { text: 'Keep current plan', style: 'cancel' },
          { text: 'Switch', onPress: () => handleChangeTier(targetTier) },
        ]
      );
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Subscription & Billing</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20 }}>
        {loadingUsage && (
          <View style={[styles.card, styles.usageSkeletonCard]}>
            <Text style={styles.usageSkeletonText}>Usage loading...</Text>
          </View>
        )}
        {!loadingUsage && usage && (
          <View style={styles.card}>
            <View style={styles.usageHeaderRow}>
              <Text style={styles.cardTitleLeft}>Your Usage</Text>
              <View style={styles.planBadge}>
                <Text style={styles.planBadgeText}>{usage.plan.toUpperCase()}</Text>
              </View>
            </View>
            <View style={styles.usageRow}>
              <Text style={styles.usageLabel}>AI Credits balance</Text>
              <Text style={styles.usageValueBold}>{usage.walletCreditsRemaining}</Text>
            </View>
            <View style={styles.usageRow}>
              <Text style={styles.usageLabel}>
                {usage.currentPeriod.periodType === 'free_window' ? 'Current 5-hour window' : 'This month'}
              </Text>
              <Text style={styles.usageValue}>{usage.currentPeriod.percentUsed}% used</Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${usage.currentPeriod.percentUsed > 0 ? Math.max(2, Math.min(100, usage.currentPeriod.percentUsed)) : 0}%` },
                  getProgressBarColorStyle(usage.currentPeriod.percentUsed),
                ]}
              />
            </View>
            <Text style={styles.usageReset}>Resets {usage.currentPeriod.periodEndFormatted}</Text>
          </View>
        )}

        <View style={styles.card}>
          <Ionicons name="flash-outline" size={36} color="#075E54" style={{ alignSelf: 'center', marginBottom: 10 }} />
          <Text style={styles.cardTitle}>Buy AI Credits</Text>
          <Text style={styles.cardBody}>
            Top up your AI Credits any time — use them this month for extra AI queries beyond
            your plan's usual limit.
          </Text>

          {WALLET_TIERS.map((tier) => (
            <TouchableOpacity
              key={tier.amountInr}
              style={[styles.tierRow, purchasingTier !== null && styles.tierRowDisabled]}
              onPress={() => handleBuyCredits(tier)}
              disabled={purchasingTier !== null}
            >
              <View>
                <Text style={styles.tierAmount}>₹{tier.amountInr}</Text>
                <Text style={styles.tierCredits}>{tier.aiCredits} AI Credits</Text>
              </View>
              {purchasingTier === tier.amountInr ? (
                <ActivityIndicator size="small" color="#075E54" />
              ) : (
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              )}
            </TouchableOpacity>
          ))}

          <Text style={styles.footnote}>
            Prices shown are exclusive of GST. Credits expire at the end of the calendar month
            they're purchased in and are not transferable.
          </Text>
        </View>

        <View style={styles.card}>
          <Ionicons name="star-outline" size={36} color="#075E54" style={{ alignSelf: 'center', marginBottom: 10 }} />
          <Text style={styles.cardTitle}>Subscription Plans</Text>
          <Text style={styles.cardBody}>
            Your current plan is highlighted. Tap another to switch.
          </Text>

          {TIER_INFO.map((tierRow) => {
            const isCurrent = tierRow.tier === currentTier;
            return (
              <TouchableOpacity
                key={tierRow.tier}
                style={[
                  styles.tierRow,
                  isCurrent && styles.tierRowCurrent,
                  subscribingTier !== null && !isCurrent && styles.tierRowDisabled,
                ]}
                onPress={() => handleTierTap(tierRow)}
                disabled={subscribingTier !== null || isCurrent}
              >
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={styles.tierAmount}>{tierRow.displayName}</Text>
                    {isCurrent && (
                      <View style={styles.currentBadge}>
                        <Text style={styles.currentBadgeText}>CURRENT</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.tierCredits}>{tierRow.priceLabel}</Text>
                </View>
                {subscribingTier === tierRow.tier ? (
                  <ActivityIndicator size="small" color="#075E54" />
                ) : !isCurrent ? (
                  <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
                ) : null}
              </TouchableOpacity>
            );
          })}

          <Text style={styles.footnote}>
            Prices shown are exclusive of GST. Billed monthly, switch or cancel any time.
          </Text>
        </View>
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
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#222', textAlign: 'center', marginBottom: 8 },
  cardBody: { fontSize: 13, color: '#666', lineHeight: 19, textAlign: 'center', marginBottom: 16 },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  tierRowDisabled: { opacity: 0.5 },
  tierRowCurrent: { backgroundColor: '#F0F7F5' },
  currentBadge: {
    backgroundColor: '#075E54',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginLeft: 8,
  },
  currentBadgeText: { fontSize: 9, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.5 },
  tierAmount: { fontSize: 17, fontWeight: '700', color: '#222' },
  tierCredits: { fontSize: 12, color: '#888', marginTop: 2 },
  footnote: { fontSize: 11, color: '#999', marginTop: 14, lineHeight: 16, textAlign: 'center' },
  comingSoonCard: { opacity: 0.7 },
  usageHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  cardTitleLeft: { fontSize: 16, fontWeight: '700', color: '#222' },
  planBadge: {
    backgroundColor: '#075E54',
    borderRadius: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  planBadgeText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.5 },
  usageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  usageLabel: { fontSize: 13, color: '#666' },
  usageValue: { fontSize: 13, color: '#333', fontWeight: '600' },
  usageValueBold: { fontSize: 18, color: '#075E54', fontWeight: '700' },
  progressTrack: {
    height: 8,
    backgroundColor: '#F0F0F0',
    borderRadius: 4,
    marginTop: 10,
    overflow: 'hidden',
  },
  progressFill: {
    height: 8,
    backgroundColor: '#075E54',
    borderRadius: 4,
  },
  progressFillOrange: { backgroundColor: '#E67E22' },
  progressFillRed: { backgroundColor: '#C62828' },
  usageReset: { fontSize: 11, color: '#999', marginTop: 8, textAlign: 'right' },
  usageSkeletonCard: {
    minHeight: 184,
    justifyContent: 'center',
    alignItems: 'center',
  },
  usageSkeletonText: { fontSize: 13, color: '#BBB' },
});
