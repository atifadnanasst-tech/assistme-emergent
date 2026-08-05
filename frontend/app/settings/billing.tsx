import React, { useState } from 'react';
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

// Subscription & Billing — Step 5A mobile piece (Home Menu Audit build
// item). Scoped to wallet top-ups (AI Credits) for now -- Step 5B
// (recurring pro/business subscriptions) has no backend yet, so no
// subscription UI is built here until that exists.
//
// Flow: tap a tier -> POST /api/wallet/create-order -> open
// react-native-razorpay's native checkout with the returned order_id ->
// on success, POST /api/wallet/verify-payment (fast client-side
// confirmation; the webhook on the backend is the authoritative backstop
// regardless of what happens here).
//
// order_id is REQUIRED, not optional -- Razorpay's own docs: "Payments
// made without an order_id cannot be captured and will be automatically
// refunded." Every checkout call below includes it.

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

export default function SubscriptionBilling() {
  const router = useRouter();
  const [purchasingTier, setPurchasingTier] = useState<number | null>(null);

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

      // Step 1: create the order server-side
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

      // Step 2: open native Razorpay checkout with the real order_id
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
        // User cancelled or payment failed -- not a bug, just no purchase.
        // Razorpay's own error shape: { code, description }.
        if (checkoutErr?.code !== 0) {
          // code 0 is typically user-cancelled; anything else is worth a message
          Alert.alert('Payment not completed', checkoutErr?.description || 'Please try again.');
        }
        return;
      }

      // Step 3: fast client-side confirmation. The webhook (server-side,
      // already proven live-tested) is the authoritative backstop
      // regardless of whether this call succeeds.
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
      } else {
        // Payment succeeded on Razorpay's side even if this specific call
        // failed -- the webhook will still credit it shortly. Tell the
        // owner honestly rather than imply failure.
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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Subscription & Billing</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20 }}>
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

        <View style={[styles.card, styles.comingSoonCard]}>
          <Text style={styles.cardTitle}>Subscription Plans</Text>
          <Text style={styles.footnote}>Pro and Business subscription plans are coming soon.</Text>
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
  tierAmount: { fontSize: 17, fontWeight: '700', color: '#222' },
  tierCredits: { fontSize: 12, color: '#888', marginTop: 2 },
  footnote: { fontSize: 11, color: '#999', marginTop: 14, lineHeight: 16, textAlign: 'center' },
  comingSoonCard: { opacity: 0.7 },
});
