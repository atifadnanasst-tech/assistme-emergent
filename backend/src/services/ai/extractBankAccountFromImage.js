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

const VISION_PROMPT = `You are extracting bank account details from an image (passbook page, cheque leaf, or bank statement) for an Indian MSME business.

Look at the image and extract these fields if clearly and confidently visible:
- bank_name: the name of the bank (e.g. "HDFC Bank")
- account_number: the account number, digits only, no spaces or dashes
- ifsc_code: the IFSC code (format: 4 letters, then 0, then 6 alphanumeric characters)
- branch_name: the branch name or location

Rules:
- Only extract what is clearly and confidently visible. Use null for any field that is not visible, unclear, or you are not confident about.
- Do not guess or invent values that aren't actually printed in the image.
- Do not extract the account holder's name -- it is not needed.
- Include a "confidence" field: a single number between 0 and 1 representing your overall confidence in this extraction as a whole.

Return ONLY a valid JSON object with exactly these five keys: bank_name, account_number, ifsc_code, branch_name, confidence. No markdown, no code fences, no explanation, no preamble -- just the raw JSON object and nothing else.`;

export async function extractBankAccountFromImage({ url, mime, llmClient }) {
  const empty = { success: false, bank_name: null, account_number: null, ifsc_code: null, branch_name: null, confidence: 0 };

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
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Image}`, detail: 'low' } },
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
