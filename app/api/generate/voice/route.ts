/**
 * Auto-voice registration API (provider-neutral).
 *
 * Idempotently ensures an agent's deterministic voice id is registered on the
 * selected TTS provider's backend so later TTS can reference it by id (stable
 * timbre, lean payload). Dispatches to the provider's VoiceRegistrationAdapter;
 * no provider is named here. Folds bootstrap + register + existence-check +
 * register-on-invalid into one call:
 *  - client supplies a cached reference clip → (re)register it under voiceId;
 *  - else if the voice already exists → no-op;
 *  - else synthesize the descriptor once, register, and return the clip so the
 *    client can cache it.
 *
 * POST /api/generate/voice
 */

import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';
import {
  getVoiceRegistrationAdapter,
  type VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

const log = createLogger('Voice Registration API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let providerId: string | undefined;
  let voiceId: string | undefined;
  try {
    const body = (await req.json()) as {
      providerId?: string;
      voiceId?: string;
      descriptor?: unknown;
      language?: string;
      referenceAudioBase64?: string;
      mimeType?: string;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsModelId?: string;
    };
    providerId = typeof body.providerId === 'string' ? body.providerId : undefined;
    voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined;
    const design = normalizeVoiceDesign(body.descriptor);

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'providerId is required');
    }
    if (!voiceId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'voiceId is required');
    }
    if (!design && !body.referenceAudioBase64) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'descriptor or referenceAudioBase64 is required',
      );
    }

    // A server-force-disabled provider is off for everyone (#665), same as the TTS route.
    if (isServerTTSProviderDisabled(providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
    }

    const adapter = getVoiceRegistrationAdapter(providerId);
    if (!adapter) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Provider "${providerId}" does not support voice registration`,
      );
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('tts', providerId);
    const clientBaseUrl = managed ? undefined : body.ttsBaseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveTTSApiKey(providerId, managed ? undefined : body.ttsApiKey || undefined);
    const baseUrl = resolveTTSBaseUrl(providerId, clientBaseUrl);
    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'TTS base URL is required');
    }

    const cfg: VoiceRegistrationConfig = {
      baseUrl,
      apiKey,
      model: resolveTTSModel(providerId, body.ttsModelId),
    };

    // Already registered → no-op (also avoids a redundant re-register when the
    // client offered a cached clip but the voice is still live on the backend).
    if (await adapter.voiceExists(cfg, voiceId)) {
      return apiSuccess({ voiceId, registered: true });
    }

    // Not present, but the client has the cached reference clip → re-register it
    // (register-on-invalid; preserves the original timbre instead of re-synthesizing).
    if (body.referenceAudioBase64) {
      await adapter.registerVoice(cfg, {
        voiceId,
        referenceAudioBase64: body.referenceAudioBase64,
        mimeType: body.mimeType,
      });
      return apiSuccess({ voiceId, registered: true });
    }

    // First use → bootstrap-synthesize the descriptor, register, return the clip.
    const clip = await adapter.bootstrapReferenceClip(cfg, {
      design: design!,
      language: body.language,
    });
    await adapter.registerVoice(cfg, {
      voiceId,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });

    log.info(`Registered auto voice ${voiceId} for provider ${providerId}`);
    return apiSuccess({
      voiceId,
      registered: true,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });
  } catch (error) {
    log.error(
      `Voice registration failed [provider=${providerId ?? 'unknown'}, voiceId=${voiceId ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
