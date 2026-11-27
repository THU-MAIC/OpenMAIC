/**
 * Video Generation API
 *
 * Generates a video from a text prompt using the specified provider.
 * Uses the async task pattern (submit → poll).
 *
 * POST /api/generate/video
 *
 * Body: { prompt, duration?, aspectRatio?, resolution? }
 * Response: { success: boolean, result?: VideoGenerationResult, error?: string }
 */
import { modelAuthorizationResponse } from '@/lib/server/api-response';

import { NextRequest } from 'next/server';
import type { VideoGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import {
  mediaResolutionResponse,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { generateVideoStep, type VideoRefusal } from '@/lib/server/generation/steps/video';

const log = createLogger('VideoGeneration API');

/** The route never resumes a provider task, so the connection never changes under one. */
const REFUSAL_RESPONSES: Record<
  Exclude<VideoRefusal, 'task-connection-changed'>,
  [ApiErrorCode, number]
> = {
  'missing-api-key': ['MISSING_API_KEY', 401],
  'missing-model': ['MISSING_MODEL', 400],
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as VideoGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    let connection: MediaConnection;
    try {
      connection = await resolveMediaSlot('video', {
        workspaceId: await requestWorkspaceId(request),
      });
    } catch (error) {
      const refused = mediaResolutionResponse(error, 'Video generation');
      if (refused) return refused;
      throw error;
    }
    let result;
    try {
      result = await generateVideoStep(
        {
          options: body,
          connection,
        },
        { log },
      );
    } catch (error) {
      if (!(error instanceof StepRefusal)) throw error;
      const [code, status] =
        REFUSAL_RESPONSES[error.reason as Exclude<VideoRefusal, 'task-connection-changed'>];
      return apiError(code, status, error.message);
    }

    return apiSuccess({ result });
  } catch (error) {
    const authorization = modelAuthorizationResponse(error);
    if (authorization) return authorization;
    const message = error instanceof Error ? error.message : String(error);
    // The provider's error text is logged only; the caller gets a fixed message
    // so an upstream body never reaches the response.
    // Detect content safety filter rejections (e.g. Seedance SensitiveContent errors)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Video blocked by content safety filter: ${message}`);
      return apiError(
        'CONTENT_SENSITIVE',
        400,
        'The video provider rejected this prompt under its content safety policy',
      );
    }
    log.error(`Video generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, 'Video generation failed');
  }
}
