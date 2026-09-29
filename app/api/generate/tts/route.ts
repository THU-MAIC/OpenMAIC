/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import {
  generateTTS,
  QwenTTSError,
  TTSInvalidResponseError,
  TTSRateLimitError,
} from '@/lib/audio/tts-providers';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  TTSModelNotAllowedError,
} from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { findUnsafeNetworkTargetError, validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import { DEFAULT_TTS_VOICES, isQwenCloneVoice } from '@/lib/audio/constants';
import {
  mediaResolutionResponse,
  RequestedProviderRefusedError,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';

const log = createLogger('TTS API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let ttsProviderId: string | undefined;
  let ttsVoice: string | undefined;
  let audioId: string | undefined;
  try {
    const body = await req.json();
    const { text, ttsModelId, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = body as {
      text: string;
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsModelId?: string;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsProviderOptions?: Record<string, unknown>;
    };
    const requestedProviderId =
      typeof body.ttsProviderId === 'string' && body.ttsProviderId ? body.ttsProviderId : undefined;
    const requestedVoice = typeof body.ttsVoice === 'string' ? body.ttsVoice.trim() : undefined;
    audioId = body.audioId;

    // A voice that is sent must say something; an absent one means the default.
    if (!text || !audioId || (body.ttsVoice !== undefined && !requestedVoice)) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId (and a non-empty ttsVoice when sent)',
      );
    }

    // The tts slot decides; the provider, key and base URL a request names
    // (deprecated) count only when it is unassigned.
    let connection: MediaConnection;
    try {
      connection = await resolveMediaSlot('tts', {
        workspaceId: await requestWorkspaceId(req),
        legacyRequest: async () =>
          requestedProviderId
            ? requestedTTSProvider(requestedProviderId, ttsApiKey, ttsBaseUrl)
            : undefined,
      });
    } catch (error) {
      const refused = mediaResolutionResponse(error, 'Text to speech');
      if (refused) return refused;
      throw error;
    }
    ttsProviderId = connection.providerId;
    // A voice belongs to its provider: the request's voice only for the
    // provider it was chosen for, else the provider's default voice.
    ttsVoice =
      requestedVoice && requestedProviderId === ttsProviderId
        ? requestedVoice
        : DEFAULT_TTS_VOICES[ttsProviderId as keyof typeof DEFAULT_TTS_VOICES] || requestedVoice;
    if (!ttsVoice) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: ttsVoice');
    }

    // Reject browser-native TTS — must be handled client-side
    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
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
      return apiError(
        'VOXCPM_AUTO_VOICE_REQUIRES_CONTEXT',
        400,
        'VoxCPM Auto Voice requires agent context',
      );
    }

    const { managed, apiKey, baseUrl } = connection;
    // A user-supplied endpoint (a BYOK base URL, a workspace provider) runs
    // under the strict public policy; only operator configuration may inherit
    // the operator's ALLOW_LOCAL_NETWORKS opt-in.
    const publicOnly = connection.userEndpoint;

    // Pre-flight the same key requirement the library enforces: a keyed provider
    // with no key is a client contract violation, not a server failure.
    const ttsProvider = TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS];
    if (ttsProvider?.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        `No API key configured for TTS provider: ${ttsProviderId}`,
      );
    }

    // Build TTS config (managed providers may pin the model server-side)
    const qwenCloneVoice = ttsProviderId === 'qwen-tts' && isQwenCloneVoice(ttsVoice);
    const requestedSpeed = ttsSpeed ?? 1.0;
    // The slot's model, or on the request path the client's; Qwen voice-clone
    // voices switch to the clone model either way.
    const resolvedModelId = resolveTTSModel(
      ttsProviderId,
      connection.origin === 'request' ? ttsModelId : connection.modelId,
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
      providerOptions: {
        ...(ttsProviderOptions || {}),
        ...(qwenCloneVoice ? { qwenVoiceClone: true } : {}),
      },
    };

    log.info(
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

    // Convert to base64
    const base64 = Buffer.from(audio).toString('base64');

    return apiSuccess({
      audioId,
      base64,
      format,
    });
  } catch (error) {
    log.error(
      `TTS generation failed [provider=${ttsProviderId ?? 'unknown'}, voice=${ttsVoice ?? 'unknown'}, audioId=${audioId ?? 'unknown'}]:`,
      error,
    );
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) {
      return apiError('INVALID_URL', 403, blocked.message);
    }
    if (error instanceof TTSRateLimitError) {
      return apiError('RATE_LIMITED', 429, error.message);
    }
    if (error instanceof TTSInvalidResponseError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    if (error instanceof QwenVoiceCloneError) {
      return apiError(error.code, error.httpStatus || 502, qwenVoiceCloneErrorMessage(error));
    }
    if (error instanceof QwenTTSError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    if (error instanceof TTSModelNotAllowedError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The TTS provider a request names in its body (deprecated), with the key and
 * base URL it sends for an unmanaged provider.
 */
async function requestedTTSProvider(
  providerId: string,
  clientApiKey: string | undefined,
  clientBaseUrl: string | undefined,
): Promise<MediaConnection> {
  // A force-disabled provider is off for everyone (#665).
  if (isServerTTSProviderDisabled(providerId)) {
    throw new RequestedProviderRefusedError(
      apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server'),
    );
  }
  // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
  const managed = isServerConfiguredProvider('tts', providerId);
  const baseUrlFromClient = managed ? undefined : clientBaseUrl || undefined;
  if (baseUrlFromClient) {
    const ssrfError = await validatePublicUrlForSSRF(baseUrlFromClient);
    if (ssrfError) throw new RequestedProviderRefusedError(apiError('INVALID_URL', 403, ssrfError));
  }
  const baseUrl = resolveTTSBaseUrl(providerId, baseUrlFromClient);
  return {
    providerId,
    apiKey: resolveTTSApiKey(providerId, managed ? undefined : clientApiKey || undefined),
    ...(baseUrl ? { baseUrl } : {}),
    managed,
    userEndpoint: Boolean(baseUrlFromClient),
    origin: 'request',
  };
}
