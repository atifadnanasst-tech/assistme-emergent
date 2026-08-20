/**
 * AssistMe - Record Payment Screen
 * Location: /frontend/app/customer/[id]/record-payment.tsx
 * Created: Aug 2026 (Payment recording, subtask 3)
 * Updated: Aug 2026 -- real date picker, multi-select invoices with
 * auto-summing amount, per Atif's live-testing feedback.
 * Updated: Aug 2026 -- Advance as a payment_mode (Atif's simplified
 * design): reuses the ENTIRE existing invoice-selection flow unchanged
 * (Auto-allocate / specific / multi-select all work exactly as before).
 * Selecting "Advance" mode just reveals an optional inline picker of the
 * customer's held advances (amount, date, purpose) to draw from --
 * defaults to oldest-first if none explicitly picked. recordPayment()
 * itself never becomes aware advances exist; a small separate bookkeeping
 * call decrements the chosen advance's amount_applied AFTER the normal
 * payment succeeds.
 * Updated: Aug 2026 -- SafeAreaView now reserves bottom space too (was
 * sitting on top of the Android nav bar, Atif's live-testing feedback).
 *
 * Backs the "Record payment" menu item in the customer chat's 3-dot menu.
 *
 * DEFERRED (Atif's explicit instruction, bundled into a future dedicated
 * Spark session): bank-account balance tracking on UPI/Bank Transfer,
 * Spark's own record-payment behavior, the stubbed Edit button on Spark's
 * payment card, Spark-driven invoice creation.
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
import { authService } from '../../../lib/auth';

interface UnpaidInvoice {
  id: string; invoice_number: string; total_amount: number; amount_paid: number; amount_due: number;
}
interface CustomerAdvance {
  id: string; amount: number; amount_applied: number; amount_remaining: number;
  purpose: string | null; received_date: string; payment_mode: string | null; status: string;
}

const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Advance', 'Other'];

const fmt = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toISODate = (d: Date) => {
  const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};
const formatDisplay = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDateStr = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function RecordPaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const customerId = params.id;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [unpaidInvoices, setUnpaidInvoices] = useState<UnpaidInvoice[]>([]);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set());
  const [isAdvanceMode, setIsAdvanceMode] = useState(false);
  const [advancePurpose, setAdvancePurpose] = useState('');

  const [advances, setAdvances] = useState<CustomerAdvance[]>([]);
  const [selectedAdvanceId, setSelectedAdvanceId] = useState<string | null>(null);

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

  useEffect(() => {
    if (paymentMode !== 'Advance') return;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
        const res = await fetch(`${backendUrl}/api/customer/${customerId}/advances`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setAdvances((data.advances || []).filter((a: CustomerAdvance) => a.status === 'active' && a.amount_remaining > 0));
        }
      } catch {}
    })();
  }, [paymentMode, customerId]);

  const toggleInvoiceSelection = (inv: UnpaidInvoice) => {
    setIsAdvanceMode(false);
    setSelectedInvoiceIds(prev => {
      const next = new Set(prev);
      if (next.has(inv.id)) next.delete(inv.id); else next.add(inv.id);
      return next;
    });
  };

  useEffect(() => {
    if (selectedInvoiceIds.size === 0) return;
    const sum = unpaidInvoices
      .filter(inv => selectedInvoiceIds.has(inv.id))
      .reduce((s, inv) => s + inv.amount_due, 0);
    setAmount(sum.toString());
  }, [selectedInvoiceIds, unpaidInvoices]);

  const applyFromAdvance = async (token: string, backendUrl: string, appliedTotal: number) => {
    if (paymentMode !== 'Advance' || appliedTotal <= 0) return;
    const target = selectedAdvanceId
      ? advances.find(a => a.id === selectedAdvanceId)
      : [...advances].sort((a, b) => a.received_date.localeCompare(b.received_date))[0];
    if (!target) return;
    try {
      await fetch(`${backendUrl}/api/customer/${customerId}/advance/${target.id}/apply-amount`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.min(appliedTotal, target.amount_remaining) }),
      });
    } catch (e) { console.warn('Advance bookkeeping failed (non-fatal):', e); }
  };

  const handleSubmit = async () => {
    const token = await getToken();
    if (!token) return;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const dateStr = toISODate(paymentDate);

    setSubmitting(true);
    try {
      if (isAdvanceMode) {
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) { Alert.alert('Error', 'Enter a valid amount'); setSubmitting(false); return; }
        const res = await fetch(`${backendUrl}/api/customer/${customerId}/advance`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: amt, purpose: advancePurpose || undefined,
            received_date: dateStr, payment_mode: paymentMode || undefined,
          }),
        });
        if (res.ok) {
          Alert.alert('Advance Recorded', `${fmt(amt)} held as an advance${advancePurpose ? ` for ${advancePurpose}` : ''}.`, [
            { text: 'OK', onPress: () => router.back() },
          ]);
        } else {
          Alert.alert('Error', 'Could not record advance. Please try again.');
        }
      } else if (selectedInvoiceIds.size > 0) {
        const targets = unpaidInvoices.filter(inv => selectedInvoiceIds.has(inv.id));
        const resultLines: string[] = [];
        let anyFailed = false;
        let appliedTotal = 0;
        for (const inv of targets) {
          const res = await fetch(`${backendUrl}/api/payments`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              customer_id: customerId, invoice_id: inv.id, amount: inv.amount_due,
              payment_date: dateStr, payment_mode: paymentMode || undefined,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            resultLines.push(`${fmt(inv.amount_due)} applied to ${inv.invoice_number} — fully paid`);
            appliedTotal += Number(data.total_applied || inv.amount_due);
          } else {
            anyFailed = true;
            resultLines.push(`${inv.invoice_number}: failed (${data.error || 'error'})`);
          }
        }
        await applyFromAdvance(token, backendUrl, appliedTotal);
        Alert.alert(anyFailed ? 'Payment Partially Recorded' : 'Payment Recorded', resultLines.join('\n'), [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else {
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) { Alert.alert('Error', 'Enter a valid amount'); setSubmitting(false); return; }
        const res = await fetch(`${backendUrl}/api/payments`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_id: customerId, amount: amt,
            payment_date: dateStr, payment_mode: paymentMode || undefined,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          await applyFromAdvance(token, backendUrl, Number(data.total_applied || amt));
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
      }
    } catch {
      Alert.alert('Error', 'Could not record payment. Please try again.');
    } finally { setSubmitting(false); }
  };

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
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
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>AMOUNT <Text style={{ color: 'red' }}>*</Text></Text>
          <TextInput
            style={[s.input, selectedInvoiceIds.size > 0 && s.inputReadOnly]}
            value={amount}
            onChangeText={selectedInvoiceIds.size === 0 ? setAmount : undefined}
            editable={selectedInvoiceIds.size === 0}
            keyboardType="numeric" placeholder="0.00" placeholderTextColor="#999"
          />
          {selectedInvoiceIds.size > 0 && (
            <Text style={s.helperText}>Auto-summed from {selectedInvoiceIds.size} selected invoice{selectedInvoiceIds.size > 1 ? 's' : ''}</Text>
          )}

          <Text style={s.label}>PAYMENT DATE</Text>
          <TouchableOpacity style={s.input} onPress={() => setShowDatePicker(true)}>
            <Text style={{ fontSize: 15, color: '#1A1A1A' }}>{formatDisplay(paymentDate)}</Text>
          </TouchableOpacity>
          {showDatePicker && (
            <DateTimePicker
              value={paymentDate}
              mode="date"
              maximumDate={new Date()}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event: any, date?: Date) => {
                if (Platform.OS === 'android') setShowDatePicker(false);
                if (date) setPaymentDate(date);
              }}
              themeVariant="light"
            />
          )}

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
          {paymentMode === 'Advance' && (
            <View style={{ marginBottom: 8 }}>
              {advances.length === 0 ? (
                <Text style={s.emptyText}>This customer has no advances available to draw from.</Text>
              ) : (
                <>
                  <Text style={s.helperText}>Optional: pick which advance to draw from, or leave unselected to use the oldest first.</Text>
                  {advances.map(adv => (
                    <TouchableOpacity
                      key={adv.id}
                      style={[s.invoiceRow, selectedAdvanceId === adv.id && s.invoiceRowActive]}
                      onPress={() => setSelectedAdvanceId(selectedAdvanceId === adv.id ? null : adv.id)}
                    >
                      <Ionicons name={selectedAdvanceId === adv.id ? 'radio-button-on' : 'radio-button-off'} size={20} color="#075E54" />
                      <View style={{ marginLeft: 10, flex: 1 }}>
                        <Text style={s.invoiceRowTitle}>{fmt(adv.amount_remaining)} remaining{adv.purpose ? ` — ${adv.purpose}` : ''}</Text>
                        <Text style={s.invoiceRowSubtitle}>Received {formatDateStr(adv.received_date)}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </>
              )}
            </View>
          )}

          <Text style={s.label}>APPLY TO</Text>
          <Text style={s.helperText}>Tap for Auto-allocate, or long-press an invoice to select multiple.</Text>
          <TouchableOpacity
            style={[s.invoiceRow, isAdvanceMode && s.invoiceRowActive]}
            onPress={() => { setIsAdvanceMode(true); setSelectedInvoiceIds(new Set()); }}
          >
            <Ionicons name={isAdvanceMode ? 'radio-button-on' : 'radio-button-off'} size={20} color="#075E54" />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={s.invoiceRowTitle}>Record as a new Advance</Text>
              <Text style={s.invoiceRowSubtitle}>Not applied to any invoice yet -- hold it for later</Text>
            </View>
          </TouchableOpacity>
          {isAdvanceMode && (
            <View style={{ marginBottom: 8 }}>
              <Text style={[s.label, { marginTop: 4 }]}>PURPOSE (OPTIONAL)</Text>
              <TextInput style={s.input} value={advancePurpose} onChangeText={setAdvancePurpose} placeholder="e.g. For Product X order" placeholderTextColor="#999" />
            </View>
          )}
          <TouchableOpacity
            style={[s.invoiceRow, !isAdvanceMode && selectedInvoiceIds.size === 0 && s.invoiceRowActive]}
            onPress={() => { setIsAdvanceMode(false); setSelectedInvoiceIds(new Set()); }}
          >
            <Ionicons name={selectedInvoiceIds.size === 0 ? 'radio-button-on' : 'radio-button-off'} size={20} color="#075E54" />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={s.invoiceRowTitle}>Auto-allocate</Text>
              <Text style={s.invoiceRowSubtitle}>Applies across unpaid invoices, oldest first</Text>
            </View>
          </TouchableOpacity>
          {unpaidInvoices.map(inv => (
            <TouchableOpacity
              key={inv.id}
              style={[s.invoiceRow, selectedInvoiceIds.has(inv.id) && s.invoiceRowActive]}
              onPress={() => selectedInvoiceIds.size > 0 && toggleInvoiceSelection(inv)}
              onLongPress={() => toggleInvoiceSelection(inv)}
            >
              <Ionicons name={selectedInvoiceIds.has(inv.id) ? 'checkbox' : 'square-outline'} size={20} color="#075E54" />
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
  inputReadOnly: { backgroundColor: '#F0F0F0' },
  helperText: { fontSize: 12, color: '#999', marginTop: 4, marginBottom: 8 },
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
