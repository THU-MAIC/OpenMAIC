import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import { QwenVoiceCloneError } from '@/lib/audio/qwen-voice-clone';
import { voiceAfterUnavailableBinding } from '@/lib/audio/voice-resolver';
import {
  voiceCloneRecoveryReason,
  type VoiceCloneRecoveryReason,
} from '@/lib/audio/voice-clone-recovery';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import { configuredDefaultVoice } from '@/lib/audio/provider-default-voice';
import { authorizeMediaModel } from '@/lib/server/model-config/media';
import {
  DEFAULT_TTS_MODELS,
  DEFAULT_TTS_VOICES,
  TTS_PROVIDERS,
  isQwenCloneVoice,
} from '@/lib/audio/constants';
import { generateTTS, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import { adapterOptions } from '@/lib/server/model-config/adapter-options';
import { serverMediaConnection } from '@/lib/server/model-config/media';
import { resolveTTSModel, slotTTSModel } from '@/lib/server/provider-config';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';

/**
 * The last successfully persisted synthesis voice (or selected voice if none succeeded).
 * Existing audio is unchanged. Narration uses the roster teacher's binding
 * when it belongs to the tts slot's provider, and uses
 * the provider default otherwise; saying which is what lets the agent see that
 * a roster change did (or did not) reach the audio.
 */
export interface SceneTtsVoice {
  /** `providerId::voiceId`; the voice part is empty when the provider has no default. */
  binding: string;
  source: 'roster-teacher' | 'provider-default' | 'recovery-fallback';
  /** Earlier newly generated lines used another voice. */
  mixed?: true;
  /** The teacher whose binding applied, or who was passed over for a fallback. */
  teacher?: string;
  /** Why a teacher binding did not apply. */
  fallbackReason?: 'no-teacher' | 'teacher-unbound' | 'teacher-bound-to-other-provider';
}

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: string[];
  recovery?: {
    reason: VoiceCloneRecoveryReason;
    status: 'fallback' | 'failed';
    message: string;
    voiceId?: string;
    errorCode?: string;
  };
  voice?: SceneTtsVoice;
}

export interface SceneTtsInput {
  scene: Scene;
  force: boolean;
  roster?: readonly GeneratedAgentConfig[] | null;
  signal?: AbortSignal;
  /** The run's owner, whose tts slot applies. */
  ownerId?: string;
}

function narratorVoice(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig)?.voiceConfig;
}

function voiceReport(
  roster: SceneTtsInput['roster'],
  providerId: string,
  voice: string,
  recovery?: SceneTtsSummary['recovery'],
): SceneTtsVoice {
  // The same teacher narratorVoice picks: the first bound one, else the first.
  const teacher =
    roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig) ??
    roster?.find((agent) => agent.role === 'teacher');
  const bound = teacher?.voiceConfig;
  const binding = `${providerId}::${voice}`;
  if (recovery?.status === 'fallback') {
    return {
      binding,
      source: 'recovery-fallback',
      ...(teacher?.name ? { teacher: teacher.name } : {}),
    };
  }
  if (bound?.providerId === providerId && bound.voiceId) {
    return { binding, source: 'roster-teacher', teacher: teacher!.name };
  }
  return {
    binding,
    source: 'provider-default',
    ...(teacher?.name ? { teacher: teacher.name } : {}),
    fallbackReason: !teacher
      ? 'no-teacher'
      : bound?.providerId && bound.voiceId
        ? 'teacher-bound-to-other-provider'
        : 'teacher-unbound',
  };
}

/** One line for a tool result: which voice the synthesized lines used, and why. */
export function describeNarrationVoice(voice: SceneTtsVoice): string {
  const mixed = voice.mixed ? ' Earlier generated lines used a different voice.' : '';
  if (voice.source === 'recovery-fallback') {
    return `Voice: ${voice.binding} (temporary fallback for an unavailable saved voice).${mixed}`;
  }
  if (voice.source === 'roster-teacher') {
    return `Voice: ${voice.binding} (teacher "${voice.teacher}"'s roster binding).${mixed}`;
  }
  const why =
    voice.fallbackReason === 'no-teacher'
      ? 'the roster has no teacher'
      : voice.fallbackReason === 'teacher-bound-to-other-provider'
        ? `teacher "${voice.teacher}" is bound to a voice of another provider`
        : `teacher "${voice.teacher}" has no voice bound`;
  return `Voice: ${voice.binding} (provider default; ${why}).${mixed}`;
}

function audioMime(format: string) {
  return format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
}

/** Server-configured narration synthesis into the stage's classroom-media path. */
export async function synthesizeSceneNarration(input: SceneTtsInput): Promise<SceneTtsSummary> {
  // The tts slot decides the provider; the narrator's bound voice applies
  // only when it belongs to that provider.
  const connection = await serverMediaConnection('tts', input.ownerId);
  if (
    !connection ||
    connection === 'off' ||
    connection.providerId === BROWSER_NATIVE_TTS_PROVIDER_ID
  ) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const providerId = connection.providerId as TTSProviderId;
  const bound = narratorVoice(input.roster);
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const apiKey = connection.apiKey ?? '';
  if (provider?.requiresApiKey && !apiKey) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const defaultVoice =
    configuredDefaultVoice(connection.options, connection.voices) ||
    DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] ||
    '';
  let voice = bound?.providerId === providerId && bound.voiceId ? bound.voiceId : defaultVoice;
  const model =
    connection.modelId ?? (DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '');
  // A configured slot's own model; the legacy server pins apply only to a default.
  const authorizedModel = (voiceId: string) => {
    const resolved =
      (connection.origin === 'configuration'
        ? slotTTSModel(providerId, model, voiceId, connection.voices)
        : resolveTTSModel(providerId, model, voiceId, connection.voices)) || '';
    authorizeMediaModel(connection, 'tts', resolved);
    return resolved;
  };
  let recovery: SceneTtsSummary['recovery'];
  const propagate = (error: unknown) => {
    if (
      input.signal?.aborted ||
      error instanceof TTSRequestTimeoutError ||
      (error instanceof QwenVoiceCloneError && error.code === 'QWEN_VC_TIMEOUT') ||
      error instanceof ModelAuthorizationError ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
  };
  const errorCode = (error: unknown) => {
    if (!error || typeof error !== 'object') return undefined;
    const code =
      (error as { code?: unknown; errorCode?: unknown }).errorCode ??
      (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  };
  const generate = (speech: SpeechAction) => {
    getVoiceRegistrationAdapter(providerId)?.assertVoiceCompatible?.(voice, connection.voices);
    return generateTTS(
      {
        providerId,
        modelId: authorizedModel(voice),
        apiKey,
        baseUrl: connection.baseUrl,
        managed: connection.managed,
        publicOnly: connection.userEndpoint,
        voice,
        ...(connection.voices ? { voices: connection.voices } : {}),
        speed: speech.speed,
        providerOptions: {
          ...adapterOptions(connection),
          ...(providerId === 'qwen-tts'
            ? { qwenVoiceClone: isQwenCloneVoice(voice, connection.voices) }
            : {}),
        },
        signal: input.signal,
      },
      speech.text,
    );
  };
  const selectedVoice = voiceReport(input.roster, providerId, voice);
  let generatedVoice: SceneTtsVoice | undefined;
  let generated = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const action of input.scene.actions ?? []) {
    if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
    const speech = action as SpeechAction;
    if (!input.force && speech.audioId) {
      skipped += 1;
      continue;
    }
    if (input.signal?.aborted) throw new Error('aborted');
    try {
      if (recovery?.status === 'failed') {
        failed.push(action.id);
        continue;
      }
      let audio;
      try {
        audio = await generate(speech);
      } catch (error) {
        propagate(error);
        const reason = voiceCloneRecoveryReason(error);
        if (
          recovery ||
          !reason ||
          bound?.providerId !== providerId ||
          bound.voiceId !== voice ||
          providerId !== 'qwen-tts' ||
          !isQwenCloneVoice(voice, connection.voices)
        )
          throw error;
        recovery = {
          reason,
          status: 'failed',
          errorCode: errorCode(error),
          message:
            'The saved voice is unavailable. Please re-upload reference audio to clone it again.',
        };
        const candidate = voiceAfterUnavailableBinding(
          { providerId, voiceId: voice },
          { providerId, voiceId: defaultVoice },
          { [providerId]: { enabled: true, apiKey, modelId: model, voices: connection.voices } },
          reason,
        );
        if (!candidate) throw error;
        voice = candidate.voiceId;
        audio = await generate(speech);
        recovery = {
          reason,
          status: 'fallback',
          voiceId: voice,
          message:
            'Using a temporary narration voice. Please re-upload reference audio to clone the saved voice again.',
        };
      }
      if (input.signal?.aborted) throw new Error('aborted');
      // The persisted reference is the RELATIVE classroom-media path (the
      // agent runtime has no request origin; relative stays valid on any
      // deployment origin — see classroom-media-bytes.ts). The browser's
      // narration consumers (timeline status/preview, playback, exports)
      // resolve a speech line through the legacy (audioId, audioUrl) pair:
      // `audioId` alone is never resolvable to bytes client-side, while a
      // present `audioUrl` marks the line voiced and is what the audio
      // element / fetch fallback plays. Stamp the same relative path on both.
      const audioId = await persistClassroomMediaBytes({
        stageId: input.scene.stageId,
        bytes: Buffer.from(audio.audio),
        mime: audioMime(audio.format),
        prefix: `tts-${action.id}`,
        signal: input.signal,
      });
      speech.audioId = audioId;
      (speech as LegacySpeechAction).audioUrl = audioId;
      const currentVoice = voiceReport(input.roster, providerId, voice, recovery);
      generatedVoice = {
        ...currentVoice,
        ...(generatedVoice &&
        (generatedVoice.mixed || generatedVoice.binding !== currentVoice.binding)
          ? { mixed: true as const }
          : {}),
      };
      generated += 1;
    } catch (error) {
      propagate(error);
      if (recovery?.status === 'failed')
        recovery.errorCode = errorCode(error) ?? recovery.errorCode;
      failed.push(action.id);
    }
  }
  return {
    available: true,
    changed: generated > 0,
    generated,
    skipped,
    failed,
    ...(recovery ? { recovery } : {}),
    voice: generatedVoice ?? selectedVoice,
  };
}
