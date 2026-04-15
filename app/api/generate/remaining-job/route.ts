/**
 * POST /api/generate/remaining-job
 *
 * Starts a Temporal `generateRemainingWorkflow` to generate the remaining
 * scenes (N-1) for a course after generation-preview produced the first scene.
 * Returns { jobId, pollUrl } for the client to poll.
 */

import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getTemporalClient } from '@/temporal/client';
import { TASK_QUEUE } from '@/temporal/constants';
import type { GenerateRemainingWorkflowInput } from '@/temporal/workflows/generation-preview.workflow';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('RemainingJob API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<GenerateRemainingWorkflowInput>;

    if (!body.stage?.id) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stage.id is required');
    }
    if (!Array.isArray(body.outlines) || body.outlines.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outlines is required');
    }
    if (!body.requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'requirement is required');
    }

    const input: GenerateRemainingWorkflowInput = {
      stage: body.stage,
      outlines: body.outlines,
      agents: body.agents ?? [],
      completedOrders: body.completedOrders ?? [],
      courseDescription: body.courseDescription,
      enableTTS: body.enableTTS ?? false,
      enableImageGeneration: body.enableImageGeneration ?? false,
      enableVideoGeneration: body.enableVideoGeneration ?? false,
      requirement: body.requirement,
    };

    const jobId = `preview-${body.stage.id}`;
    const baseUrl = buildRequestOrigin(req);
    const pollUrl = `${baseUrl}/api/generate/remaining-job/${jobId}`;

    const client = await getTemporalClient();

    // Start (or re-use if already running for this stageId)
    try {
      // Pass workflow type as a string to avoid name mangling during Next.js production builds.
      await client.workflow.start('generateRemainingWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId: jobId,
        args: [input],
      });
      log.info(`Started remaining-job workflow: ${jobId}`);
    } catch (err: unknown) {
      // WorkflowExecutionAlreadyStartedError — workflow already running, that's fine
      const code = (err as { code?: string })?.code;
      if (code !== 'WORKFLOW_EXECUTION_ALREADY_STARTED') {
        throw err;
      }
      log.info(`Workflow already running for: ${jobId} — polling existing job`);
    }

    return apiSuccess({ jobId, pollUrl, pollIntervalMs: 4000 }, 202);
  } catch (error) {
    log.error('Failed to start remaining-job workflow:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to start scene generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
