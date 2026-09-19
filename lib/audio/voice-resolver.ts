import type { TTSProviderId } from '@/lib/audio/types';
import { isCustomTTSProvider } from '@/lib/audio/types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  isQwenCatalogVoice,
  isQwenCloneVoice,
  isQwenVoiceCloneModel,
  resolveTTSModelForVoice,
  TTS_PROVIDERS,
} from '@/lib/audio/constants';
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

type ProviderConfigMap = Record<string, TTSEnablementConfig | undefined>;

/** Prefer a persisted narrator binding, retaining the global fallback when it is unusable. */
export function resolveNarratorVoiceBinding(
  bound: AgentConfig['voiceConfig'] | undefined,
  globalVoice: ResolvedVoice,
  providerConfigs: ProviderConfigMap,
): ResolvedVoice {
  if (
    bound &&
    bound.voiceId.trim() &&
    isTTSProviderEnabled(bound.providerId, providerConfigs[bound.providerId])
  ) {
    // Qwen clone IDs are account-scoped but self-contained: local IndexedDB is
    // not an authority. Catalog voices remain validated against the catalog.
    return {
      providerId: bound.providerId,
      modelId: resolveTTSModelForVoice(bound.providerId, bound.voiceId, bound.modelId),
      voiceId: bound.voiceId,
    };
  }
  return {
    ...globalVoice,
    modelId: resolveTTSModelForVoice(
      globalVoice.providerId,
      globalVoice.voiceId,
      globalVoice.modelId,
    ),
  };
}

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
    if (choice.providerId === 'qwen-tts') {
      const catalogVoice = isQwenCatalogVoice(choice.voiceId);
      if (catalogVoice || choice.voiceId.trim()) {
        return {
          providerId: choice.providerId,
          modelId: resolveTTSModelForVoice(choice.providerId, choice.voiceId, choice.modelId),
          voiceId: choice.voiceId,
        };
      }
      continue;
    }
    const list = getServerVoiceList(choice.providerId);
    const allVoiceIds = new Set([...list, ...fromEnabled.voices.map((v) => v.id)]);
    const matchingModelGroup = choice.modelId
      ? fromEnabled.modelGroups.find((group) => group.modelId === choice.modelId)
      : undefined;
    const provider = TTS_PROVIDERS[choice.providerId as keyof typeof TTS_PROVIDERS];
    const declaredVoice = provider?.voices.find((voice) => voice.id === choice.voiceId);
    const defaultModelGroup = provider
      ? fromEnabled.modelGroups.find((group) => group.modelId === provider.defaultModelId)
      : undefined;
    const staleModelCanUseDefault = declaredVoice?.compatibleModels
      ? defaultModelGroup?.voices.some((voice) => voice.id === choice.voiceId) === true
      : true;
    // Without compatibility metadata, legacy providers are assumed to accept
    // their known voices on the configured default model, preserving prior behavior.
    const modelCompatible =
      matchingModelGroup?.voices.some((voice) => voice.id === choice.voiceId) ??
      staleModelCanUseDefault;
    if (allVoiceIds.has(choice.voiceId) && modelCompatible) {
      return {
        providerId: choice.providerId,
        ...(matchingModelGroup ? { modelId: choice.modelId } : {}),
        voiceId: choice.voiceId,
      };
    }
  }

  // Fallback: deterministic pick among enabled providers (canonical order).
  return resolveDeterministicFallbackVoice(enabledProviders, agentIndex);
}

/**
 * The deterministic last-resort voice pick shared by `resolveAgentVoice` and
 * the narrator fallback: the first ENABLED provider in canonical order and one
 * of its catalog voices (Qwen clones are excluded — only catalog voices are
 * guaranteed usable without account state). Returns null when no enabled
 * provider can serve a voice.
 */
export function resolveDeterministicFallbackVoice(
  enabledProviders: ProviderWithVoices[],
  index: number,
): ResolvedVoice | null {
  if (enabledProviders.length === 0) return null;
  const first = enabledProviders[0];
  const fallbackVoices =
    first.providerId === 'qwen-tts'
      ? first.voices.filter((voice) => isQwenCatalogVoice(voice.id))
      : first.voices;
  if (fallbackVoices.length === 0) return null;
  return {
    providerId: first.providerId,
    voiceId: fallbackVoices[index % fallbackVoices.length].id,
  };
}

/**
 * The narrator (teacher) voice to pin at agent-profile generation time.
 *
 * Returns undefined when the global voice is unusable — no voice selected, or
 * its provider disabled/unconfigured — so the teacher is never pinned to a
 * voice the fallback machinery cannot serve. The advertised list contains only
 * enabled providers, so an unpinned narrator lets the LLM pick a working voice;
 * and because the pin makes bound == global, pinning an unusable voice would
 * defeat `resolveNarratorVoiceBinding`'s enabled-provider fallback at narration.
 */
export function resolveNarratorVoiceForGeneration(
  providerId: TTSProviderId,
  voiceId: string | undefined,
  providerConfig: (TTSEnablementConfig & { modelId?: string }) | undefined,
): ResolvedVoice | undefined {
  const trimmed = voiceId?.trim();
  if (!providerId || !trimmed) return undefined;
  if (!isTTSProviderEnabled(providerId, providerConfig)) return undefined;
  const modelId =
    providerId === 'qwen-tts' && isQwenCloneVoice(trimmed)
      ? resolveTTSModelForVoice(providerId, trimmed, providerConfig?.modelId)
      : undefined;
  return { providerId, voiceId: trimmed, ...(modelId ? { modelId } : {}) };
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

export interface UserVoiceProfile {
  id: string;
  providerId?: string;
  name: string;
  kind?: string;
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
  voiceProfiles: UserVoiceProfile[] = [],
): ProviderWithVoices[] {
  const result: ProviderWithVoices[] = [];

  // Built-in providers
  for (const [id, config] of Object.entries(TTS_PROVIDERS)) {
    const providerId = id as TTSProviderId;
    if (providerId === 'browser-native-tts') continue;
    if (config.voices.length === 0) continue;

    const providerConfig = ttsProvidersConfig[providerId];
    if (!isTTSProviderEnabled(providerId, providerConfig)) continue;

    const providerProfiles = voiceProfiles.filter(
      (profile) =>
        (profile.providerId || VOXCPM_TTS_PROVIDER_ID) === providerId && profile.kind === 'clone',
    );
    const visibleVoxCPMProfiles =
      providerId === VOXCPM_TTS_PROVIDER_ID
        ? voiceProfiles.filter((profile) => {
            if ((profile.providerId || VOXCPM_TTS_PROVIDER_ID) !== providerId) return false;
            const backend = normalizeVoxCPMBackend(providerConfig?.providerOptions?.backend);
            return profile.kind !== 'clone' || voxCPMBackendSupportsReferenceAudio(backend);
          })
        : [];
    const userVoices =
      providerId === VOXCPM_TTS_PROVIDER_ID
        ? visibleVoxCPMProfiles.map((profile) => ({
            id: getVoxCPMProfileVoiceId(profile.id),
            name: profile.name,
            language: 'auto',
          }))
        : providerProfiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            language: 'auto',
          }));

    {
      const allVoices = [
        ...config.voices.map((v) => ({
          id: v.id,
          name: v.name,
          language: v.language,
        })),
        ...userVoices,
      ];

      // Build model groups
      const modelGroups: ModelVoiceGroup[] = [];
      if (config.models.length > 0) {
        for (const model of config.models) {
          const compatibleVoices =
            providerId === 'qwen-tts' && isQwenVoiceCloneModel(model.id)
              ? []
              : config.voices
                  .filter((v) => !v.compatibleModels || v.compatibleModels.includes(model.id))
                  .map((v) => ({ id: v.id, name: v.name, language: v.language }));
          if (providerId === VOXCPM_TTS_PROVIDER_ID) {
            compatibleVoices.push(...userVoices);
          } else if (providerId !== 'qwen-tts' || isQwenVoiceCloneModel(model.id)) {
            compatibleVoices.push(...userVoices);
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
  voiceProfiles: UserVoiceProfile[] = [],
  browserVoices: BrowserVoiceLike[] = [],
): ProviderWithVoices[] {
  const providers = getEnabledProvidersWithVoices(ttsProvidersConfig, voiceProfiles);
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
  // Object.hasOwn, not a bare index: a prototype-chain key ('toString', …)
  // would resolve to a function and crash the `.voices` access below.
  const provider = Object.hasOwn(TTS_PROVIDERS, providerId)
    ? TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]
    : undefined;
  if (!provider) return voiceId;
  const voice = provider.voices.find((v) => v.id === voiceId);
  return voice?.name ?? voiceId;
}
