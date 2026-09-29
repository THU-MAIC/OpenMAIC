/**
 * Speech synthesis as the workspace's model settings define it: the `tts`
 * slot names one provider (and model); the browser only keeps which voice and
 * speed the user prefers. The voice helpers (voice-resolver, provider-enablement)
 * read a per-provider config map, so the slot's provider is presented to them
 * as that map: the one provider, available through the server, and every
 * other provider unavailable.
 */
import { DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import type { BuiltInTTSProviderId, TTSProviderId } from '@/lib/audio/types';
import {
  currentModelCapabilities,
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
}

export type SlotTTSProvidersConfig = Record<string, SlotTTSProviderConfig>;

/** The per-provider map the voice helpers read, for the provider the `tts` slot resolves to. */
export function slotTTSProvidersConfig(target: EffectiveTarget | null): SlotTTSProvidersConfig {
  const map: SlotTTSProvidersConfig = {
    // Browser speech is always "configured"; it is off unless it is the slot's.
    [BROWSER_NATIVE_TTS_PROVIDER_ID]: { apiKey: '', baseUrl: '', enabled: false },
  };
  if (target) {
    map[target.registryId] = {
      apiKey: '',
      baseUrl: '',
      enabled: true,
      isServerConfigured: target.registryId !== BROWSER_NATIVE_TTS_PROVIDER_ID,
      ...(target.modelId ? { modelId: target.modelId } : {}),
    };
  }
  return map;
}

/** A provider's own default voice. */
export function defaultVoiceFor(providerId: string): string {
  return DEFAULT_TTS_VOICES[providerId as BuiltInTTSProviderId] || 'default';
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
  return {
    providerId,
    ...(target.modelId ? { modelId: target.modelId } : {}),
    voice:
      preference.providerId === providerId && preference.voice
        ? preference.voice
        : defaultVoiceFor(providerId),
    speed: preference.speed,
    providersConfig: slotTTSProvidersConfig(target),
  };
}

/** Whether narration is generated on the server (a provider other than browser speech). */
export function serverTTSAvailable(
  capabilities: ModelCapabilities = currentModelCapabilities(),
): boolean {
  return !!capabilities.tts && capabilities.tts.registryId !== BROWSER_NATIVE_TTS_PROVIDER_ID;
}
