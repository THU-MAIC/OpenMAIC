/**
 * Speech synthesis as the workspace's model settings define it: the `tts`
 * slot names one provider (and model); the browser only keeps which voice and
 * speed the user prefers. The voice helpers (voice-resolver, provider-enablement)
 * read a per-provider config map, so the slot's provider is presented to them
 * as that map: the one provider, available through the server, and every
 * other provider unavailable.
 */
import { DEFAULT_TTS_VOICES, TTS_PROVIDERS, voiceServesModel } from '@/lib/audio/constants';
import { normalizeVoxCPMBackend } from '@/lib/audio/voxcpm';
import type { BuiltInTTSProviderId, TTSProviderId } from '@/lib/audio/types';
import {
  currentModelCapabilities,
  requireModelCapabilities,
  type EffectiveTarget,
  type ModelCapabilities,
} from '@/lib/model-settings/capabilities';
import { useSettingsStore } from '@/lib/store/settings';

/** Browser speech synthesis (the same id as provider-enablement's). */
const BROWSER_NATIVE_TTS_PROVIDER_ID = 'browser-native-tts';

export interface SlotTTSProviderConfig {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  isServerConfigured?: boolean;
  modelId?: string;
  /** The provider's non-secret options (a VoxCPM `backend`, say), as the server configures them. */
  providerOptions?: Record<string, string | number | boolean>;
}

export type SlotTTSProvidersConfig = Record<string, SlotTTSProviderConfig>;

/**
 * The model the `tts` slot speaks with: its own, else the provider's default
 * (a provider-only reference). Voices are offered and resolved against it.
 */
export function slotTTSModel(target: EffectiveTarget): string | undefined {
  return (
    target.modelId ||
    TTS_PROVIDERS[target.registryId as BuiltInTTSProviderId]?.defaultModelId ||
    undefined
  );
}

/** The per-provider map the voice helpers read, for the provider the `tts` slot resolves to. */
export function slotTTSProvidersConfig(target: EffectiveTarget | null): SlotTTSProvidersConfig {
  const map: SlotTTSProvidersConfig = {
    // Browser speech is always "configured"; it is off unless it is the slot's.
    [BROWSER_NATIVE_TTS_PROVIDER_ID]: { apiKey: '', baseUrl: '', enabled: false },
  };
  if (target) {
    const modelId = slotTTSModel(target);
    map[target.registryId] = {
      apiKey: '',
      baseUrl: '',
      enabled: true,
      isServerConfigured: target.registryId !== BROWSER_NATIVE_TTS_PROVIDER_ID,
      ...(modelId ? { modelId } : {}),
      ...(target.options ? { providerOptions: { ...target.options } } : {}),
    };
  }
  return map;
}

/**
 * A provider's own default voice, or, when its model cannot speak that one,
 * the first catalogue voice it can.
 */
export function defaultVoiceFor(providerId: string, modelId?: string): string {
  const preferred = DEFAULT_TTS_VOICES[providerId as BuiltInTTSProviderId] || 'default';
  if (voiceServesModel(providerId, preferred, modelId)) return preferred;
  const voices = TTS_PROVIDERS[providerId as BuiltInTTSProviderId]?.voices ?? [];
  return voices.find((voice) => voiceServesModel(providerId, voice.id, modelId))?.id ?? preferred;
}

export interface TTSSelection {
  /** The registry id of the provider the `tts` slot resolves to. */
  providerId: TTSProviderId;
  modelId?: string;
  /** The user's voice when it was picked for this provider, else the provider's default. */
  voice: string;
  speed: number;
  providersConfig: SlotTTSProvidersConfig;
}

/** The user's voice preference and the provider it was picked for. */
export function voicePreference(): { voice: string; providerId: string; speed: number } {
  const { ttsVoice, ttsVoiceProviderId, ttsSpeed } = useSettingsStore.getState();
  return { voice: ttsVoice, providerId: ttsVoiceProviderId, speed: ttsSpeed };
}

/** Speech synthesis for these capabilities, or null when the `tts` slot resolves to nothing. */
export function ttsSelection(
  capabilities: ModelCapabilities = currentModelCapabilities(),
  preference = voicePreference(),
): TTSSelection | null {
  const target = capabilities.tts;
  if (!target) return null;
  const providerId = target.registryId as TTSProviderId;
  const model = slotTTSModel(target);
  // The user's voice applies while the slot names its provider and its model
  // can speak it (a voice kept from another model falls back).
  const usable =
    preference.providerId === providerId &&
    !!preference.voice &&
    voiceServesModel(providerId, preference.voice, model);
  return {
    providerId,
    ...(target.modelId ? { modelId: target.modelId } : {}),
    voice: usable ? preference.voice : defaultVoiceFor(providerId, model),
    speed: preference.speed,
    providersConfig: slotTTSProvidersConfig(target),
  };
}

/** The VoxCPM backend the `tts` slot's provider runs on (its `backend` option; else the default). */
export function slotVoxCPMBackend(target: EffectiveTarget | null | undefined) {
  return normalizeVoxCPMBackend(target?.options?.backend);
}

/** Whether narration is generated on the server (a provider other than browser speech). */
export function serverTTSAvailable(
  capabilities: ModelCapabilities = currentModelCapabilities(),
): boolean {
  return !!capabilities.tts && capabilities.tts.registryId !== BROWSER_NATIVE_TTS_PROVIDER_ID;
}

/**
 * How narration is produced for a generation: on the server, not at all (the
 * tts slot is off or browser speech), or unknown (the model settings could
 * not be read even after another try): the caller stops rather than
 * silently generating without narration.
 */
export async function narrationPlan(): Promise<'server' | 'none' | 'unknown'> {
  const capabilities = await requireModelCapabilities();
  if (!capabilities) return 'unknown';
  return serverTTSAvailable(capabilities) ? 'server' : 'none';
}
