/**
 * AssistMe - shareReceipt utility
 * Location: /frontend/lib/shareReceipt.ts
 * Created: Aug 2026 (Payment recording subtask 6)
 *
 * PURPOSE: A genuinely reusable, standalone utility -- deliberately NOT
 * modeled on invoice.tsx's own handleSubmit, which is a single monolithic
 * function tightly entangled with invoice-specific screen state (items,
 * packing, draft-resume) and therefore not actually importable elsewhere.
 * This function has no dependency on any screen's local state -- it's a
 * thin wrapper around POST /api/customer/:customer_id/receipt, callable
 * from record-payment.tsx today and from any FUTURE surface (a future
 * Documents screen action, a future Spark-driven payment flow, etc.)
 * without needing to re-implement the fetch call each time.
 *
 * Generates the receipt PDF and, depending on channel, either posts it
 * as a chat card visible to both owner and customer ('app'), or returns
 * a wa.me link for WhatsApp sharing ('whatsapp'). Passing no channel
 * just generates the PDF without sharing it anywhere.
 */

export interface ReceiptAppliedToEntry {
  invoice_number: string;
  amount_applied: number;
  remaining_due: number;
}

export interface ShareReceiptParams {
  token: string;
  backendUrl: string;
  customerId: string;
  totalAmount: number;
  paymentMode: string;
  appliedTo: ReceiptAppliedToEntry[];
  receiptDate: string;
  channel?: 'app' | 'whatsapp';
}

export interface ShareReceiptResult {
  pdf_url?: string;
  shared?: boolean;
  message_id?: string;
  whatsapp_url?: string;
  error?: string;
}

export async function shareReceipt({
  token, backendUrl, customerId, totalAmount, paymentMode, appliedTo, receiptDate, channel,
}: ShareReceiptParams): Promise<ShareReceiptResult> {
  try {
    const res = await fetch(`${backendUrl}/api/customer/${customerId}/receipt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_amount: totalAmount,
        payment_mode: paymentMode,
        applied_to: appliedTo,
        receipt_date: receiptDate,
        channel,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'unknown_error' };
    return data;
  } catch (e) {
    return { error: 'network_error' };
  }
}
