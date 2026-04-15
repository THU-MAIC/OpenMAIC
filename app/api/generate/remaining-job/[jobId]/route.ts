/**
 * GET /api/generate/remaining-job/[jobId]
 *
 * Polls the status of a `generateRemainingWorkflow` Temporal workflow.
 * The client uses the returned `scenesGenerated` and `done` fields to
 * determine when to refresh the course from Supabase.
 */

import { type NextRequest } from 'next/server';
import { WorkflowNotFoundError } from '@temporalio/client';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getTemporalClient } from '@/temporal/client';
import { getPreviewStatusQuery } from '@/temporal/workflows/generation-preview.workflow';
import { createLogger } from '@/lib/logger';

const log = createLogger('RemainingJob Poll API');

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;

  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid jobId');
  }

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(jobId);

    let workflowStatus;
    try {
      workflowStatus = await handle.query(getPreviewStatusQuery);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        return apiError('INVALID_REQUEST', 404, 'Job not found');
      }
      throw err;
    }

    return apiSuccess({
      jobId,
      status: workflowStatus.status,
      step: workflowStatus.step,
      progress: workflowStatus.progress,
      message: workflowStatus.message,
      scenesGenerated: workflowStatus.scenesGenerated,
      totalPending: workflowStatus.totalPending,
      completedScenes: workflowStatus.completedScenes,
      done: workflowStatus.done,
      error: workflowStatus.error,
    });
  } catch (error) {
    log.error(`Poll failed [jobId=${jobId}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to poll job status',
      error instanceof Error ? error.message : String(error),
    );
  }
}
