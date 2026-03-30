/**
 * Provider-keyed TTS voice map.
 *
 * Structure: VOICE_MAP[language][providerId][role]
 * - null means "use user-configured voice from settings"
 * - Uzbek and Chinese entries are hardcoded (limited voices, fixed)
 * - English entries are null = defer to user settings
 *
 * Source of truth for both server-side and client-side TTS generation.
 */

import type { TTSProviderId } from '@/lib/audio/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderVoiceEntry {
  teacher: string | null;
  student: string | null;
  default: string | null;
}

// VOICE_MAP[langPrefix][providerId]
export const VOICE_MAP: Record<string, Partial<Record<TTSProviderId, ProviderVoiceEntry>>> = {
  uz: {
    'azure-tts': {
      teacher: 'uz-UZ-MadinaNeural',
      student: 'uz-UZ-SardorNeural',
      default: 'uz-UZ-MadinaNeural',
    },
  },
  zh: {
    'openai-tts': {
      teacher: 'zf_xiaoxiao',
      student: 'zm_yunxi',
      default: 'zf_xiaoxiao',
    },
  },
  en: {
    'openai-tts': { teacher: null, student: null, default: null },
    'azure-tts': {
      teacher: 'en-US-JennyNeural',
      student: 'en-US-GuyNeural',
      default: 'en-US-JennyNeural',
    },
    'elevenlabs-tts': { teacher: null, student: null, default: null },
  },
};

// ── Provider resolution ───────────────────────────────────────────────────────

/**
 * Resolve which TTS provider to use for a given language.
 *
 * - uz  → always azure-tts (only provider with native Uzbek voices)
 * - zh  → always openai-tts (Kokoro has zh voices)
 * - en  → use currentProvider (user's configured provider)
 * - anything else → use currentProvider
 *
 * Falls back to currentProvider if the preferred provider is not in availableProviders.
 */
export function resolveProvider(
  language: string,
  currentProvider: TTSProviderId,
  availableProviders?: TTSProviderId[],
): TTSProviderId {
  const langPrefix = language.split('-')[0].toLowerCase();

  let preferred: TTSProviderId = currentProvider;
  if (langPrefix === 'uz') preferred = 'azure-tts';
  else if (langPrefix === 'zh') preferred = 'openai-tts';
  // en and everything else: keep currentProvider

  // If we have an availability list, fall back when preferred is unavailable
  if (availableProviders && availableProviders.length > 0) {
    if (!availableProviders.includes(preferred)) {
      return availableProviders[0];
    }
  }

  return preferred;
}

// ── Voice resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the TTS voice for a language + role + provider combination.
 * Never throws. Always returns a non-empty string.
 *
 * Lookup order:
 *   1. VOICE_MAP[langPrefix][provider][role]  — if non-null, use it
 *   2. userVoice                              — if provided (for null map entries)
 *   3. VOICE_MAP[langPrefix][provider].default — non-null fallback
 *   4. Hard fallback per provider
 */
export function resolveVoice(
  language: string,
  role: 'teacher' | 'student' | 'assistant' | string,
  provider: TTSProviderId,
  userVoice?: string,
): string {
  const langPrefix = language.split('-')[0].toLowerCase();
  const normalizedRole = role === 'assistant' ? 'student' : role;
  const mapRole = (normalizedRole === 'teacher' ? 'teacher' : 'student') as keyof ProviderVoiceEntry;

  const entry = VOICE_MAP[langPrefix]?.[provider];
  if (entry) {
    const mapped = entry[mapRole] ?? entry.default;
    if (mapped) return mapped;
  }

  // Null entry → use user voice or hard fallback
  if (userVoice) return userVoice;

  // Hard fallbacks by provider
  const PROVIDER_FALLBACKS: Partial<Record<TTSProviderId, string>> = {
    'openai-tts': 'af_nova',
    'azure-tts': 'en-US-JennyNeural',
    'elevenlabs-tts': 'EXAVITQu4vr4xnSDxMaL',
    'glm-tts': 'tongtong',
    'qwen-tts': 'Cherry',
    'browser-native-tts': 'default',
  };

  return PROVIDER_FALLBACKS[provider] ?? 'default';
}

// ── Convenience re-exports (backwards-compat for existing call sites) ─────────

/** @deprecated Use resolveProvider + resolveVoice instead */
export const EN_DEFAULTS = {
  teacher: { providerId: 'openai-tts' as TTSProviderId, voice: 'af_nova' },
  student: { providerId: 'openai-tts' as TTSProviderId, voice: 'am_echo' },
};
