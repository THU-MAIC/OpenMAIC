/**
 * Google (Gemini) TTS — provider registry entry.
 *
 * Client-safe: types only, no Node imports (mirrors the contract of
 * `lib/audio/constants.ts`). The server adapter is `./google-tts.ts`.
 *
 * Source of truth (measured 12.09.2026, ai.google.dev/gemini-api/docs/speech-generation):
 * models `gemini-3.1-flash-tts-preview` · `gemini-2.5-flash-preview-tts` ·
 * `gemini-2.5-pro-preview-tts`; 30 prebuilt voices; Turkish (`tr`) supported;
 * no speed parameter (pace is steered by natural-language prompts / audio tags).
 */

import type { TTSProviderConfig, TTSVoiceInfo } from '@/lib/audio/types';

export const GOOGLE_TTS_PROVIDER_ID = 'google-tts' as const;
export const GOOGLE_TTS_DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
export const GOOGLE_TTS_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// [voice name, one-word character from the docs table]. Kore first: the docs'
// own default and a firm, clear narration voice for lessons.
const VOICES: ReadonlyArray<readonly [string, string]> = [
  ['Kore', 'Firm'],
  ['Zephyr', 'Bright'],
  ['Puck', 'Upbeat'],
  ['Charon', 'Informative'],
  ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'],
  ['Orus', 'Firm'],
  ['Aoede', 'Breezy'],
  ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'],
  ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'],
  ['Algieba', 'Smooth'],
  ['Despina', 'Smooth'],
  ['Erinome', 'Clear'],
  ['Algenib', 'Gravelly'],
  ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'],
  ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'],
  ['Schedar', 'Even'],
  ['Gacrux', 'Mature'],
  ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'],
  ['Vindemiatrix', 'Gentle'],
  ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'],
  ['Sulafat', 'Warm'],
];

const voices: TTSVoiceInfo[] = VOICES.map(([id, description]) => ({
  id,
  name: id,
  // Every prebuilt voice speaks all supported languages; the language is
  // detected from the input text (no per-voice locale).
  language: 'multi',
  description,
}));

export const GOOGLE_TTS_PROVIDER: TTSProviderConfig = {
  id: GOOGLE_TTS_PROVIDER_ID,
  name: 'Google TTS (Gemini)',
  requiresApiKey: true,
  defaultBaseUrl: GOOGLE_TTS_DEFAULT_BASE_URL,
  icon: '/logos/gemini.svg',
  models: [
    { id: 'gemini-3.1-flash-tts-preview', name: 'Gemini 3.1 Flash TTS (preview)' },
    { id: 'gemini-2.5-flash-preview-tts', name: 'Gemini 2.5 Flash TTS (preview)' },
    { id: 'gemini-2.5-pro-preview-tts', name: 'Gemini 2.5 Pro TTS (preview)' },
  ],
  defaultModelId: GOOGLE_TTS_DEFAULT_MODEL,
  voices,
  // The API returns raw 24 kHz 16-bit mono PCM; the adapter wraps it as WAV.
  supportedFormats: ['wav'],
  // No speedRange: the API has no speed knob (measured); the UI hides the slider.
};
