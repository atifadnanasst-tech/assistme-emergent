/**
 * AssistMe - Record Payment Screen
 * Location: /frontend/app/customer/[id]/record-payment.tsx
 * Created: Aug 2026 (Payment recording, subtask 3)
 *
 * Backs the "Record payment" menu item in the customer chat's 3-dot menu,
 * previously wired to an empty action. Calls POST /api/payments, now
 * rewired (subtask 1) to the canonical recordPayment() service -- the
 * same function Spark's own record_payment flow already uses live.
 *
 * Invoice targeting is optional, matching recordPayment()'s own flexible
 * behavior: pick one specific invoice, or leave on "Auto-allocate" to
 * apply the payment across unpaid invoices oldest-first, identical to
 * how Spark itself behaves.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
  ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../../../lib/auth';

interface UnpaidInvoice {
  id: string; invoice_number: string; total_amount: number; amount_paid: number; amount_due: number;
}

const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Other'];

const fmt = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayIST = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};

export default function RecordPaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const customerId = params.id;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [unpaidInvoices, setUnpaidInvoices] = useState<UnpaidInvoice[]>([]);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayIST());
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl}/api/customer/${customerId}/unpaid-invoices`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUnpaidInvoices(data.invoices || []);
        }
      } catch {} finally { setLoading(false); }
    })();
  }, [customerId]);

  // When a specific invoice is selected, pre-fill the amount with its
  // remaining due -- the common case (paying off exactly what's owed on
  // that invoice), still fully editable for a partial payment.
  const handleSelectInvoice = (inv: UnpaidInvoice | null) => {
    setSelectedInvoiceId(inv ? inv.id : null);
    if (inv) setAmount(inv.amount_due.toString());
  };

  const handleSubmit = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { Alert.alert('Error', 'Enter a valid amount'); return; }
    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/payments`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          invoice_id: selectedInvoiceId || undefined,
          amount: amt,
          payment_date: paymentDate,
          payment_mode: paymentMode || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const recorded = (data.events || []).filter((e: any) => e.type === 'payment_recorded');
        const lines = recorded.map((e: any) =>
          e.remaining_due > 0.01
            ? `${fmt(e.amount_applied)} applied to ${e.invoice_number} — ${fmt(e.remaining_due)} still pending`
            : `${fmt(e.amount_applied)} applied to ${e.invoice_number} — fully paid`
        );
        Alert.alert('Payment Recorded', lines.join('\n') || 'Payment recorded successfully.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else {
        const errorMessages: Record<string, string> = {
          no_unpaid_invoices: 'This customer has no unpaid invoices to apply a payment to.',
          amount_exceeds_due: `Amount exceeds what's due${data.detail?.max_payable ? ` (max: ${fmt(data.detail.max_payable)})` : ''}.`,
          invoice_already_paid: 'That invoice is already fully paid.',
          invoice_not_found: 'That invoice could not be found.',
        };
        Alert.alert('Error', errorMessages[data.error] || 'Could not record payment. Please try again.');
      }
    } catch {
      Alert.alert('Error', 'Could not record payment. Please try again.');
    } finally { setSubmitting(false); }
  };

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Record Payment</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#075E54" />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>AMOUNT <Text style={{ color: 'red' }}>*</Text></Text>
          <TextInput style={s.input} value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="0.00" placeholderTextColor="#999" />

          <Text style={s.label}>PAYMENT DATE</Text>
          <TextInput style={s.input} value={paymentDate} onChangeText={setPaymentDate} placeholder="YYYY-MM-DD" placeholderTextColor="#999" />

          <Text style={s.label}>PAYMENT MODE (OPTIONAL)</Text>
          <View style={s.chipRow}>
            {PAYMENT_MODES.map(mode => (
              <TouchableOpacity
                key={mode}
                style={[s.chip, paymentMode === mode && s.chipActive]}
                onPress={() => setPaymentMode(paymentMode === mode ? null : mode)}
              >
                <Text style={[s.chipText, paymentMode === mode && s.chipTextActive]}>{mode}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.label}>APPLY TO</Text>
          <TouchableOpacity style={[s.invoiceRow, !selectedInvoiceId && s.invoiceRowActive]} onPress={() => handleSelectInvoice(null)}>
            <Ionicons name={!selectedInvoiceId ? 'radio-button-on' : 'radio-button-off'} size={20} color="#075E54" />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={s.invoiceRowTitle}>Auto-allocate</Text>
              <Text style={s.invoiceRowSubtitle}>Applies across unpaid invoices, oldest first</Text>
            </View>
          </TouchableOpacity>
          {unpaidInvoices.map(inv => (
            <TouchableOpacity
              key={inv.id}
              style={[s.invoiceRow, selectedInvoiceId === inv.id && s.invoiceRowActive]}
              onPress={() => handleSelectInvoice(inv)}
            >
              <Ionicons name={selectedInvoiceId === inv.id ? 'radio-button-on' : 'radio-button-off'} size={20} color="#075E54" />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={s.invoiceRowTitle}>{inv.invoice_number}</Text>
                <Text style={s.invoiceRowSubtitle}>{fmt(inv.amount_due)} due of {fmt(inv.total_amount)}</Text>
              </View>
            </TouchableOpacity>
          ))}
          {unpaidInvoices.length === 0 && (
            <Text style={s.emptyText}>No unpaid invoices — a payment here will need Auto-allocate, and will simply reduce the customer's outstanding balance.</Text>
          )}

          <TouchableOpacity style={s.submitBtn} onPress={handleSubmit} disabled={submitting}>
            {submitting ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.submitText}>Record Payment</Text>}
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#075E54', paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  label: { fontSize: 12, fontWeight: '700', color: '#666', marginTop: 18, marginBottom: 6, letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1A1A1A', backgroundColor: '#FFFFFF' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#FFFFFF' },
  chipActive: { borderColor: '#075E54', backgroundColor: '#E8F5E9' },
  chipText: { fontSize: 13, color: '#666' },
  chipTextActive: { color: '#075E54', fontWeight: '700' },
  invoiceRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, padding: 12, marginBottom: 8 },
  invoiceRowActive: { borderColor: '#075E54', backgroundColor: '#E8F5E9' },
  invoiceRowTitle: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  invoiceRowSubtitle: { fontSize: 12, color: '#999', marginTop: 2 },
  emptyText: { fontSize: 13, color: '#999', marginTop: 4, marginBottom: 8, fontStyle: 'italic' },
  submitBtn: { marginTop: 24, backgroundColor: '#075E54', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  submitText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
