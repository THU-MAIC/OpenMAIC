/**
 * Google (Gemini 3.5 Transcribe) ASR — provider registry entry.
 *
 * Client-safe: types only, no Node imports. The server adapter is `./google-asr.ts`.
 *
 * Source of truth (measured 16.09.2026):
 *   ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe — model codes
 *   `gemini-3.5-transcribe` (unary, up to 1 h audio) and
 *   `gemini-3.5-transcribe-live` (Live API streaming; not used here);
 *   "utterance-based language detection", 85+ languages as BCP-47 codes,
 *   Turkish = `tr-TR`; last update "August 2026".
 *   ai.google.dev/gemini-api/docs/transcribe — REST: POST {base}/interactions,
 *   `generation_config.transcription_config.language_codes` (BCP-47, `[]` =
 *   auto-detect); transcript in `output_text`.
 *   Pricing page: $0.003/min audio in, $0.002/min text out.
 */

import type { ASRProviderConfig } from '@/lib/audio/types';

export const GOOGLE_ASR_PROVIDER_ID = 'google-asr' as const;
export const GOOGLE_ASR_DEFAULT_MODEL = 'gemini-3.5-transcribe';
export const GOOGLE_ASR_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * BCP-47 codes copied from the model page's supported-languages table, limited
 * to the ones the UI already labels for `browser-native` (same code family, so
 * a language chosen for one provider stays valid when switching to the other).
 * `auto` first: the model's own default is utterance-level detection.
 */
export const GOOGLE_ASR_LANGUAGES: readonly string[] = [
  'auto',
  'tr-TR',
  'en-US',
  'en-GB',
  'en-IN',
  'de-DE',
  'fr-FR',
  'it-IT',
  'pt-BR',
  'pt-PT',
  'ru-RU',
  'nl-NL',
  'pl-PL',
  'cs-CZ',
  'da-DK',
  'fi-FI',
  'sv-SE',
  'el-GR',
  'hu-HU',
  'ro-RO',
  'sk-SK',
  'bg-BG',
  'hr-HR',
  'ca-ES',
  'ar-EG',
  'he-IL',
  'hi-IN',
  'th-TH',
  'vi-VN',
  'id-ID',
  'ms-MY',
  'fil-PH',
  'af-ZA',
  'uk-UA',
  'ja-JP',
  'ko-KR',
  'cmn-Hans-CN',
  'yue-Hant-HK',
];

export const GOOGLE_ASR_PROVIDER: ASRProviderConfig = {
  id: GOOGLE_ASR_PROVIDER_ID,
  name: 'Google ASR (Gemini 3.5 Transcribe)',
  requiresApiKey: true,
  defaultBaseUrl: GOOGLE_ASR_DEFAULT_BASE_URL,
  icon: '/logos/gemini.svg',
  models: [{ id: GOOGLE_ASR_DEFAULT_MODEL, name: 'Gemini 3.5 Transcribe' }],
  defaultModelId: GOOGLE_ASR_DEFAULT_MODEL,
  supportedLanguages: [...GOOGLE_ASR_LANGUAGES],
  // Documented input MIME types include webm (MediaRecorder's format), so the
  // recorder's upload goes through unconverted.
  supportedFormats: ['webm', 'wav', 'ogg', 'mp3', 'flac', 'm4a', 'aac', 'opus'],
};
