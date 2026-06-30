import type { TTSProviderId } from '@/lib/audio/types';
import { isCustomTTSProvider } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  BROWSER_NATIVE_TTS_PROVIDER_ID,
  isTTSProviderEnabled,
  type TTSEnablementConfig,
} from '@/lib/audio/provider-enablement';
import {
  VOXCPM_TTS_PROVIDER_ID,
  getVoxCPMProfileVoiceId,
  normalizeVoxCPMBackend,
  voxCPMBackendSupportsReferenceAudio,
} from '@/lib/audio/voxcpm';

export interface ResolvedVoice {
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
}

/** A user-picked voice for one agent (same shape as AgentConfig.voiceConfig). */
export interface AgentVoiceOverride {
  providerId: TTSProviderId;
  modelId?: string;
  voiceId: string;
}

/** Persisted per-agent voice picks, keyed by agent id (settings store). */
export type AgentVoiceOverrides = Record<string, AgentVoiceOverride>;

/**
 * Resolve the TTS provider + voice for an agent, choosing only among ENABLED
 * providers (`enabledProviders` is the output of getEnabledProvidersWithVoices,
 * which already excludes disabled/unconfigured providers and browser-native).
 *
 * 1. If the user picked a voice for this agent (persisted `overrides`, keyed by
 *    agent id) whose provider is in `enabledProviders` (and the voiceId is
 *    known), use it; the agent's own voiceConfig is validated the same way next.
 * 2. Otherwise, deterministically pick the first provider in the given list by
 *    index. Whether browser-native can be picked depends on the caller's list:
 *    getEnabledProvidersWithVoices excludes it, getSelectableProvidersWithVoices
 *    appends it LAST, so it is only the index target when it is the sole enabled
 *    provider (i.e. the user opted into browser-native only).
 * 3. If the list is empty, return null — the caller must skip TTS rather than
 *    silently falling back to browser-native (#665 symptom 4).
 */
export function resolveAgentVoice(
  agent: AgentConfig,
  agentIndex: number,
  enabledProviders: ProviderWithVoices[],
  overrides?: AgentVoiceOverrides,
): ResolvedVoice | null {
  // Candidates in priority order: the user's persisted per-agent override
  // (settings store — survives reloads; registry records for default/generated
  // agents do not), then the agent's own voiceConfig. Each is honored only
  // when its provider is still enabled and the voice is known.
  const candidates = [overrides?.[agent.id], agent.voiceConfig];
  for (const choice of candidates) {
    if (!choice) continue;
    // Browser-native voices are dynamic (not in static registry); it is a
    // first-class provider only when present in the enabled list.
    if (choice.providerId === 'browser-native-tts') {
      if (enabledProviders.some((p) => p.providerId === 'browser-native-tts')) {
        return { providerId: choice.providerId, modelId: choice.modelId, voiceId: choice.voiceId };
      }
      continue;
    }
    const fromEnabled = enabledProviders.find((p) => p.providerId === choice.providerId);
    if (!fromEnabled) continue;
    const list = getServerVoiceList(choice.providerId);
    const allVoiceIds = new Set([...list, ...fromEnabled.voices.map((v) => v.id)]);
    if (allVoiceIds.has(choice.voiceId)) {
      return { providerId: choice.providerId, modelId: choice.modelId, voiceId: choice.voiceId };
    }
  }

  // Fallback: deterministic pick among enabled providers (canonical order).
  if (enabledProviders.length > 0) {
    const first = enabledProviders[0];
    if (first.voices.length > 0) {
      return {
        providerId: first.providerId,
        voiceId: first.voices[agentIndex % first.voices.length].id,
      };
    }
  }

  // Nothing enabled — no TTS for this agent.
  return null;
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
  voices: Array<{ id: string; name: string; language?: string }>;
}

export interface ProviderWithVoices {
  providerId: TTSProviderId;
  providerName: string;
  voices: Array<{ id: string; name: string; language?: string }>;
  modelGroups: ModelVoiceGroup[]; // voices grouped by model
}

/**
 * Get all ENABLED providers and their voices for the voice picker UI and for
 * deterministic auto-assignment.
 *
 * A provider is included only when {@link isTTSProviderEnabled} holds:
 * configured (server-managed, client API key, or explicit base URL — the
 * registry `defaultBaseUrl` no longer counts), not server-disabled, and the
 * user's per-provider `enabled` flag is not false (#665). Browser-native is
 * excluded here (no static voice list); the agent UI injects its dynamic voices
 * separately, gated on the same predicate.
 */
export function getEnabledProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    TTSEnablementConfig & {
      modelId?: string;
      providerOptions?: Record<string, unknown>;
      customName?: string;
    }
  >,
  voxcpmProfiles: Array<{ id: string; name: string; kind?: string }> = [],
): ProviderWithVoices[] {
  const result: ProviderWithVoices[] = [];

  // Built-in providers
  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;
    if (config.voices.length === 0) continue;

    const providerConfig = ttsProvidersConfig[providerId];
    if (!isTTSProviderEnabled(providerId, providerConfig)) continue;

    const visibleVoxCPMProfiles =
      providerId === VOXCPM_TTS_PROVIDER_ID
        ? voxcpmProfiles.filter((profile) => {
            const backend = normalizeVoxCPMBackend(providerConfig?.providerOptions?.backend);
            return profile.kind !== 'clone' || voxCPMBackendSupportsReferenceAudio(backend);
          })
        : [];

    {
      const allVoices = [
        ...config.voices.map((v) => ({
          id: v.id,
          name: v.name,
          language: v.language,
        })),
        ...(providerId === VOXCPM_TTS_PROVIDER_ID
          ? visibleVoxCPMProfiles.map((profile) => ({
              id: getVoxCPMProfileVoiceId(profile.id),
              name: profile.name,
              language: 'auto',
            }))
          : []),
      ];

      // Build model groups
      const modelGroups: ModelVoiceGroup[] = [];
      if (config.models.length > 0) {
        for (const model of config.models) {
          const compatibleVoices = config.voices
            .filter((v) => !v.compatibleModels || v.compatibleModels.includes(model.id))
            .map((v) => ({ id: v.id, name: v.name, language: v.language }));
          if (providerId === VOXCPM_TTS_PROVIDER_ID) {
            compatibleVoices.push(
              ...visibleVoxCPMProfiles.map((profile) => ({
                id: getVoxCPMProfileVoiceId(profile.id),
                name: profile.name,
                language: 'auto',
              })),
            );
          }
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
    if (!isTTSProviderEnabled(id as TTSProviderId, providerConfig)) continue;

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

/** A browser SpeechSynthesisVoice, narrowed to what the picker needs. */
export interface BrowserVoiceLike {
  voiceURI: string;
  name: string;
}

/**
 * The single source of truth for "which provider+voice options are selectable
 * on the client" — used by BOTH the voice picker (AgentBar) and discussion TTS
 * resolution, so the teacher and student agents never diverge (#665).
 *
 * = enabled server/custom providers (getEnabledProvidersWithVoices) PLUS
 * browser-native when the user has enabled it and the browser exposes voices
 * (browser-native voices are dynamic, so they can only be supplied at the
 * client layer; server-side generation uses getEnabledProvidersWithVoices).
 */
export function getSelectableProvidersWithVoices(
  ttsProvidersConfig: Record<
    string,
    TTSEnablementConfig & {
      modelId?: string;
      providerOptions?: Record<string, unknown>;
      customName?: string;
    }
  >,
  voxcpmProfiles: Array<{ id: string; name: string; kind?: string }> = [],
  browserVoices: BrowserVoiceLike[] = [],
): ProviderWithVoices[] {
  const providers = getEnabledProvidersWithVoices(ttsProvidersConfig, voxcpmProfiles);
  if (
    isTTSProviderEnabled(
      BROWSER_NATIVE_TTS_PROVIDER_ID,
      ttsProvidersConfig[BROWSER_NATIVE_TTS_PROVIDER_ID],
    ) &&
    browserVoices.length > 0
  ) {
    const voices = browserVoices.map((v) => ({ id: v.voiceURI, name: v.name }));
    providers.push({
      providerId: BROWSER_NATIVE_TTS_PROVIDER_ID,
      providerName: 'Browser Native',
      voices,
      modelGroups: [{ modelId: '', modelName: 'Browser Native', voices }],
    });
  }
  return providers;
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
