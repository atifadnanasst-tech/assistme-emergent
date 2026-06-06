/**
 * AssistMe — extractAttachmentContext.js
 * Created: Phase 2, Jun 2026
 *
 * PURPOSE:
 *   Shared attachment extraction helper. Converts image/audio/document attachments
 *   into a plain text context string that can be injected into any AI prompt.
 *
 * CONSUMER (v1): Org AI freeform (dispatchFreeform)
 * FUTURE CONSUMERS (post-v1):
 *   - Spark (ATTACH-REF-01): retains inline implementation — migrate after v1 deployment
 *   - Customer AI (ATTACH-REF-02): retains inline implementation — migrate after v1 deployment
 *
 * INTERFACE DESIGN:
 *   extractAttachmentContext({ attachment, purpose, llmClient })
 *   - attachment: { url, type, mime_type, name, caption? }
 *   - purpose: 'org_ai' | 'spark' | 'customer_ai' (only 'org_ai' active in v1)
 *   - llmClient: accepts any OpenAI-compatible client object.
 *     Interface is intentionally named llmClient (not openai) to signal future
 *     provider abstraction. Current implementation uses OpenAI APIs directly:
 *     vision via llmClient.chat.completions.create (gpt-4o-mini)
 *     transcription via llmClient.audio.transcriptions.create (whisper-1)
 *     The openai npm package toFile() helper is also imported internally.
 *     Full provider abstraction is deferred post-v1 (PROVIDER-ABSTRACT-01).
 *
 * SECURITY MODEL: Matches Spark's implementation exactly —
 *   URL hostname validated against SUPABASE_URL env var hostname.
 *   MIME type prefix checked. Audio file extension whitelisted.
 *   Customer AI's looser model (no URL/MIME/ext validation) NOT adopted here.
 *
 * IMAGE STRATEGY: Two-pass (matches Spark) —
 *   fetch → base64 → separate vision call → extract text → return as string.
 *   Superior for document ingestion (GST certs, visiting cards, letterheads).
 *   Customer AI's one-pass (URL passed directly to main model) is better for
 *   conversational image reasoning but not for identity document extraction.
 *
 * PDF / DOCUMENT STRATEGY (v1):
 *   PDFs and non-image/audio files are NOT extracted in v1.
 *   The UI (Org AI attach sheet) should NOT offer Document picker until
 *   ATTACH-REF-03 (PDF text extraction) is implemented.
 *   If a document somehow arrives, this helper returns a clear fallback string
 *   so the AI can tell the owner rather than silently failing.
 *
 * OUTPUT: { contextString: string, inputModality: string }
 *   contextString: ready to inject into prompt. Empty string if no attachment.
 *   inputModality: 'text' | 'image' | 'audio' | 'document'
 */

// No top-level imports required.
// fetch, Buffer, URL, AbortController are Node.js globals in this environment.
// openai toFile() is dynamically imported inside _extractAudioContext only when needed.

// ── Purpose-specific vision prompts ──────────────────────────────────────────

const VISION_PROMPTS = {
  org_ai: `You are reading a business identity document for an Indian MSME business owner.

Extract all visible business information and return it in this exact structure:

Business Name: [name as written]
GSTIN: [15-character GST registration number if visible — extract ONLY the value explicitly labelled GSTIN, GST No, or GST Registration Number. Do not extract PAN, CIN, or other registration codes.]
Phone: [phone number(s) if visible]
Email: [email address if visible]
Website: [website URL if visible]
Address Line 1: [street/building/area if visible]
Address Line 2: [locality/landmark if visible]
City: [city name if visible]
State: [state name if visible]
Postal Code: [PIN code if visible, must be exactly 6 digits]
Logo Detected: [yes / no]
Signature Detected: [yes / no]
Notes: [any other relevant business text]

Rules:
- Extract only what is clearly visible. Do not guess or infer.
- GSTIN format: 2 digits + 10-char PAN + 1 digit + Z + 1 char (e.g. 27AAAAA0000A1Z5). Verify this format before extracting.
- If multiple registration-like codes appear, extract only the one explicitly labelled GSTIN/GST No/GST Registration Number.
- If a field is not visible, omit it entirely from output.
- Return only the structured text above. No JSON. No explanation. No markdown.`,

  spark: null,
  customer_ai: null
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function extractAttachmentContext({ attachment, purpose, llmClient }) {
  if (!attachment) {
    return { contextString: '', inputModality: 'text' };
  }

  const { url = '', type = '', mime_type: mime = '', name = '', caption = '' } = attachment;

  if (type === 'image' || mime.startsWith('image/')) {
    return _extractImageContext({ url, mime, name, caption, purpose, llmClient });
  }

  if (type === 'audio' || mime.startsWith('audio/')) {
    return _extractAudioContext({ url, mime, name, caption, llmClient });
  }

  // Document fallback — v1 does not extract PDF/document text (ATTACH-REF-03 deferred)
  const contextString = [
    `\nAttachment: ${name || type}`,
    `Type: ${mime || type || 'unknown'}`,
    caption ? `Caption: ${caption}` : null,
    `Note: Document text extraction is not yet supported. Please type the key information from this document.`
  ].filter(Boolean).join('\n');

  return { contextString, inputModality: 'document' };
}

// ── Image extraction (two-pass: fetch → base64 → vision → text) ──────────────

async function _extractImageContext({ url, mime, name, caption, purpose, llmClient }) {
  const visionPrompt = VISION_PROMPTS[purpose];

  if (!visionPrompt) {
    console.warn(`[extractAttachmentContext] No vision prompt for purpose="${purpose}".`);
    return {
      contextString: `\nImage attached: ${name || 'image'}\n(No extraction prompt configured for purpose: ${purpose})`,
      inputModality: 'image',
    };
  }

  // Security: matches Spark's exact hostname validation logic
  const supabaseHost = process.env.SUPABASE_URL
    ? new URL(process.env.SUPABASE_URL).hostname
    : '';
  const isValidMime = mime.startsWith('image/');
  let isValidUrl = false;
  try {
    const parsedUrl = new URL(url);
    isValidUrl = supabaseHost && parsedUrl.hostname === supabaseHost;
  } catch { /* invalid URL */ }

  if (!isValidMime || !isValidUrl) {
    console.warn('[extractAttachmentContext] Image failed security check:', { mime, url: url.substring(0, 60) });
    return {
      contextString: `\nImage: ${name || 'image'}\nImage could not be processed. Please describe what is in the image.`,
      inputModality: 'image',
    };
  }

  // Fetch image
  let imgBuffer;
  const fetchController = new AbortController();
  const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
  try {
    const res = await fetch(url, { signal: fetchController.signal });
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    imgBuffer = await res.arrayBuffer();
    if (imgBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Image too large (>8MB)');
  } catch (fetchErr) {
    console.error('[extractAttachmentContext] Image fetch failed:', fetchErr.message);
    return {
      contextString: `\nImage: ${name || 'image'}\nImage could not be loaded. Please try again or describe the contents.`,
      inputModality: 'image',
    };
  } finally {
    clearTimeout(fetchTimeout);
  }

  // Vision extraction
  const visionController = new AbortController();
  const visionTimeout = setTimeout(() => visionController.abort(), 15000);
  try {
    const base64Image = Buffer.from(imgBuffer).toString('base64');
    const visionRes = await llmClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Image}`, detail: 'low' } },
        ],
      }],
      max_tokens: 600,
    }, { signal: visionController.signal });

    const visionText = visionRes.choices?.[0]?.message?.content?.trim() || '';
    console.log('[extractAttachmentContext] Vision success:', { purpose, bytes: imgBuffer.byteLength, name, extractedChars: visionText.length });

    if (visionText) {
      const parts = [`\nImage: ${name || 'image'}`];
      if (caption) parts.push(`Caption: ${caption}`);
      parts.push(`Content extracted:\n${visionText}`);
      return { contextString: parts.join('\n'), inputModality: 'image' };
    }
    return {
      contextString: `\nImage: ${name || 'image'}\nImage received but no text could be extracted. Please describe the contents.`,
      inputModality: 'image',
    };
  } catch (visionErr) {
    console.error('[extractAttachmentContext] Vision failed:', visionErr.message);
    return {
      contextString: `\nImage: ${name || 'image'}\nImage processing failed. Please try again or type the information.`,
      inputModality: 'image',
    };
  } finally {
    clearTimeout(visionTimeout);
  }
}

// ── Audio extraction (Whisper) ────────────────────────────────────────────────

async function _extractAudioContext({ url, mime, name, caption, llmClient }) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';

  // Security: matches Spark's exact validation logic
  const supabaseHost = process.env.SUPABASE_URL
    ? new URL(process.env.SUPABASE_URL).hostname
    : '';
  const isValidMime = mime.startsWith('audio/');
  const isValidExt = ['m4a', 'mp3', 'wav', 'ogg', 'webm'].includes(ext);
  let isValidUrl = false;
  try {
    const parsedUrl = new URL(url);
    isValidUrl = supabaseHost && parsedUrl.hostname === supabaseHost;
  } catch { /* invalid URL */ }

  if (!isValidMime || !isValidExt || !isValidUrl) {
    console.warn('[extractAttachmentContext] Audio failed security check:', { mime, ext, url: url.substring(0, 60) });
    return {
      contextString: `\nAudio: ${name || 'audio'}\nAudio could not be processed. Please type your message.`,
      inputModality: 'audio',
    };
  }

  // Fetch audio
  let audioBuffer;
  const fetchController = new AbortController();
  const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
  try {
    const audioRes = await fetch(url, { signal: fetchController.signal });
    if (!audioRes.ok) throw new Error('Audio fetch failed');
    audioBuffer = await audioRes.arrayBuffer();
    if (audioBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Audio too large (>8MB)');
  } catch (fetchErr) {
    console.error('[extractAttachmentContext] Audio fetch failed:', fetchErr.message);
    return {
      contextString: `\nAudio: ${name || 'audio'}\nAudio could not be loaded. Please type your message.`,
      inputModality: 'audio',
    };
  } finally {
    clearTimeout(fetchTimeout);
  }

  // Whisper transcription
  // toFile() from openai npm package — OpenAI-specific (PROVIDER-ABSTRACT-01 deferred)
  const whisperController = new AbortController();
  const whisperTimeout = setTimeout(() => whisperController.abort(), 30000);
  try {
    const { toFile } = await import('openai');
    const audioFile = await toFile(Buffer.from(audioBuffer), name || 'audio.m4a', { type: mime });
    const transcription = await llmClient.audio.transcriptions.create({
      model: 'whisper-1',
      file: audioFile,
    }, { signal: whisperController.signal });

    const transcript = transcription.text?.trim() || '';
    console.log('[extractAttachmentContext] Whisper success:', { name, chars: transcript.length });

    if (transcript) {
      const parts = [`\nVoice note: ${name || 'audio'}`];
      if (caption) parts.push(`Caption: ${caption}`);
      parts.push(`Transcript: ${transcript}`);
      return { contextString: parts.join('\n'), inputModality: 'audio' };
    }
    return {
      contextString: `\nVoice note: ${name || 'audio'}\nTranscription was empty. Please type your message.`,
      inputModality: 'audio',
    };
  } catch (whisperErr) {
    console.error('[extractAttachmentContext] Whisper failed:', whisperErr.message);
    return {
      contextString: `\nVoice note: ${name || 'audio'}\nCould not transcribe audio. Please type your message.`,
      inputModality: 'audio',
    };
  } finally {
    clearTimeout(whisperTimeout);
  }
}
