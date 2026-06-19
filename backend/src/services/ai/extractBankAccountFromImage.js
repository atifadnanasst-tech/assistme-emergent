/**
 * AssistMe — extractBankAccountFromImage.js
 * Bank Account Import (Business Profile screen, Bank Accounts section), Jun 2026
 *
 * Sibling to extractAttachmentContext.js, NOT a reuse of it -- that file
 * returns free-text description for AI-prompt injection; this returns a
 * fixed-schema JSON object for direct form pre-fill. Deliberately separate
 * vision prompt too: a passbook/cheque leaf/bank statement is a different
 * document from a GST certificate or visiting card and shouldn't share one.
 *
 * Security model and fetch/vision mechanics matched exactly to
 * extractAttachmentContext.js's image path: hostname validated against
 * SUPABASE_URL, MIME prefix checked, 10s fetch timeout, 8MB cap, 15s vision
 * timeout, gpt-4o-mini, two-pass (fetch -> base64 -> vision).
 *
 * Response shape uses { success, error?, ...fields } to match the existing
 * convention already established by createBankAccount/updateBankAccount/
 * deleteBankAccount in bankAccountsService.js -- not a new, separate contract.
 *
 * "Account Name" deliberately NOT extracted -- it's the owner's own
 * nickname, never printed on a real bank document.
 */

const VISION_PROMPT = `You are extracting bank account details from an Indian bank document (passbook page, cheque, or bank statement).

Extract these five fields using the PRINTED LABELS on the document as your guide:

1. bank_name: The name of the bank. On a cheque it usually appears prominently at the top (e.g. "State Bank of India", "HDFC Bank"). On a passbook it appears on the cover or header.

2. account_holder_name: The name of the person or business the account itself belongs to (the account owner / drawer). This may be a business name OR a personal/proprietor name -- Indian small businesses commonly collect payments into a personal or proprietor account, not just a formally named business account.

   CRITICAL on a cheque: the "Pay ___" line names the PAYEE -- the person RECEIVING the money. This is NEVER the account holder and must be ignored for this field. The actual account holder's name is typically printed elsewhere on the cheque, often near the signature line at the bottom (sometimes with "S/O" meaning "son of", or similar relationship markers), or pre-printed as part of the personalized cheque book. If you cannot find a name that is clearly the account owner (distinct from the "Pay" line), return null rather than guessing the payee's name.

   On a passbook, the account holder's name is usually printed prominently on the cover or first page -- there is no "payee" ambiguity there.

3. account_number: The account number. On a cheque, look for a label that says "A/c No.", "Account No.", or similar -- the number next to THAT label is the account number. DO NOT use the MICR code (the row of special magnetic-ink numbers printed at the very bottom of a cheque -- those are for machine processing only and are NOT the account number). On a passbook, look for "Account Number" or "A/c No." label.

4. ifsc_code: The IFSC code. On a cheque it is labeled "IFS Code", "IFSC Code", or similar -- it follows the format: 4 letters, then the digit 0, then 6 alphanumeric characters (e.g. SBIN0003867). Do not confuse this with the MICR code or branch code.

5. branch_name: The branch name or location. On a cheque this is usually printed in the bank's header block. On a passbook it may appear on the cover.

Rules:
- Use the printed LABELS to identify each field. Do not guess based on position alone.
- If a field is not clearly labeled and legible, return null for it. Never invent a value.
- Do not return the MICR line (bottom row of magnetic numbers) as the account number under any circumstances.
- Include a "confidence" field: a single number between 0 and 1 for your overall confidence in this extraction.

Return ONLY a valid JSON object with exactly these six keys: bank_name, account_holder_name, account_number, ifsc_code, branch_name, confidence. No markdown, no code fences, no explanation -- just the raw JSON object and nothing else.`;

export async function extractBankAccountFromImage({ url, mime, llmClient }) {
  const empty = { success: false, bank_name: null, account_holder_name: null, account_number: null, ifsc_code: null, branch_name: null, confidence: 0 };

  const supabaseHost = process.env.SUPABASE_URL
    ? new URL(process.env.SUPABASE_URL).hostname
    : '';
  const isValidMime = (mime || '').startsWith('image/');
  let isValidUrl = false;
  try {
    const parsedUrl = new URL(url);
    isValidUrl = supabaseHost && parsedUrl.hostname === supabaseHost;
  } catch { /* invalid URL */ }

  if (!isValidMime || !isValidUrl) {
    console.warn('[extractBankAccountFromImage] Image failed security check:', { mime, url: (url || '').substring(0, 60) });
    return { ...empty, error: 'Image could not be processed.' };
  }

  let imgBuffer;
  const fetchController = new AbortController();
  const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
  try {
    const res = await fetch(url, { signal: fetchController.signal });
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    imgBuffer = await res.arrayBuffer();
    if (imgBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Image too large (>8MB)');
  } catch (fetchErr) {
    console.error('[extractBankAccountFromImage] Image fetch failed:', fetchErr.message);
    return { ...empty, error: 'Image could not be loaded. Please try again.' };
  } finally {
    clearTimeout(fetchTimeout);
  }

  const visionController = new AbortController();
  const visionTimeout = setTimeout(() => visionController.abort(), 15000);
  try {
    const base64Image = Buffer.from(imgBuffer).toString('base64');
    const visionRes = await llmClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Image}`, detail: 'auto' } },
        ],
      }],
      max_tokens: 300,
    }, { signal: visionController.signal });

    const raw = visionRes.choices?.[0]?.message?.content?.trim() || '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[extractBankAccountFromImage] JSON parse failed:', parseErr.message, 'raw:', raw.substring(0, 200));
      return { ...empty, error: 'Could not read the image clearly. Please try again or enter details manually.' };
    }

    console.log('[extractBankAccountFromImage] Vision success:', { bytes: imgBuffer.byteLength, confidence: parsed.confidence });

    return {
      success: true,
      bank_name: parsed.bank_name || null,
      account_holder_name: parsed.account_holder_name || null,
      account_number: parsed.account_number || null,
      ifsc_code: parsed.ifsc_code || null,
      branch_name: parsed.branch_name || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
  } catch (visionErr) {
    console.error('[extractBankAccountFromImage] Vision failed:', visionErr.message);
    return { ...empty, error: 'Image processing failed. Please try again.' };
  } finally {
    clearTimeout(visionTimeout);
  }
}
