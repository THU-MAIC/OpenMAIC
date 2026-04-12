import type { TTSProviderId } from '@/lib/audio/types';
import { isCustomTTSProvider } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

export interface ResolvedVoice {
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
}

/**
 * Resolve the TTS provider + voice for an agent.
 * 1. If agent has voiceConfig and the voice is still valid, use it
 * 2. Otherwise, use the first available provider + deterministic voice by index
 */
export function resolveAgentVoice(
  agent: AgentConfig,
  agentIndex: number,
  availableProviders: ProviderWithVoices[],
): ResolvedVoice {
  // Agent-specific config
  if (agent.voiceConfig) {
    // Browser-native voices are dynamic (not in static registry), so skip validation
    if (agent.voiceConfig.providerId === 'browser-native-tts') {
      return {
        providerId: agent.voiceConfig.providerId,
        modelId: agent.voiceConfig.modelId,
        voiceId: agent.voiceConfig.voiceId,
      };
    }
    const list = getServerVoiceList(agent.voiceConfig.providerId);
    // Also check available providers (covers custom providers with dynamic voice lists)
    const fromAvailable = availableProviders
      .find((p) => p.providerId === agent.voiceConfig!.providerId)
      ?.voices.map((v) => v.id);
    const allVoiceIds = new Set([...list, ...(fromAvailable || [])]);
    if (allVoiceIds.has(agent.voiceConfig.voiceId)) {
      return {
        providerId: agent.voiceConfig.providerId,
        modelId: agent.voiceConfig.modelId,
        voiceId: agent.voiceConfig.voiceId,
      };
    }
  }

  // Fallback: first available provider, deterministic voice
  if (availableProviders.length > 0) {
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
 * For custom providers, reads from ttsProvidersConfig.customVoices.
 */
export function getServerVoiceList(
  providerId: TTSProviderId,
  ttsProvidersConfig?: Record<string, Record<string, unknown>>,
): string[] {
  if (providerId === 'browser-native-tts') return [];
  if (isCustomTTSProvider(providerId) && ttsProvidersConfig) {
    const customVoices = ttsProvidersConfig[providerId]?.customVoices as
      | Array<{ id: string }>
      | undefined;
    return customVoices?.map((v) => v.id) || [];
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (!provider) return [];
  return provider.voices.map((v) => v.id);
}

export interface ModelVoiceGroup {
  modelId: string;
  modelName: string;
  voices: Array<{ id: string; name: string }>;
}

export interface ProviderWithVoices {
  providerId: TTSProviderId;
  providerName: string;
  voices: Array<{ id: string; name: string }>; // keep for backward compat
  modelGroups: ModelVoiceGroup[]; // voices grouped by model
}

/**
 * Get all available providers and their voices for the voice picker UI.
 * A provider is available if it has an API key or is server-configured.
 * Custom providers are available if they have voices configured.
 * Browser-native-tts is excluded (no static voice list).
 */
export function getAvailableProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    {
      apiKey?: string;
      enabled?: boolean;
      isServerConfigured?: boolean;
      modelId?: string;
      customName?: string;
      customVoices?: Array<{ id: string; name: string }>;
    }
  >,
): ProviderWithVoices[] {
  const result: ProviderWithVoices[] = [];

  // Built-in providers
  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;
    if (config.voices.length === 0) continue;

    const providerConfig = ttsProvidersConfig[providerId];
    const hasApiKey = providerConfig?.apiKey && providerConfig.apiKey.trim().length > 0;
    const isServerConfigured = providerConfig?.isServerConfigured === true;

    if (hasApiKey || isServerConfigured) {
      const allVoices = config.voices.map((v) => ({ id: v.id, name: v.name }));

      // Build model groups
      const modelGroups: ModelVoiceGroup[] = [];
      if (config.models.length > 0) {
        for (const model of config.models) {
          const compatibleVoices = config.voices
            .filter((v) => !v.compatibleModels || v.compatibleModels.includes(model.id))
            .map((v) => ({ id: v.id, name: v.name }));
          modelGroups.push({
            modelId: model.id,
            modelName: model.name,
            voices: compatibleVoices,
          });
        }
      } else {
        modelGroups.push({
          modelId: '',
          modelName: config.name,
          voices: allVoices,
        });
      }

      result.push({
        providerId,
        providerName: config.name,
        voices: allVoices,
        modelGroups,
      });
    }
  }

  // Custom providers
  for (const [id, providerConfig] of Object.entries(ttsProvidersConfig)) {
    if (!isCustomTTSProvider(id)) continue;
    const customVoices = providerConfig.customVoices || [];
    if (customVoices.length === 0) continue;

    const providerId = id as TTSProviderId;
    const providerName = providerConfig.customName || id;
    const voices = customVoices.map((v) => ({ id: v.id, name: v.name }));

    result.push({
      providerId,
      providerName,
      voices,
      modelGroups: [{ modelId: '', modelName: providerName, voices }],
    });
  }

  return result;
}

/**
 * Find a voice display name across all providers.
 */
export function findVoiceDisplayName(
  providerId: TTSProviderId,
  voiceId: string,
  ttsProvidersConfig?: Record<string, Record<string, unknown>>,
): string {
  if (isCustomTTSProvider(providerId) && ttsProvidersConfig) {
    const customVoices = ttsProvidersConfig[providerId]?.customVoices as
      | Array<{ id: string; name: string }>
      | undefined;
    const voice = customVoices?.find((v) => v.id === voiceId);
    return voice?.name ?? voiceId;
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (!provider) return voiceId;
  const voice = provider.voices.find((v) => v.id === voiceId);
  return voice?.name ?? voiceId;
}
