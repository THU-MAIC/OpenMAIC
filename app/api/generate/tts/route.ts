/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import { generateTTS, QwenTTSError, TTSRateLimitError } from '@/lib/audio/tts-providers';
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
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import { isQwenCloneVoice } from '@/lib/audio/constants';

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
    ttsProviderId = body.ttsProviderId;
    ttsVoice = typeof body.ttsVoice === 'string' ? body.ttsVoice.trim() : undefined;
    audioId = body.audioId;

    // Validate required fields
    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
      );
    }

    // Reject browser-native TTS — must be handled client-side
    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection (#665).
    if (isServerTTSProviderDisabled(ttsProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
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

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('tts', ttsProviderId);
    const clientBaseUrl = managed ? undefined : ttsBaseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveTTSApiKey(ttsProviderId, managed ? undefined : ttsApiKey || undefined);
    const baseUrl = resolveTTSBaseUrl(ttsProviderId, clientBaseUrl);

    // Pre-flight the same key requirement the library enforces: a keyed provider
    // with no key (server config AND client-supplied key both absent) is a
    // client contract violation, not a server failure. Return the image route's
    // MISSING_API_KEY envelope instead of falling through to a 500
    // GENERATION_FAILED. Unknown/custom providers keep their existing behavior.
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
    const resolvedModelId = resolveTTSModel(ttsProviderId, ttsModelId, ttsVoice);
    const config = {
      providerId: ttsProviderId as TTSProviderId,
      modelId: resolvedModelId,
      voice: ttsVoice,
      speed: qwenCloneVoice ? 1 : requestedSpeed,
      apiKey,
      baseUrl,
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
    if (error instanceof TTSRateLimitError) {
      return apiError('RATE_LIMITED', 429, error.message);
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
