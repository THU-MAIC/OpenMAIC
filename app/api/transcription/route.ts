import { NextRequest } from 'next/server';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveASRApiKey,
  resolveASRBaseUrl,
  resolveASRModel,
} from '@/lib/server/provider-config';
import {
  RequestedProviderRefusedError,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import {
  savedMediaConnection,
  savedProviderRef,
  savedProviderResponse,
} from '@/lib/server/model-config/saved-provider';
import type { ASRProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { findUnsafeNetworkTargetError, validatePublicUrlForSSRF } from '@/lib/server/ssrf-guard';
const log = createLogger('Transcription');

export async function POST(req: NextRequest) {
  let resolvedProviderId: string | undefined;
  let resolvedModelId: string | undefined;
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const providerId = formData.get('providerId') as ASRProviderId | null;
    // Trim the client model id and normalize empty → undefined, matching the
    // image/video generation routes (a pinned server model must never be
    // shadowed by a whitespace-padded client id).
    const modelId = (formData.get('modelId') as string | null)?.trim() || undefined;
    const language = formData.get('language') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;

    if (!audioFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Audio file is required');
    }

    // The asr slot decides; the provider, key and base URL a request names
    // (deprecated) count only when it is unassigned.
    // A settings test names a saved provider instead (`previewProvider`, with
    // an optional `previewModel`): the server's configuration of it.
    let connection: MediaConnection;
    try {
      const preview = savedProviderRef(
        formData.get('previewProvider') ?? undefined,
        formData.get('previewModel') ?? undefined,
      );
      connection = preview
        ? await savedMediaConnection(req, 'asr', preview)
        : await resolveMediaSlot('asr', {
            workspaceId: await requestWorkspaceId(req),
            legacyRequest: async () =>
              providerId ? requestedASRProvider(providerId, modelId, apiKey, baseUrl) : undefined,
          });
    } catch (error) {
      const refused = savedProviderResponse(error, 'Speech recognition');
      if (refused) return refused;
      throw error;
    }
    resolvedProviderId = connection.providerId;

    const config = {
      providerId: connection.providerId as ASRProviderId,
      // On the legacy default provider the request's model still applies
      // through its allowlist, as before slots.
      modelId:
        connection.origin === 'default'
          ? resolveASRModel(connection.providerId, modelId)
          : connection.modelId,
      language: language || 'auto',
      apiKey: connection.apiKey ?? '',
      baseUrl: connection.baseUrl,
      // A user-supplied endpoint is judged under the strict public policy,
      // even when the operator enabled local networks for their own backend.
      publicOnly: connection.userEndpoint,
      // A server-configured provider's endpoint may be on a local network.
      managed: connection.managed,
    };
    // Reflect the resolved (possibly server-pinned) model in failure logs.
    resolvedModelId = config.modelId;

    // Transcribe using the provider system
    const result = await transcribeAudio(config, audioFile);

    return apiSuccess({ text: result.text });
  } catch (error) {
    log.error(
      `Transcription failed [provider=${resolvedProviderId ?? 'unknown'}, model=${resolvedModelId ?? 'default'}]:`,
      error,
    );
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) {
      return apiError('INVALID_URL', 403, blocked.message);
    }
    return apiError(
      'TRANSCRIPTION_FAILED',
      500,
      'Transcription failed',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

/** The ASR provider a request names in its form (deprecated). */
async function requestedASRProvider(
  providerId: ASRProviderId,
  clientModel: string | undefined,
  clientApiKey: string | null,
  clientBaseUrl: string | null,
): Promise<MediaConnection> {
  // A force-disabled provider is off for everyone (#665).
  if (isServerProviderDisabled('asr', providerId)) {
    throw new RequestedProviderRefusedError(
      apiError('PROVIDER_DISABLED', 403, 'This ASR provider is disabled by the server'),
    );
  }
  // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
  const managed = isServerConfiguredProvider('asr', providerId);
  const baseUrlFromClient = managed ? undefined : clientBaseUrl || undefined;
  if (baseUrlFromClient) {
    const ssrfError = await validatePublicUrlForSSRF(baseUrlFromClient);
    if (ssrfError) throw new RequestedProviderRefusedError(apiError('INVALID_URL', 403, ssrfError));
  }
  // A managed provider may pin its model list server-side
  // (ASR_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
  // first pinned entry is the managed default.
  const model = resolveASRModel(providerId, clientModel);
  const baseUrl = resolveASRBaseUrl(providerId, baseUrlFromClient);
  return {
    providerId,
    ...(model ? { modelId: model } : {}),
    apiKey: resolveASRApiKey(providerId, managed ? undefined : clientApiKey || undefined),
    ...(baseUrl ? { baseUrl } : {}),
    managed,
    userEndpoint: Boolean(baseUrlFromClient),
    origin: 'request',
  };
}
