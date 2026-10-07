/**
 * Narration: synthesize one speech line through the tts slot's provider.
 * Moved from POST /api/generate/tts, which keeps resolving the slot (with the
 * request's deprecated provider fields) and mapping provider errors to its
 * responses.
 */
import { generateTTS, type TTSGenerationResult } from '@/lib/audio/tts-providers';
import { TTS_PROVIDERS, DEFAULT_TTS_VOICES, isQwenCloneVoice } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { resolveTTSModel, slotTTSModel } from '@/lib/server/provider-config';
import { adapterOptions, type MediaConnection } from '@/lib/server/model-config/media';

import { StepRefusal, type StepContext } from './context';

export interface NarrationInput {
  text: string;
  /** The audio's id, for the log. */
  audioId: string;
  /** The tts slot's connection. */
  connection: MediaConnection;
  /** The provider the voice was chosen for, when the caller names one. */
  requestedProviderId?: string;
  /** The voice to speak with; the provider's default when absent or chosen for another provider. */
  requestedVoice?: string;
  /** The model a deprecated request names; it applies only to a requested provider. */
  requestedModelId?: string;
  speed?: number;
  /** The voice's provider options (a VoxCPM voice prompt or registered voice, say). */
  providerOptions?: Record<string, unknown>;
  /** Filled in as the provider and voice resolve, for the caller's failure log. */
  trace?: { providerId?: string; voice?: string };
}

export type NarrationRefusal =
  /** Neither the request nor the provider has a voice. */
  | 'voice-missing'
  /** The slot's provider speaks in the browser, not on the server. */
  | 'client-side-provider'
  /** The automatic voice needs the agent's voice context. */
  | 'voice-context-required'
  /** The provider needs a key and none is configured. */
  | 'missing-api-key';

export interface NarrationResult extends TTSGenerationResult {
  providerId: string;
  modelId?: string;
}

export async function synthesizeNarration(
  input: NarrationInput,
  ctx: StepContext,
): Promise<NarrationResult> {
  const { text, audioId, connection, requestedProviderId, requestedVoice } = input;
  const ttsProviderOptions = input.providerOptions;
  const trace = input.trace ?? {};
  const ttsProviderId = connection.providerId;
  trace.providerId = ttsProviderId;
  // A voice belongs to its provider: the request's voice unless it was
  // chosen for another provider, in which case the provider's default.
  const ttsVoice =
    requestedVoice && (!requestedProviderId || requestedProviderId === ttsProviderId)
      ? requestedVoice
      : DEFAULT_TTS_VOICES[ttsProviderId as keyof typeof DEFAULT_TTS_VOICES] || requestedVoice;
  trace.voice = ttsVoice;
  if (!ttsVoice) {
    throw new StepRefusal<NarrationRefusal>('voice-missing', 'Missing required field: ttsVoice');
  }

  // Reject browser-native TTS — must be handled client-side
  if (ttsProviderId === 'browser-native-tts') {
    throw new StepRefusal<NarrationRefusal>(
      'client-side-provider',
      'browser-native-tts must be handled client-side',
    );
  }

  const voxcpmVoicePrompt =
    typeof ttsProviderOptions?.voicePrompt === 'string' ? ttsProviderOptions.voicePrompt : '';
  const voxcpmRegisteredVoiceId =
    typeof ttsProviderOptions?.registeredVoiceId === 'string'
      ? ttsProviderOptions.registeredVoiceId
      : '';
  if (
    ttsProviderId === VOXCPM_TTS_PROVIDER_ID &&
    ttsVoice === VOXCPM_AUTO_VOICE_ID &&
    !voxcpmVoicePrompt.trim() &&
    !voxcpmRegisteredVoiceId.trim()
  ) {
    throw new StepRefusal<NarrationRefusal>(
      'voice-context-required',
      'VoxCPM Auto Voice requires agent context',
    );
  }

  const { managed, apiKey, baseUrl } = connection;
  // A user-supplied endpoint (a BYOK base URL, a workspace provider) runs
  // under the strict public policy; only operator configuration may inherit
  // the operator's ALLOW_LOCAL_NETWORKS opt-in.
  const publicOnly = connection.userEndpoint;

  // Pre-flight the same key requirement the library enforces: a keyed provider
  // with no key is a caller contract violation, not a server failure.
  const ttsProvider = TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS];
  if (ttsProvider?.requiresApiKey && !apiKey) {
    throw new StepRefusal<NarrationRefusal>(
      'missing-api-key',
      `No API key configured for TTS provider: ${ttsProviderId}`,
    );
  }

  // Build TTS config (managed providers may pin the model server-side)
  const qwenCloneVoice = ttsProviderId === 'qwen-tts' && isQwenCloneVoice(ttsVoice);
  const requestedSpeed = input.speed ?? 1.0;
  // A configured slot's own model; on the deprecated and default paths the
  // client's (or default) model under the legacy server pins. Qwen
  // voice-clone voices switch to the clone model either way.
  const resolvedModelId =
    connection.origin === 'configuration'
      ? slotTTSModel(ttsProviderId, connection.modelId, ttsVoice)
      : resolveTTSModel(
          ttsProviderId,
          connection.origin === 'request' ? input.requestedModelId : connection.modelId,
          ttsVoice,
        );
  const config = {
    providerId: ttsProviderId as TTSProviderId,
    modelId: resolvedModelId,
    voice: ttsVoice,
    speed: qwenCloneVoice ? 1 : requestedSpeed,
    apiKey: apiKey ?? '',
    baseUrl,
    publicOnly,
    // A server-configured provider's endpoint may be on a local network.
    managed,
    // The provider's own options (a VoxCPM backend, say) with the voice's.
    // A run cancels the request when it loses its lease or its course.
    signal: ctx.signal,
    providerOptions: {
      ...adapterOptions(connection, ttsProviderOptions),
      ...(qwenCloneVoice ? { qwenVoiceClone: true } : {}),
    },
  };

  ctx.log.info(
    `Generating TTS: provider=${ttsProviderId}, model=${config.modelId || 'default'}, voice=${ttsVoice}, ` +
      `registeredVoiceId=${voxcpmRegisteredVoiceId || 'none'}, audioId=${audioId}, textLen=${text.length}`,
  );

  // Generate audio
  const { audio, format } = await generateTTS(config, text);

  void recordGenerationUsage({
    kind: 'tts',
    unit: 'character',
    providerId: ttsProviderId,
    modelId: config.modelId,
    quantity: text.length,
  });

  return { audio, format, providerId: ttsProviderId, modelId: config.modelId };
}
