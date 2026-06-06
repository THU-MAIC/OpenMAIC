/**
 * VoxCPM auto-voice registration API.
 *
 * Idempotently ensures an agent's deterministic voice id is registered on the
 * backend so later TTS can reference it by id (stable timbre, lean payload).
 * Folds bootstrap + register + existence-check + register-on-invalid into one
 * call:
 *  - client supplies a cached reference clip → (re)register it under voiceId;
 *  - else if the voice already exists → no-op;
 *  - else synthesize the descriptor once, register, and return the clip so the
 *    client can cache it.
 *
 * POST /api/generate/voxcpm-voice
 */

import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { normalizeVoiceDesign, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import {
  bootstrapVoxCPMReferenceClip,
  registerVoxCPMVoice,
  voxCPMVoiceExists,
  type VoxCPMRegistrationConfig,
} from '@/lib/audio/voxcpm-registration';

const log = createLogger('VoxCPM Voice API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let voiceId: string | undefined;
  try {
    const body = (await req.json()) as {
      voiceId?: string;
      descriptor?: unknown;
      language?: string;
      referenceAudioBase64?: string;
      mimeType?: string;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsModelId?: string;
    };
    voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined;
    const design = normalizeVoiceDesign(body.descriptor);

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

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('tts', VOXCPM_TTS_PROVIDER_ID);
    const clientBaseUrl = managed ? undefined : body.ttsBaseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveTTSApiKey(
      VOXCPM_TTS_PROVIDER_ID,
      managed ? undefined : body.ttsApiKey || undefined,
    );
    const baseUrl = resolveTTSBaseUrl(VOXCPM_TTS_PROVIDER_ID, clientBaseUrl);
    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'VoxCPM base URL is required');
    }

    const cfg: VoxCPMRegistrationConfig = { baseUrl, apiKey, model: body.ttsModelId };

    // Client supplied a cached reference clip → (re)register it (register-on-invalid).
    if (body.referenceAudioBase64) {
      await registerVoxCPMVoice(cfg, {
        voiceId,
        referenceAudioBase64: body.referenceAudioBase64,
        mimeType: body.mimeType,
      });
      return apiSuccess({ voiceId, registered: true });
    }

    // Already registered → no-op.
    if (await voxCPMVoiceExists(cfg, voiceId)) {
      return apiSuccess({ voiceId, registered: true });
    }

    // First use → bootstrap-synthesize the descriptor, register, return the clip.
    const clip = await bootstrapVoxCPMReferenceClip(cfg, {
      design: design!,
      language: body.language,
    });
    await registerVoxCPMVoice(cfg, {
      voiceId,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });

    log.info(`Registered VoxCPM auto voice ${voiceId}`);
    return apiSuccess({
      voiceId,
      registered: true,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });
  } catch (error) {
    log.error(`VoxCPM voice registration failed [voiceId=${voiceId ?? 'unknown'}]:`, error);
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
