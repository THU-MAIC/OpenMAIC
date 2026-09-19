import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { generateTTS, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { getDeterministicVoiceId, type VoiceDesign } from '@/lib/audio/voice-design';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import {
  buildAutoVoxCPMVoicePrompt,
  VOXCPM_AUTO_VOICE_ID,
  VOXCPM_TTS_PROVIDER_ID,
} from '@/lib/audio/voxcpm';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
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
}

function enabledProviderIds(): TTSProviderId[] {
  return Object.entries(getServerTTSProviders())
    .filter(([id, config]) => id !== BROWSER_NATIVE_TTS_PROVIDER_ID && !config.disabled)
    .map(([id]) => id as TTSProviderId);
}

function narratorAgent(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig);
}

function effectiveVoiceDesign(agent: ReturnType<typeof narratorAgent>): VoiceDesign | undefined {
  if (agent?.voiceDesign) return agent.voiceDesign;
  const persona = agent?.persona?.trim();
  return persona ? { identity: persona, texture: '', delivery: '' } : undefined;
}

async function resolveVoxCPMAutoVoiceOptions(params: {
  providerId: TTSProviderId;
  voice: string;
  agent: ReturnType<typeof narratorAgent>;
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown> | undefined> {
  if (params.providerId !== VOXCPM_TTS_PROVIDER_ID || params.voice !== VOXCPM_AUTO_VOICE_ID) {
    return undefined;
  }

  const voicePrompt = buildAutoVoxCPMVoicePrompt({
    agentName: params.agent?.name,
    role: params.agent?.role,
    persona: params.agent?.persona,
    voiceDesign: params.agent?.voiceDesign,
  });
  const design = effectiveVoiceDesign(params.agent);
  const adapter = getVoiceRegistrationAdapter(params.providerId);
  if (!design || !params.baseUrl || !adapter?.supportsRegistration()) return { voicePrompt };

  const config = {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    model: params.modelId,
  };
  const voiceId = await getDeterministicVoiceId(design, {
    providerId: params.providerId,
    model: params.modelId,
  });
  if (await adapter.voiceExists(config, voiceId, params.signal)) {
    return { registeredVoiceId: voiceId };
  }

  const clip = await adapter.bootstrapReferenceClip(config, { design }, params.signal);
  const registeredVoiceId = await adapter.registerVoice(
    config,
    {
      voiceId,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    },
    params.signal,
  );
  return { registeredVoiceId };
}

function audioMime(format: string) {
  return format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
}

/** Server-configured narration synthesis into the stage's classroom-media path. */
export async function synthesizeSceneNarration(input: SceneTtsInput): Promise<SceneTtsSummary> {
  const enabled = enabledProviderIds();
  const narrator = narratorAgent(input.roster);
  const bound = narrator?.voiceConfig;
  const providerId = (
    bound?.providerId && enabled.includes(bound.providerId as TTSProviderId)
      ? bound.providerId
      : enabled[0]
  ) as TTSProviderId | undefined;
  if (!providerId) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const apiKey = resolveTTSApiKey(providerId);
  if (provider?.requiresApiKey && !apiKey) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const voice =
    bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || '';
  const modelId =
    resolveTTSModel(
      providerId,
      DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
      voice,
    ) || '';
  const baseUrl = resolveTTSBaseUrl(providerId);
  const providerOptions = await resolveVoxCPMAutoVoiceOptions({
    providerId,
    voice,
    agent: narrator,
    baseUrl,
    apiKey,
    modelId,
    signal: input.signal,
  });
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
          baseUrl,
          voice,
          speed: speech.speed,
          signal: input.signal,
          ...(providerOptions ? { providerOptions } : {}),
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
