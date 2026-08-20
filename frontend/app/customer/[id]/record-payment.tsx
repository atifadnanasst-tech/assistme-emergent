/**
 * AssistMe - Record Payment Screen
 * Location: /frontend/app/customer/[id]/record-payment.tsx
 * Created: Aug 2026 (Payment recording, subtask 3)
 *
 * Updated: Aug 2026 -- mutual exclusivity fixes, mandatory payment_mode
 * (no default), precise per-rupee-accurate advance shortfall splitting.
 *
 * Updated: Aug 2026 -- three-button structure (subtask 6), mirroring
 * invoice.tsx's own Create/Share Here/WhatsApp pattern, but built as a
 * genuinely reusable utility this time (see lib/shareReceipt.ts) rather
 * than another one-off screen-local implementation, per Atif's explicit
 * instruction for future-session ease. Record Payment records only
 * (unchanged behavior); Share Here records + generates a receipt PDF +
 * posts it as a chat card visible to both sides; Share on WhatsApp
 * records + generates the receipt + opens WhatsApp with it. All three
 * call the exact same recording logic underneath -- only what happens
 * AFTER a successful recording differs.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
  ScrollView, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { authService } from '../../../lib/auth';
import { shareReceipt, ReceiptAppliedToEntry } from '../../../lib/shareReceipt';

interface UnpaidInvoice {
  id: string; invoice_number: string; total_amount: number; amount_paid: number; amount_due: number;
}
interface CustomerAdvance {
  id: string; amount: number; amount_applied: number; amount_remaining: number;
  purpose: string | null; received_date: string; payment_mode: string | null; status: string;
}

const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Advance', 'Other'];
const REMAINDER_MODES = PAYMENT_MODES.filter(m => m !== 'Advance');

const fmt = (n: number) => `₹${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toISODate = (d: Date) => {
  const ist = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
};
const formatDisplay = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDateStr = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

type SubmitAction = 'record' | 'share' | 'whatsapp';

export default function RecordPaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const customerId = params.id;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<SubmitAction | null>(null);
  const [unpaidInvoices, setUnpaidInvoices] = useState<UnpaidInvoice[]>([]);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const [remainderMode, setRemainderMode] = useState<string | null>(null);
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
    if (paymentMode !== 'Advance') { setRemainderMode(null); return; }
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

  const totalAdvanceAvailable = useMemo(
    () => selectedAdvanceId
      ? (advances.find(a => a.id === selectedAdvanceId)?.amount_remaining || 0)
      : advances.reduce((s, a) => s + a.amount_remaining, 0),
    [advances, selectedAdvanceId]
  );

  const requestedAmount = parseFloat(amount) || 0;
  const shortfall = paymentMode === 'Advance' && requestedAmount > totalAdvanceAvailable
    ? Math.round((requestedAmount - totalAdvanceAvailable) * 100) / 100
    : 0;

  const selectPaymentMode = (mode: string) => {
    const next = paymentMode === mode ? null : mode;
    setPaymentMode(next);
    if (next === 'Advance') setIsAdvanceMode(false);
  };

  const enterAdvanceRecordMode = () => {
    setIsAdvanceMode(true);
    setSelectedInvoiceIds(new Set());
    if (paymentMode === 'Advance') setPaymentMode(null);
  };

  const selectAutoAllocate = () => {
    setIsAdvanceMode(false);
    setSelectedInvoiceIds(new Set());
  };

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

  const applyFromAdvances = async (token: string, backendUrl: string, totalToApply: number) => {
    if (totalToApply <= 0) return;
    const ordered = selectedAdvanceId
      ? [advances.find(a => a.id === selectedAdvanceId)!, ...advances.filter(a => a.id !== selectedAdvanceId)].filter(Boolean)
      : [...advances].sort((a, b) => a.received_date.localeCompare(b.received_date));
    let remaining = totalToApply;
    for (const adv of ordered) {
      if (remaining <= 0) break;
      const drawAmount = Math.min(remaining, adv.amount_remaining);
      if (drawAmount <= 0) continue;
      try {
        await fetch(`${backendUrl}/api/customer/${customerId}/advance/${adv.id}/apply-amount`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: drawAmount }),
        });
        remaining = Math.round((remaining - drawAmount) * 100) / 100;
      } catch (e) { console.warn('Advance bookkeeping failed (non-fatal):', e); }
    }
  };

  const maybeShareReceipt = async (
    token: string, backendUrl: string, action: SubmitAction,
    totalAmount: number, modeForReceipt: string, appliedTo: ReceiptAppliedToEntry[], dateStr: string
  ) => {
    if (action === 'record' || totalAmount <= 0) return null;
    const result = await shareReceipt({
      token, backendUrl, customerId: customerId!, totalAmount,
      paymentMode: modeForReceipt, appliedTo, receiptDate: dateStr,
      channel: action === 'share' ? 'app' : 'whatsapp',
    });
    if (result.error) {
      Alert.alert('Payment Recorded', 'The payment was recorded, but the receipt could not be shared. You can find it later.');
      return null;
    }
    if (action === 'whatsapp' && result.whatsapp_url) {
      const { Linking } = await import('react-native');
      Linking.openURL(result.whatsapp_url).catch(() => {});
    }
    return result;
  };

  const handleSubmit = async (action: SubmitAction) => {
    if (!paymentMode) { Alert.alert('Payment Mode Required', 'Select how this payment was received.'); return; }
    if (shortfall > 0 && !remainderMode) {
      Alert.alert('Remainder Tag Required', `${fmt(shortfall)} isn't covered by available advance -- select how the rest was received.`);
      return;
    }

    const token = await getToken();
    if (!token) return;
    const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
    const dateStr = toISODate(paymentDate);

    setSubmitting(action);
    try {
      if (isAdvanceMode) {
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) { Alert.alert('Error', 'Enter a valid amount'); setSubmitting(null); return; }
        const res = await fetch(`${backendUrl}/api/customer/${customerId}/advance`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: amt, purpose: advancePurpose || undefined,
            received_date: dateStr, payment_mode: paymentMode,
          }),
        });
        if (res.ok) {
          await maybeShareReceipt(token, backendUrl, action, amt, paymentMode, [], dateStr);
          Alert.alert('Advance Recorded', `${fmt(amt)} held as an advance${advancePurpose ? ` for ${advancePurpose}` : ''}.`, [
            { text: 'OK', onPress: () => router.back() },
          ]);
        } else {
          Alert.alert('Error', 'Could not record advance. Please try again.');
        }
      } else if (selectedInvoiceIds.size > 0) {
        const targets = unpaidInvoices.filter(inv => selectedInvoiceIds.has(inv.id));
        const resultLines: string[] = [];
        const appliedTo: ReceiptAppliedToEntry[] = [];
        let anyFailed = false;
        let advanceRunningTotal = 0;
        let advanceAppliedTotal = 0;
        let recordedTotal = 0;
        for (const inv of targets) {
          const wouldBeTotal = advanceRunningTotal + inv.amount_due;
          const tagForThisInvoice = paymentMode === 'Advance' && wouldBeTotal > totalAdvanceAvailable
            ? remainderMode!
            : paymentMode!;
          if (tagForThisInvoice === paymentMode) advanceRunningTotal = wouldBeTotal;

          const res = await fetch(`${backendUrl}/api/payments`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              customer_id: customerId, invoice_id: inv.id, amount: inv.amount_due,
              payment_date: dateStr, payment_mode: tagForThisInvoice,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            resultLines.push(`${fmt(inv.amount_due)} applied to ${inv.invoice_number} — fully paid`);
            appliedTo.push({ invoice_number: inv.invoice_number, amount_applied: inv.amount_due, remaining_due: 0 });
            recordedTotal += inv.amount_due;
            if (tagForThisInvoice === paymentMode && paymentMode === 'Advance') {
              advanceAppliedTotal += Number(data.total_applied || inv.amount_due);
            }
          } else {
            anyFailed = true;
            resultLines.push(`${inv.invoice_number}: failed (${data.error || 'error'})`);
          }
        }
        if (paymentMode === 'Advance') await applyFromAdvances(token, backendUrl, advanceAppliedTotal);
        await maybeShareReceipt(token, backendUrl, action, recordedTotal, paymentMode, appliedTo, dateStr);
        Alert.alert(anyFailed ? 'Payment Partially Recorded' : 'Payment Recorded', resultLines.join('\n'), [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else {
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) { Alert.alert('Error', 'Enter a valid amount'); setSubmitting(null); return; }

        const segments: { amt: number; mode: string }[] = shortfall > 0
          ? [{ amt: Math.round((amt - shortfall) * 100) / 100, mode: paymentMode }, { amt: shortfall, mode: remainderMode! }]
          : [{ amt, mode: paymentMode }];

        const allLines: string[] = [];
        const appliedTo: ReceiptAppliedToEntry[] = [];
        let advanceAppliedTotal = 0;
        let recordedTotal = 0;
        let anyFailed = false;
        for (const seg of segments) {
          if (seg.amt <= 0) continue;
          const res = await fetch(`${backendUrl}/api/payments`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              customer_id: customerId, amount: seg.amt,
              payment_date: dateStr, payment_mode: seg.mode,
            }),
          });
          const data = await res.json();
          if (res.ok) {
            if (seg.mode === 'Advance') advanceAppliedTotal += Number(data.total_applied || seg.amt);
            recordedTotal += seg.amt;
            const recorded = (data.events || []).filter((e: any) => e.type === 'payment_recorded');
            recorded.forEach((e: any) => {
              allLines.push(e.remaining_due > 0.01
                ? `${fmt(e.amount_applied)} applied to ${e.invoice_number} — ${fmt(e.remaining_due)} still pending`
                : `${fmt(e.amount_applied)} applied to ${e.invoice_number} — fully paid`);
              appliedTo.push({ invoice_number: e.invoice_number, amount_applied: e.amount_applied, remaining_due: e.remaining_due || 0 });
            });
          } else {
            anyFailed = true;
            const errorMessages: Record<string, string> = {
              no_unpaid_invoices: 'No unpaid invoices to apply to.',
              amount_exceeds_due: `Amount exceeds what's due.`,
            };
            allLines.push(errorMessages[data.error] || `Failed: ${data.error || 'error'}`);
          }
        }
        if (advanceAppliedTotal > 0) await applyFromAdvances(token, backendUrl, advanceAppliedTotal);
        await maybeShareReceipt(token, backendUrl, action, recordedTotal, paymentMode, appliedTo, dateStr);
        Alert.alert(anyFailed ? 'Payment Partially Recorded' : 'Payment Recorded', allLines.join('\n') || 'Payment recorded successfully.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    } catch {
      Alert.alert('Error', 'Could not record payment. Please try again.');
    } finally { setSubmitting(null); }
  };

  const canSubmit = !!paymentMode && (shortfall === 0 || !!remainderMode);

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

          <Text style={s.label}>PAYMENT MODE <Text style={{ color: 'red' }}>*</Text></Text>
          <View style={s.chipRow}>
            {PAYMENT_MODES.map(mode => (
              <TouchableOpacity
                key={mode}
                style={[s.chip, paymentMode === mode && s.chipActive]}
                onPress={() => selectPaymentMode(mode)}
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
                  <Text style={s.helperText}>Optional: pick which advance to draw from, or leave unselected to use the oldest first (spills to more than one if needed).</Text>
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
              {shortfall > 0 && (
                <View style={s.shortfallBox}>
                  <Text style={s.shortfallText}>
                    Only {fmt(totalAdvanceAvailable)} available in advance — {fmt(shortfall)} needs another payment method.
                  </Text>
                  <Text style={[s.label, { marginTop: 10, color: '#B45309' }]}>REMAINDER TAG <Text style={{ color: 'red' }}>*</Text></Text>
                  <View style={s.chipRow}>
                    {REMAINDER_MODES.map(mode => (
                      <TouchableOpacity
                        key={mode}
                        style={[s.chip, remainderMode === mode && s.chipActive]}
                        onPress={() => setRemainderMode(remainderMode === mode ? null : mode)}
                      >
                        <Text style={[s.chipText, remainderMode === mode && s.chipTextActive]}>{mode}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </View>
          )}

          <Text style={s.label}>APPLY TO</Text>
          <Text style={s.helperText}>Tap for Auto-allocate, or long-press an invoice to select multiple.</Text>
          <TouchableOpacity
            style={[s.invoiceRow, isAdvanceMode && s.invoiceRowActive]}
            onPress={enterAdvanceRecordMode}
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
            onPress={selectAutoAllocate}
          >
            <Ionicons name={!isAdvanceMode && selectedInvoiceIds.size === 0 ? 'radio-button-on' : 'radio-button-off'} size={20} color="#075E54" />
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

          <View style={s.buttonRow}>
            <TouchableOpacity style={[s.recordBtn, !canSubmit && s.btnDisabled]} onPress={() => handleSubmit('record')} disabled={!!submitting || !canSubmit}>
              {submitting === 'record' ? <ActivityIndicator size="small" color="#333" /> : <Text style={s.recordBtnText}>Record</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={[s.shareBtn, !canSubmit && s.btnDisabled]} onPress={() => handleSubmit('share')} disabled={!!submitting || !canSubmit}>
              {submitting === 'share' ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.shareBtnText}>Share Here</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={[s.waBtn, !canSubmit && s.btnDisabled]} onPress={() => handleSubmit('whatsapp')} disabled={!!submitting || !canSubmit}>
              {submitting === 'whatsapp' ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={s.waBtnText}>WhatsApp</Text>}
            </TouchableOpacity>
          </View>
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
  shortfallBox: { marginTop: 8, backgroundColor: '#FEF3C7', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#FCD34D' },
  shortfallText: { fontSize: 13, color: '#92400E', fontWeight: '600' },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 24 },
  recordBtn: { flex: 1, backgroundColor: '#F0F0F0', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  recordBtnText: { fontSize: 13, fontWeight: '700', color: '#333' },
  shareBtn: { flex: 1, backgroundColor: '#075E54', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  shareBtnText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  waBtn: { flex: 1, backgroundColor: '#25D366', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  waBtnText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  btnDisabled: { opacity: 0.4 },
});
