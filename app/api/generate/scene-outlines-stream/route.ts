/**
 * Scene Outlines Streaming API (SSE)
 *
 * Streams outline generation via Server-Sent Events.
 * Emits individual outline objects as they're parsed from the LLM response,
 * so the frontend can display them incrementally. The generation itself is
 * the outline step (lib/server/generation/steps/outline.ts).
 *
 * SSE events:
 *   { type: 'languageDirective', data: string }
 *   { type: 'courseTitle', data: string }
 *   { type: 'outline', data: SceneOutline, index: number }
 *   { type: 'retry', attempt: number, maxAttempts: number, fallback?: string }
 *   { type: 'done', outlines: SceneOutline[], languageDirective: string, courseTitle?: string }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import type { AgentInfo } from '@openmaic/generation';
import type { UserRequirements, PdfImage, ImageMapping } from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import { resolveVisionImagesForPrompt } from '@/lib/persistence/resolve-vision-images';
import { StepAbortedError, StepRefusal } from '@/lib/server/generation/steps/context';
import {
  prepareOutline,
  streamOutlines,
  type OutlineEvent,
} from '@/lib/server/generation/steps/outline';
const log = createLogger('Outlines Stream');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();

    // Get API configuration from request headers/body
    const model = await resolveModelFromRequest(req, body, 'scene-outlines-stream');
    resolvedModelString = model.modelString;

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents } = body as {
      requirements: UserRequirements;
      pdfText?: string;
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      researchContext?: string;
      agents?: AgentInfo[];
    };
    requirementSnippet = requirements?.requirement?.substring(0, 60);

    let prepared;
    try {
      prepared = await prepareOutline(
        {
          requirements,
          pdfText,
          pdfImages,
          imageMapping,
          researchContext,
          agents,
          model,
          // An API client may opt out of media with an explicit `false`
          // header; `true` never turns on what the slots do not offer.
          allowImageGeneration: req.headers.get('x-image-generation-enabled') !== 'false',
          allowVideoGeneration: req.headers.get('x-video-generation-enabled') !== 'false',
        },
        {
          log,
          signal: req.signal,
          workspaceId: await requestWorkspaceId(req),
          resolveVisionImages: (images) => resolveVisionImagesForPrompt(images, req),
        },
      );
    } catch (error) {
      if (error instanceof StepRefusal) return apiError('INTERNAL_ERROR', 500, error.message);
      throw error;
    }

    // Create SSE stream with heartbeat to prevent connection timeout
    const encoder = new TextEncoder();
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const stream = new ReadableStream({
      async start(controller) {
        // Heartbeat: periodically send SSE comments to keep the connection alive.
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const startHeartbeat = () => {
          stopHeartbeat();
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`:heartbeat\n\n`));
            } catch {
              stopHeartbeat();
            }
          }, HEARTBEAT_INTERVAL_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };
        const send = (event: OutlineEvent | { type: 'done' | 'error'; [key: string]: unknown }) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

        try {
          startHeartbeat();
          const result = await streamOutlines(prepared, { log, signal: req.signal, emit: send });
          // Send done event with all outlines
          send({ type: 'done', ...result });
        } catch (error) {
          // The client disconnected: nobody is listening for an error.
          if (error instanceof StepAbortedError) return;
          send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        } finally {
          stopHeartbeat();
          // The controller may already be closed if the client disconnected.
          try {
            controller.close();
          } catch {
            // already closed — ignore
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error(
      `Outline streaming failed [requirement="${requirementSnippet ?? 'unknown'}...", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
