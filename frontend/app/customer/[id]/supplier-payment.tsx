/**
 * AssistMe - Record Payment Made Screen
 * Location: /frontend/app/customer/[id]/supplier-payment.tsx
 * Created: Aug 2026 (Purchase Bill / Supplier Payment feature, final subtask)
 *
 * Deliberately a LEANER mirror of record-payment.tsx, not a full copy --
 * matching the same "field-by-field discussion" philosophy already
 * applied to purchase-bill.tsx. Excluded on purpose:
 *
 * - Advance payment mode: not just a scope-trim, recordSupplierPayment()
 *   itself has zero support for this concept at all (confirmed via
 *   direct code investigation) -- there is nothing to build a UI for.
 * - The three-button Record/Share Here/Share WhatsApp structure
 *   record-payment.tsx has: started with just "Record Payment" for now,
 *   matching how purchase-bill.tsx itself stayed lean without a share
 *   feature. Can be added later using the same shareReceipt.ts utility
 *   if genuinely wanted for the supplier side.
 *
 * Calls the new POST /api/supplier-payments endpoint, a thin wrapper
 * around the existing, already-proven recordSupplierPayment() service
 * (same one Spark's record_supplier_payment case already uses) -- zero
 * new business logic. FIFO allocation across unpaid bills (oldest
 * first) if no specific bill is selected, exactly matching how
 * record-payment.tsx's own auto-allocation already works for invoices.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
  ScrollView, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useAuth } from '../../../contexts/AuthContext';
import { supabase } from '../../../lib/supabase';
import { authService } from '../../../lib/auth';

interface UnpaidBill {
  id: string; bill_number: string; total_amount: number; amount_paid: number; amount_due: number;
}

const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Other'];

const fmt = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toISODate = (d: Date) => {
  const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};
const formatDisplay = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function RecordSupplierPaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const customerId = params.id;
  const { setIsAuthenticated } = useAuth();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [supplierName, setSupplierName] = useState('');
  const [unpaidBills, setUnpaidBills] = useState<UnpaidBill[]>([]);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  // Multi-select via long-press (Aug 2026, Atif's own design), matching
  // the standard mobile pattern: a normal tap selects just one bill and
  // auto-fills the amount; a long-press enters multi-select, letting
  // further taps toggle bills in/out, summing their amounts due. No new
  // backend support needed for multiple bills -- if exactly one is
  // selected, its bill_id is still passed directly (the existing,
  // proven path); if several are selected, no specific bill_id is sent
  // at all, letting the backend's existing FIFO auto-allocation apply
  // naturally to those same (typically oldest) bills.
  const [selectedBillIds, setSelectedBillIds] = useState<string[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [notes, setNotes] = useState('');

  const getToken = async () => {
    const token = await authService.getAccessToken();
    if (!token) { await authService.clearSession(); await supabase.auth.signOut({ scope: 'local' }); setIsAuthenticated(false); router.replace('/login'); return null; }
    return token;
  };

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

        // Reuses the existing invoice/new endpoint purely for the
        // supplier's display name -- same shared endpoint purchase-
        // bill.tsx already uses, no new lookup needed for that one field.
        const nameRes = await fetch(`${backendUrl}/api/invoice/new?customer_id=${customerId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (nameRes.status === 401) { await authService.clearSession(); await supabase.auth.signOut({ scope: 'local' }); setIsAuthenticated(false); router.replace('/login'); return; }
        if (nameRes.ok) {
          const nameData = await nameRes.json();
          setSupplierName(nameData.customer?.name || '');
        }

        const res = await fetch(`${backendUrl}/api/customer/${customerId}/unpaid-purchase-bills`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUnpaidBills(data.bills || []);
        }
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  const totalDue = unpaidBills.reduce((s, b) => s + b.amount_due, 0);

  const sumDue = (ids: string[]) => unpaidBills.filter(b => ids.includes(b.id)).reduce((s, b) => s + b.amount_due, 0);

  const handleTapBill = (billId: string) => {
    if (multiSelectMode) {
      const next = selectedBillIds.includes(billId)
        ? selectedBillIds.filter(id => id !== billId)
        : [...selectedBillIds, billId];
      setSelectedBillIds(next);
      if (next.length > 0) setAmount(String(sumDue(next)));
      if (next.length === 0) setMultiSelectMode(false);
    } else {
      setSelectedBillIds([billId]);
      setAmount(String(unpaidBills.find(b => b.id === billId)?.amount_due || 0));
    }
  };

  const handleLongPressBill = (billId: string) => {
    setMultiSelectMode(true);
    const next = selectedBillIds.includes(billId) ? selectedBillIds : [...selectedBillIds, billId];
    setSelectedBillIds(next);
    setAmount(String(sumDue(next)));
  };

  const handleSelectAutoAllocate = () => {
    setSelectedBillIds([]);
    setMultiSelectMode(false);
  };

  const handleSubmit = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { Alert.alert('Error', 'Enter a valid amount'); return; }
    if (!paymentMode) { Alert.alert('Error', 'Select a payment mode'); return; }

    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/supplier-payments`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          bill_id: selectedBillIds.length === 1 ? selectedBillIds[0] : null,
          amount: amt,
          payment_date: toISODate(paymentDate),
          payment_mode: paymentMode,
          notes: notes || null,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const messages: Record<string, string> = {
          amount_exceeds_total_due: `Amount exceeds total due (${fmt(err.detail?.total_due || 0)}). Enter an amount up to that.`,
          amount_exceeds_due: `Amount exceeds this bill's remaining due (${fmt(err.detail?.max_payable || 0)}).`,
          no_unpaid_bills: 'This supplier has no unpaid bills to apply a payment to.',
          bill_already_paid: 'That bill is already fully paid.',
        };
        Alert.alert('Error', messages[err.error] || 'Failed to record payment');
        return;
      }

      const result = await res.json();
      Alert.alert('Payment Recorded', `${fmt(result.total_applied || 0)} recorded — ${result.entity_name || ''}`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (err) {
      console.error('[handleSubmit] supplier payment', err);
      Alert.alert('Error', 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <View style={s.center}><ActivityIndicator size="large" color="#075E54" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Record Payment Made</Text>
      </View>

      <ScrollView contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={s.sectionLabel}>SUPPLIER</Text>
        <View style={s.card}>
          <Text style={s.supplierName}>{supplierName || 'Unknown supplier'}</Text>
          {unpaidBills.length > 0 && (
            <Text style={s.dueText}>{fmt(totalDue)} total due across {unpaidBills.length} bill{unpaidBills.length !== 1 ? 's' : ''}</Text>
          )}
        </View>

        <Text style={s.sectionLabel}>AMOUNT</Text>
        <TextInput
          style={s.amountInput}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="numeric"
          placeholderTextColor="#CCC"
        />

        <Text style={s.sectionLabel}>PAYMENT DATE</Text>
        <TouchableOpacity style={s.input} onPress={() => setShowDatePicker(true)}>
          <Text style={s.dateText}>{formatDisplay(paymentDate)}</Text>
        </TouchableOpacity>
        {showDatePicker && (
          <DateTimePicker
            value={paymentDate}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            maximumDate={new Date()}
            onChange={(event, selected) => {
              setShowDatePicker(Platform.OS === 'ios');
              if (selected) setPaymentDate(selected);
            }}
          />
        )}

        <Text style={s.sectionLabel}>PAYMENT MODE</Text>
        <View style={s.modeRow}>
          {PAYMENT_MODES.map(mode => (
            <TouchableOpacity
              key={mode}
              style={[s.modeChip, paymentMode === mode && s.modeChipActive]}
              onPress={() => setPaymentMode(mode)}
            >
              <Text style={[s.modeChipText, paymentMode === mode && s.modeChipTextActive]}>{mode}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {unpaidBills.length > 0 && (
          <>
            <Text style={s.sectionLabel}>APPLY TO A SPECIFIC BILL (OPTIONAL)</Text>
            <Text style={s.helperText}>Leave unselected to apply oldest-first automatically.</Text>
            <TouchableOpacity
              style={[s.billRow, selectedBillIds.length === 0 && s.billRowActive]}
              onPress={handleSelectAutoAllocate}
            >
              <Text style={s.billRowText}>Auto-allocate (oldest first)</Text>
              {selectedBillIds.length === 0 && <Ionicons name="checkmark-circle" size={20} color="#075E54" />}
            </TouchableOpacity>
            {unpaidBills.map(bill => (
              <TouchableOpacity
                key={bill.id}
                style={[s.billRow, selectedBillIds.includes(bill.id) && s.billRowActive]}
                onPress={() => handleTapBill(bill.id)}
                onLongPress={() => handleLongPressBill(bill.id)}
              >
                <View>
                  <Text style={s.billRowText}>{bill.bill_number}</Text>
                  <Text style={s.billRowMeta}>{fmt(bill.amount_due)} due of {fmt(bill.total_amount)}</Text>
                </View>
                {selectedBillIds.includes(bill.id) && <Ionicons name="checkmark-circle" size={20} color="#075E54" />}
              </TouchableOpacity>
            ))}
          </>
        )}

        <Text style={s.sectionLabel}>NOTES</Text>
        <TextInput
          style={[s.input, s.notesInput]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Optional"
          placeholderTextColor="#AAA"
          multiline
        />
      </ScrollView>

      <SafeAreaView style={s.footer} edges={['bottom']}>
        <TouchableOpacity style={s.submitBtn} onPress={handleSubmit} disabled={submitting}>
          {submitting ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.submitText}>Record Payment</Text>}
        </TouchableOpacity>
      </SafeAreaView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#075E54', paddingVertical: 12, paddingHorizontal: 8 },
  headerBtn: { padding: 8 },
  headerTitle: { flex: 1, color: '#FFF', fontSize: 18, fontWeight: '700', marginLeft: 4 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  sectionLabel: { fontSize: 11, fontWeight: '600', color: '#999', letterSpacing: 0.5, marginBottom: 8, marginTop: 16 },
  helperText: { fontSize: 12, color: '#999', marginTop: -4, marginBottom: 8 },
  card: { backgroundColor: '#FFF', borderRadius: 10, padding: 14 },
  supplierName: { fontSize: 16, fontWeight: '600', color: '#1A1A1A' },
  dueText: { fontSize: 13, color: '#D32F2F', marginTop: 4 },
  amountInput: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 14, fontSize: 24, fontWeight: '700', color: '#075E54' },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
  dateText: { fontSize: 15, color: '#1A1A1A' },
  notesInput: { minHeight: 70, textAlignVertical: 'top', fontSize: 15, color: '#1A1A1A' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#E0E0E0', backgroundColor: '#FFF' },
  modeChipActive: { backgroundColor: '#075E54', borderColor: '#075E54' },
  modeChipText: { fontSize: 13, color: '#666' },
  modeChipTextActive: { color: '#FFF', fontWeight: '600' },
  billRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#F0F0F0' },
  billRowActive: { borderColor: '#075E54', backgroundColor: '#E8F5E9' },
  billRowText: { fontSize: 14, fontWeight: '600', color: '#1A1A1A' },
  billRowMeta: { fontSize: 12, color: '#999', marginTop: 2 },
  footer: { padding: 16, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#F0F0F0' },
  submitBtn: { backgroundColor: '#075E54', borderRadius: 10, paddingVertical: 16, alignItems: 'center' },
  submitText: { fontSize: 16, fontWeight: '700', color: '#FFF' },
});
