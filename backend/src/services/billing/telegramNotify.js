// Telegram Notifications (Subscription & Billing). See
// ASSISTME_V2_ARCHITECTURAL_BACKLOG.md -> "Subscription & Billing".
//
// Fire-and-forget, non-throwing -- same philosophy as recordAiUsage() and
// every other notification-style side effect in this codebase. A Telegram
// API hiccup must NEVER delay or break an actual payment confirmation the
// customer is waiting on.
//
// Recipient is a plain env var (TELEGRAM_CHAT_ID) specifically so handing
// this off to a designated manager later, or toggling it off, is a one-line
// .env change -- not a code change.

export async function sendTelegramAlert(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.warn('[sendTelegramAlert] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping.');
      return { success: false, error: 'not_configured' };
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn('[sendTelegramAlert] Telegram API error:', res.status, errBody);
      return { success: false, error: 'telegram_api_error' };
    }
    return { success: true };
  } catch (err) {
    console.warn('[sendTelegramAlert] non-blocking error:', err.message);
    return { success: false, error: err.message };
  }
}
