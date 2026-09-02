import { NextRequest } from 'next/server';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveASRApiKey,
  resolveASRBaseUrl,
  resolveASRModel,
  resolveServerASRProviderId,
} from '@/lib/server/provider-config';
import type { ASRProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
const log = createLogger('Transcription');

export const maxDuration = 60;

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

    // Prefer an enabled operator-configured backend when the client omitted its
    // selection. Never guess a vendor: fail loudly when no backend is enabled.
    const effectiveProviderId =
      providerId || (resolveServerASRProviderId() as ASRProviderId | undefined);
    if (!effectiveProviderId) {
      return apiError('MISSING_PROVIDER', 400, 'No enabled ASR provider is configured');
    }
    resolvedProviderId = effectiveProviderId;
    resolvedModelId = modelId;

    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (isServerProviderDisabled('asr', effectiveProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This ASR provider is disabled by the server');
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('asr', effectiveProviderId);
    const clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = {
      providerId: effectiveProviderId,
      // A managed provider may pin its model list server-side
      // (ASR_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
      // first pinned entry is the managed default; unmanaged providers use the
      // client model directly.
      modelId: resolveASRModel(effectiveProviderId, modelId),
      language: language || 'auto',
      apiKey: resolveASRApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
      baseUrl: resolveASRBaseUrl(effectiveProviderId, clientBaseUrl),
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
    return apiError(
      'TRANSCRIPTION_FAILED',
      500,
      'Transcription failed',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
