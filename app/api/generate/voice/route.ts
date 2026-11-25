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
import { authorizeMediaModel } from '@/lib/server/model-config/media';
import { modelAuthorizationResponse } from '@/lib/server/api-response';

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  adapterOptions,
  mediaResolutionResponse,
  RequestedProviderRefusedError,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import {
  listAccountVoicesForConnection,
  personalVoiceAccount,
} from '@/lib/server/audio/account-voices';
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
import { findUnsafeNetworkTargetError, validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';
import {
  getVoiceRegistrationAdapter,
  type VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import { InvalidReferenceAudioError } from '@/lib/audio/wav-validate';

const log = createLogger('Voice Registration API');

const ROUTE_DEADLINE_MS = 29_000;
const EXISTS_LOOKUP_SLICE_MS = 5_000;

/** Account management uses the resolved workspace service; no credential is sent by the browser. */
async function withVoiceService(
  req: NextRequest,
  expectedProviderId: unknown,
  expectedServiceId: unknown,
  expectedRevision: number | undefined,
  action: (connection: MediaConnection, signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  if (typeof expectedProviderId !== 'string' || !expectedProviderId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'providerId is required');
  }
  try {
    const connection = await resolveMediaSlot('tts', {
      workspaceId: await requestWorkspaceId(req),
      expectedRevision,
    });
    if (
      connection.providerId !== expectedProviderId ||
      (expectedServiceId != null && expectedServiceId !== connection.serviceId)
    ) {
      return apiError('INVALID_REQUEST', 409, 'The active speech service has changed.');
    }
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(ROUTE_DEADLINE_MS)]);
    return await action(connection, signal);
  } catch (error) {
    const refused = mediaResolutionResponse(error, 'Text to speech');
    if (refused) return refused;
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) return apiError('INVALID_URL', 403, blocked.message);
    return apiError(
      'UPSTREAM_ERROR',
      502,
      'The speech provider could not complete the voice request.',
    );
  }
}

export async function GET(req: NextRequest) {
  const revision = req.nextUrl.searchParams.get('expectedRevision');
  const response = await withVoiceService(
    req,
    req.nextUrl.searchParams.get('providerId'),
    req.nextUrl.searchParams.get('expectedServiceId'),
    revision === null ? undefined : Number(revision),
    async (connection, signal) => {
      const voices = await listAccountVoicesForConnection(connection, signal);
      return apiSuccess({
        voices,
        canDeleteRemote: Boolean(personalVoiceAccount(connection)?.remove),
      });
    },
  );
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/** Explicit remote deletion. Removing a saved profile is a separate, local operation. */
export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const voiceId = typeof body?.voiceId === 'string' ? body.voiceId.trim() : '';
  const kind = body?.kind;
  if (!voiceId || (kind !== 'clone' && kind !== 'designed')) {
    return apiError('INVALID_REQUEST', 400, 'A custom voice ID and kind are required.');
  }
  return withVoiceService(
    req,
    body?.providerId,
    body?.expectedServiceId,
    body?.expectedRevision,
    async (connection, signal) => {
      const account = personalVoiceAccount(connection);
      if (!account?.remove) {
        return apiError(
          'INVALID_REQUEST',
          403,
          'Deleting a provider voice requires your own speech service account.',
        );
      }
      await account.remove(account.config, voiceId, signal, kind);
      return apiSuccess({ voiceId, vendorDeleted: true });
    },
  );
}

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
      expectedProviderId?: string;
      expectedServiceId?: string;
      expectedRevision?: number;
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
      kind?: 'clone' | 'designed';
    };
    providerId = typeof body.providerId === 'string' ? body.providerId : undefined;
    voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined;
    const design = normalizeVoiceDesign(body.descriptor);

    if (!voiceId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'voiceId is required');
    }
    const deleting = body.action === 'delete';
    if (
      !deleting &&
      body.referenceAudioBase64 !== undefined &&
      typeof body.referenceAudioBase64 !== 'string'
    ) {
      return apiError('INVALID_REQUEST', 400, 'referenceAudioBase64 must be a string');
    }
    if (!deleting && !design && !body.referenceAudioBase64) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'descriptor or referenceAudioBase64 is required',
      );
    }

    // Voices register on the tts slot's provider; the provider, key and base
    // URL a request names (deprecated) count only when it is unassigned.
    const requestedProviderId = providerId;
    let connection: MediaConnection;
    try {
      connection = await resolveMediaSlot('tts', {
        workspaceId: await requestWorkspaceId(req),
        expectedRevision: body.expectedRevision,
        legacyRequest: async () =>
          requestedProviderId
            ? requestedTTSProvider(requestedProviderId, body.ttsApiKey, body.ttsBaseUrl)
            : undefined,
      });
    } catch (error) {
      const refused = mediaResolutionResponse(error, 'Text to speech');
      if (refused) return refused;
      throw error;
    }
    if (
      (body.expectedProviderId && body.expectedProviderId !== connection.providerId) ||
      (body.expectedServiceId !== undefined && body.expectedServiceId !== connection.serviceId)
    ) {
      return apiError('INVALID_REQUEST', 409, 'The active speech service has changed.');
    }
    if (requestedProviderId && requestedProviderId !== connection.providerId) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'Voices register on the configured text-to-speech provider, not the one requested',
      );
    }
    providerId = connection.providerId;

    const adapter = getVoiceRegistrationAdapter(providerId);
    if (!adapter) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Provider "${providerId}" does not support voice registration`,
      );
    }

    // Whether a configured provider registers voices depends on its options (a
    // VoxCPM backend without runtime registration does not). The deprecated
    // request path keeps its behaviour.
    if (
      !deleting &&
      connection.origin === 'configuration' &&
      !adapter.supportsRegistration(adapterOptions(connection))
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Provider "${providerId}" does not support voice registration with its configured options`,
      );
    }

    const { managed } = connection;
    const publicOnly = connection.userEndpoint;
    const apiKey = connection.apiKey ?? '';
    const baseUrl =
      connection.baseUrl ?? TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.defaultBaseUrl;
    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'TTS base URL is required');
    }

    const cfg: VoiceRegistrationConfig = {
      baseUrl,
      apiKey,
      publicOnly,
      // A server-configured provider's endpoint may be on a local network.
      managed,
      model:
        providerId === 'qwen-tts'
          ? resolveQwenVoiceCloneModel()
          : connection.origin === 'configuration'
            ? connection.modelId
            : resolveTTSModel(
                providerId,
                connection.origin === 'request' ? body.ttsModelId : connection.modelId,
              ),
    };

    if (deleting) {
      if (!adapter.deleteVoice) {
        return apiError('INVALID_REQUEST', 400, 'This provider does not support voice deletion');
      }
      // Vendor IDs may be present in exported classroom data, so possession of
      // an ID is not ownership. Only a caller-supplied account key authorizes
      // provider-side deletion; a managed server key must never be used here.
      if (connection.origin !== 'request' || managed || !body.ttsApiKey?.trim()) {
        return apiSuccess({
          voiceId,
          deleted: false,
          vendorDeleted: false,
          localOnly: true,
          message:
            'The local voice profile can be removed, but the provider voice was not deleted.',
        });
      }
      if (adapter.listVoices && body.kind !== 'clone' && body.kind !== 'designed') {
        return apiError('INVALID_REQUEST', 400, 'A custom voice kind is required.');
      }
      await adapter.deleteVoice(cfg, voiceId, deadline.signal, body.kind);
      return apiSuccess({ voiceId, deleted: true, vendorDeleted: true, localOnly: false });
    }

    authorizeMediaModel(connection, 'tts', cfg.model);

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
      return apiError('INVALID_REQUEST', 400, 'This provider requires reference audio');
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
    const authorization = modelAuthorizationResponse(error);
    if (authorization) return authorization;
    log.error(
      `Voice registration failed [provider=${providerId ?? 'unknown'}, voiceId=${voiceId ?? 'unknown'}]:`,
      error,
    );
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) {
      return apiError('INVALID_URL', 403, blocked.message);
    }
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

/** The TTS provider a request names in its body (deprecated). */
async function requestedTTSProvider(
  providerId: string,
  clientApiKey: string | undefined,
  clientBaseUrl: string | undefined,
): Promise<MediaConnection> {
  // A server-force-disabled provider is off for everyone (#665), as in the TTS route.
  if (isServerTTSProviderDisabled(providerId)) {
    throw new RequestedProviderRefusedError(
      apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server'),
    );
  }
  // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
  const managed = isServerConfiguredProvider('tts', providerId);
  const baseUrlFromClient = managed ? undefined : clientBaseUrl || undefined;
  // A client BYOK base URL is always validated under the strict public policy;
  // only a server-managed backend may inherit ALLOW_LOCAL_NETWORKS.
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
