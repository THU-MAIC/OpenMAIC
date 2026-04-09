import type { TTSProviderId } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

export interface ResolvedVoice {
  providerId: TTSProviderId;
  voiceId: string;
}

/**
 * Extract the base language code from a locale.
 * 'es-MX' → 'es', 'en-US' → 'en', 'zh-CN' → 'zh', 'es' → 'es'.
 */
function baseLang(locale: string | undefined): string | null {
  if (!locale) return null;
  return locale.toLowerCase().split('-')[0] || null;
}

/**
 * Check whether a voice matches a target language.
 * Matches on the base code ('es' matches 'es-MX', 'es-ES', 'es-AR', ...).
 */
function voiceMatchesLang(
  voice: { language?: string },
  targetLang: string | null,
): boolean {
  if (!targetLang) return true;
  const vLang = baseLang(voice.language);
  return vLang === targetLang;
}

/**
 * Resolve the TTS provider + voice for an agent.
 *
 * Priority:
 *   1. If agent has voiceConfig AND the voice matches the locale (or no
 *      locale filter), use it as-is.
 *   2. If agent has voiceConfig but its language does NOT match the current
 *      locale, discard it and pick a matching one — this prevents an English
 *      voice from reading Spanish text when the UI is in Spanish.
 *   3. Otherwise, pick the first available provider that has at least one
 *      voice matching the locale; fall back to any voice if none match.
 *
 * @param locale - Optional UI locale (e.g. 'es-MX'). When provided, voice
 *                 selection is filtered by matching base language.
 */
export function resolveAgentVoice(
  agent: AgentConfig,
  agentIndex: number,
  availableProviders: ProviderWithVoices[],
  locale?: string,
): ResolvedVoice {
  const targetLang = baseLang(locale);

  // Agent-specific config
  if (agent.voiceConfig) {
    // Browser-native voices are dynamic (not in static registry), so skip validation
    if (agent.voiceConfig.providerId === 'browser-native-tts') {
      return agent.voiceConfig;
    }
    const provider = TTS_PROVIDERS[agent.voiceConfig.providerId];
    const voice = provider?.voices.find((v) => v.id === agent.voiceConfig!.voiceId);
    if (voice && voiceMatchesLang(voice, targetLang)) {
      return agent.voiceConfig;
    }
    // Voice exists but in wrong language → fall through to pick a new one.
  }

  // Fallback: pick the first available provider with at least one voice that
  // matches the target language. If none match, use the first provider's
  // deterministic voice regardless.
  if (availableProviders.length > 0) {
    if (targetLang) {
      for (const p of availableProviders) {
        const matching = p.voices.filter((v) => voiceMatchesLang(v, targetLang));
        if (matching.length > 0) {
          return {
            providerId: p.providerId,
            voiceId: matching[agentIndex % matching.length].id,
          };
        }
      }
    }
    const first = availableProviders[0];
    return {
      providerId: first.providerId,
      voiceId: first.voices[agentIndex % first.voices.length].id,
    };
  }

  return { providerId: 'browser-native-tts', voiceId: 'default' };
}

/**
 * Get the list of voice IDs for a TTS provider.
 * For browser-native-tts, returns empty (browser voices are dynamic).
 */
export function getServerVoiceList(providerId: TTSProviderId): string[] {
  if (providerId === 'browser-native-tts') return [];
  const provider = TTS_PROVIDERS[providerId];
  if (!provider) return [];
  return provider.voices.map((v) => v.id);
}

export interface ProviderWithVoices {
  providerId: TTSProviderId;
  providerName: string;
  voices: Array<{ id: string; name: string; language?: string }>;
}

/**
 * Get all available providers and their voices for the voice picker UI.
 * A provider is available if it has an API key or is server-configured.
 * Browser-native-tts is excluded (no static voice list).
 */
export function getAvailableProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    { apiKey?: string; enabled?: boolean; isServerConfigured?: boolean }
  >,
): ProviderWithVoices[] {
  const result: ProviderWithVoices[] = [];

  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;
    if (config.voices.length === 0) continue;

    const providerConfig = ttsProvidersConfig[providerId];
    const hasApiKey = providerConfig?.apiKey && providerConfig.apiKey.trim().length > 0;
    const isServerConfigured = providerConfig?.isServerConfigured === true;

    if (hasApiKey || isServerConfigured) {
      result.push({
        providerId,
        providerName: config.name,
        voices: config.voices.map((v) => ({
          id: v.id,
          name: v.name,
          language: v.language,
        })),
      });
    }
  }

  return result;
}

/**
 * Find a voice display name across all providers.
 */
export function findVoiceDisplayName(providerId: TTSProviderId, voiceId: string): string {
  const provider = TTS_PROVIDERS[providerId];
  if (!provider) return voiceId;
  const voice = provider.voices.find((v) => v.id === voiceId);
  return voice?.name ?? voiceId;
}
