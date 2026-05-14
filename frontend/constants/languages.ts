// Canonical language registry — single source of truth
// IMPORTANT: Keep synchronized with backend ISO regex validation
// in PATCH /api/organisations (backend/src/index.js)
// UI shows human-readable labels. DB always stores ISO codes only.
// Supports future regional variants like pt-br, zh-cn, zh-tw, en-gb
// Backend validation already supports this format.

export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGE_OPTIONS = [
  { code: 'af', label: 'Afrikaans' },
  { code: 'ar', label: 'Arabic' },
  { code: 'bn', label: 'Bengali' },
  { code: 'zh', label: 'Chinese' },
  { code: 'hr', label: 'Croatian' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'en', label: 'English' },
  { code: 'fi', label: 'Finnish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'el', label: 'Greek' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'it', label: 'Italian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ko', label: 'Korean' },
  { code: 'ms', label: 'Malay' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mr', label: 'Marathi' },
  { code: 'ne', label: 'Nepali' },
  { code: 'no', label: 'Norwegian' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'fa', label: 'Persian' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' },
  { code: 'si', label: 'Sinhala' },
  { code: 'es', label: 'Spanish' },
  { code: 'sw', label: 'Swahili' },
  { code: 'sv', label: 'Swedish' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'th', label: 'Thai' },
  { code: 'tr', label: 'Turkish' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ur', label: 'Urdu' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'cy', label: 'Welsh' },
] as const;

export type LanguageCode = typeof LANGUAGE_OPTIONS[number]['code'];

export function getLanguageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find(l => l.code === code)?.label || code;
}
