/**
 * Which voice a run narrates with, decided as the browser decides it for the
 * `tts` slot (`lib/audio/tts-selection.ts`, `generateAndStoreTTS`): the slot
 * names the provider and model; the learner's voice applies when it was picked
 * for that provider and its model can speak it; a generated teacher's bound
 * voice wins over both while its provider is the slot's.
 */
import {
  DEFAULT_TTS_VOICES,
  TTS_PROVIDERS,
  isQwenCloneVoice,
  resolveTTSModelForVoice,
  voiceServesModel,
} from '@/lib/audio/constants';
import type { BuiltInTTSProviderId, TTSProviderId } from '@/lib/audio/types';
import {
  getEnabledProvidersWithVoices,
  resolveNarratorVoiceBinding,
  resolveNarratorVoiceForGeneration,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import type { MediaConnection } from '@/lib/server/model-config/media';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

import type { GenerationRunInput } from './types';

/** The `tts` slot as a run narrates through it. */
export interface RunNarrationTarget {
  connection: MediaConnection;
  providerId: TTSProviderId;
  /** The slot's model, else the provider's default. */
  modelId?: string;
}

/** The per-provider map the voice helpers read: the slot's provider, available through the server. */
function providersConfig(target: RunNarrationTarget) {
  return {
    [target.providerId]: {
      apiKey: '',
      baseUrl: '',
      enabled: true,
      isServerConfigured: true,
      ...(target.modelId ? { modelId: target.modelId } : {}),
      ...(target.connection.options ? { providerOptions: { ...target.connection.options } } : {}),
    },
  };
}

/** A provider's default voice, or the first catalogue voice its model can speak. */
function defaultVoiceFor(providerId: string, modelId?: string): string {
  const preferred = DEFAULT_TTS_VOICES[providerId as BuiltInTTSProviderId] || 'default';
  if (voiceServesModel(providerId, preferred, modelId)) return preferred;
  const voices = TTS_PROVIDERS[providerId as BuiltInTTSProviderId]?.voices ?? [];
  return voices.find((voice) => voiceServesModel(providerId, voice.id, modelId))?.id ?? preferred;
}

/** The learner's voice for the slot's provider, else the provider's default. */
export function slotVoice(
  target: RunNarrationTarget,
  preference: GenerationRunInput['voice'],
): { voice: string; speed: number } {
  const usable =
    preference?.providerId === target.providerId &&
    !!preference.voiceId &&
    voiceServesModel(target.providerId, preference.voiceId, target.modelId);
  return {
    voice: usable ? preference!.voiceId : defaultVoiceFor(target.providerId, target.modelId),
    speed: preference?.speed ?? 1,
  };
}

/** The voices the agent-profiles step may bind agents to, as the browser advertises them. */
export function advertisedVoices(target: RunNarrationTarget) {
  return getEnabledProvidersWithVoices(providersConfig(target)).flatMap((provider) =>
    provider.voices.map((voice) => {
      const cloneModelGroup =
        provider.providerId === 'qwen-tts' && isQwenCloneVoice(voice.id)
          ? provider.modelGroups.find((group) =>
              group.voices.some((groupVoice) => groupVoice.id === voice.id),
            )
          : undefined;
      const modelId = cloneModelGroup
        ? resolveTTSModelForVoice(provider.providerId, voice.id, cloneModelGroup.modelId)
        : undefined;
      return {
        providerId: provider.providerId,
        ...(modelId ? { modelId } : {}),
        voiceId: voice.id,
        voiceName: voice.name,
        voiceLanguage: voice.language,
      };
    }),
  );
}

/** The narrator voice the teacher is pinned to at agent generation. */
export function narratorVoiceForGeneration(
  target: RunNarrationTarget,
  preference: GenerationRunInput['voice'],
): ResolvedVoice | undefined {
  const { voice } = slotVoice(target, preference);
  return resolveNarratorVoiceForGeneration(
    target.providerId,
    voice,
    providersConfig(target)[target.providerId],
  );
}

/** The voice one narration clip is synthesized with. */
export function clipVoice(
  target: RunNarrationTarget,
  preference: GenerationRunInput['voice'],
  roster: readonly GeneratedAgentConfig[] | undefined,
): ResolvedVoice {
  const teacher =
    roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig) ??
    roster?.find((agent) => agent.role === 'teacher');
  const bound = teacher?.voiceConfig;
  const { voice } = slotVoice(target, preference);
  return resolveNarratorVoiceBinding(
    bound
      ? {
          providerId: bound.providerId as TTSProviderId,
          voiceId: bound.voiceId,
          ...(bound.modelId ? { modelId: bound.modelId } : {}),
        }
      : undefined,
    {
      providerId: target.providerId,
      ...(target.connection.modelId ? { modelId: target.connection.modelId } : {}),
      voiceId: voice,
    },
    providersConfig(target),
  );
}
