/**
 * Video Generation API
 *
 * Generates a video from a text prompt using the specified provider.
 * Uses async task pattern (submit → poll) so maxDuration is set to 5 minutes.
 *
 * POST /api/generate/video
 *
 * Headers:
 *   x-video-provider: VideoProviderId (optional, server-configured default)
 *   x-video-model: string (optional model override)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, duration?, aspectRatio?, resolution? }
 * Response: { success: boolean, result?: VideoGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import {
  isServerConfiguredProvider,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveServerVideoProviderId,
} from '@/lib/server/provider-config';
import type { VideoProviderId, VideoGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VideoGeneration API');

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as VideoGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    // The client may express no provider preference (empty header) — fall back
    // to the first server-configured video provider, else fail loud.
    const providerId = (request.headers.get('x-video-provider')?.trim() ||
      resolveServerVideoProviderId()) as VideoProviderId;
    if (!providerId) {
      return apiError('MISSING_PROVIDER', 400, 'No video provider configured');
    }
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('video', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
    const clientModel = request.headers.get('x-video-model')?.trim() || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveVideoApiKey(providerId, clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for video provider: ${providerId}`,
      );
    }

    const baseUrl = resolveVideoBaseUrl(providerId, clientBaseUrl);

    // A managed provider may pin its model list server-side
    // (VIDEO_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
    // first pinned entry is the managed default; unmanaged providers use the
    // client header directly.
    const model = resolveVideoModel(providerId, clientModel);
    if (!model) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for video provider: ${providerId}`,
      );
    }

    // Normalize options against provider capabilities
    const options = normalizeVideoOptions(providerId, body);

    log.info(
      `Generating video: provider=${providerId}, model=${model || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", duration=${options.duration ?? 'auto'}, ` +
        `aspect=${options.aspectRatio ?? 'auto'}, resolution=${options.resolution ?? 'auto'}`,
    );

    const result = await generateVideo({ providerId, apiKey, baseUrl, model }, options);

    log.info(
      `Video generated: url=${result.url ? 'yes' : 'no'}, ${result.width}x${result.height}, ${result.duration}s`,
    );

    void recordGenerationUsage({
      kind: 'video',
      unit: 'second',
      providerId,
      modelId: model,
      quantity: result.duration,
    });

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedance SensitiveContent errors)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Video blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(`Video generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
