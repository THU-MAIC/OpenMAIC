import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { generateTTS, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import { serverMediaConnection } from '@/lib/server/model-config/media';
import { resolveTTSModel, slotTTSModel } from '@/lib/server/provider-config';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: string[];
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
  const voice =
    bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || '';
  const model =
    connection.modelId ?? (DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '');
  // A configured slot's own model; the legacy server pins apply only to a default.
  const modelId =
    (connection.origin === 'configuration'
      ? slotTTSModel(providerId, model, voice)
      : resolveTTSModel(providerId, model, voice)) || '';
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
      const audio = await generateTTS(
        {
          providerId,
          modelId,
          apiKey,
          baseUrl: connection.baseUrl,
          managed: connection.managed,
          publicOnly: connection.userEndpoint,
          voice,
          speed: speech.speed,
          signal: input.signal,
        },
        speech.text,
      );
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
      generated += 1;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // A hung provider must fail the tool call with the retryable timeout
      // error instead of degrading into a per-action failure: the remaining
      // actions would hit the same hung upstream and the session would wedge.
      if (error instanceof TTSRequestTimeoutError) throw error;
      failed.push(action.id);
    }
  }
  return {
    available: true,
    changed: generated > 0,
    generated,
    skipped,
    failed,
  };
}
