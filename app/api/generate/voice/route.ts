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
  resolveQwenVoiceCloneModel,
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
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import { InvalidReferenceAudioError } from '@/lib/audio/wav-validate';

const log = createLogger('Voice Registration API');

export const maxDuration = 30;
const ROUTE_DEADLINE_MS = 29_000;
const EXISTS_LOOKUP_SLICE_MS = 5_000;

function childSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Lookup timed out', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}

export async function POST(req: NextRequest) {
  let providerId: string | undefined;
  let voiceId: string | undefined;
  const deadline = new AbortController();
  const abortFromRequest = () => deadline.abort(req.signal.reason);
  if (req.signal.aborted) abortFromRequest();
  else req.signal.addEventListener('abort', abortFromRequest, { once: true });
  const deadlineTimer = setTimeout(
    () => deadline.abort(new DOMException('Voice registration timed out', 'TimeoutError')),
    ROUTE_DEADLINE_MS,
  );
  try {
    const body = (await req.json()) as {
      providerId?: string;
      voiceId?: string;
      descriptor?: unknown;
      language?: string;
      referenceAudioBase64?: string;
      mimeType?: string;
      refText?: string;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsModelId?: string;
      action?: 'register' | 'delete';
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
    const deleting = body.action === 'delete';
    if (!deleting && !design && !body.referenceAudioBase64) {
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
      model:
        providerId === 'qwen-tts'
          ? resolveQwenVoiceCloneModel()
          : resolveTTSModel(providerId, body.ttsModelId),
    };

    if (deleting) {
      if (!adapter.deleteVoice) {
        return apiError('INVALID_REQUEST', 400, 'This provider does not support voice deletion');
      }
      // Vendor IDs may be present in exported classroom data, so possession of
      // an ID is not ownership. Only a caller-supplied account key authorizes
      // provider-side deletion; a managed server key must never be used here.
      if (managed || !body.ttsApiKey?.trim()) {
        return apiSuccess({
          voiceId,
          deleted: false,
          vendorDeleted: false,
          localOnly: true,
          message:
            'The local voice profile can be removed, but the provider voice was not deleted.',
        });
      }
      await adapter.deleteVoice(cfg, voiceId, deadline.signal);
      return apiSuccess({ voiceId, deleted: true, vendorDeleted: true, localOnly: false });
    }

    // Already registered → no-op (also avoids a redundant re-register when the
    // client offered a cached clip but the voice is still live on the backend).
    const lookup = childSignal(deadline.signal, EXISTS_LOOKUP_SLICE_MS);
    let exists: boolean | 'unknown' = false;
    try {
      exists = await adapter.voiceExists(cfg, voiceId, lookup.signal);
    } catch (error) {
      if (!lookup.signal.aborted || deadline.signal.aborted) throw error;
      // A slow preflight must not consume the route budget. Enrollment proceeds
      // with the same outer deadline and remains the authoritative operation.
    } finally {
      lookup.cleanup();
    }
    if (exists === true) {
      return apiSuccess({ voiceId, registered: true });
    }

    // Missing or ambiguous, but the client has the cached reference clip →
    // idempotently re-register it. This preserves the original timbre and avoids
    // blind fresh enrollment after an inconclusive paginated lookup.
    if (body.referenceAudioBase64) {
      const registeredVoiceId = await adapter.registerVoice(
        cfg,
        {
          voiceId,
          referenceAudioBase64: body.referenceAudioBase64,
          mimeType: body.mimeType,
          refText: body.refText,
        },
        deadline.signal,
      );
      return apiSuccess({ voiceId: registeredVoiceId, registered: true });
    }

    // First use → bootstrap-synthesize the descriptor, register, return the clip.
    if (adapter.supportsBootstrapReferenceClip === false) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'This provider requires reference audio and a verbatim transcript',
      );
    }
    const clip = await adapter.bootstrapReferenceClip(
      cfg,
      { design: design!, language: body.language },
      deadline.signal,
    );
    const registeredVoiceId = await adapter.registerVoice(
      cfg,
      {
        voiceId,
        referenceAudioBase64: clip.referenceAudioBase64,
        mimeType: clip.mimeType,
      },
      deadline.signal,
    );

    log.info(`Registered auto voice ${voiceId} for provider ${providerId}`);
    return apiSuccess({
      voiceId: registeredVoiceId,
      registered: true,
      referenceAudioBase64: clip.referenceAudioBase64,
      mimeType: clip.mimeType,
    });
  } catch (error) {
    log.error(
      `Voice registration failed [provider=${providerId ?? 'unknown'}, voiceId=${voiceId ?? 'unknown'}]:`,
      error,
    );
    if (error instanceof QwenVoiceCloneError) {
      return apiError(error.code, error.httpStatus || 502, qwenVoiceCloneErrorMessage(error));
    }
    if (error instanceof InvalidReferenceAudioError) {
      return apiError(error.code, 400, error.message);
    }
    if (deadline.signal.aborted) {
      return apiError('QWEN_VC_TIMEOUT', 504, 'The voice registration request timed out.');
    }
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(deadlineTimer);
    req.signal.removeEventListener('abort', abortFromRequest);
  }
}
