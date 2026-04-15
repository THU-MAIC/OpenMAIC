import { type NextRequest } from 'next/server';
import { WorkflowNotFoundError } from '@temporalio/client';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';

function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}
import { getTemporalClient } from '@/temporal/client';
import { getStatusQuery } from '@/temporal/workflows/classroom-generation.workflow';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomJob API');

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  let resolvedJobId: string | undefined;
  try {
    const { jobId } = await context.params;
    resolvedJobId = jobId;

    if (!isValidClassroomJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(jobId);

    let workflowStatus;
    try {
      workflowStatus = await handle.query(getStatusQuery);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
      }
      throw err;
    }

    const pollUrl = `${buildRequestOrigin(req)}/api/generate-classroom/${jobId}`;

    return apiSuccess({
      jobId,
      status: workflowStatus.status,
      step: workflowStatus.step,
      progress: workflowStatus.progress,
      message: workflowStatus.message,
      pollUrl,
      pollIntervalMs: 5000,
      scenesGenerated: workflowStatus.scenesGenerated,
      totalScenes: workflowStatus.totalScenes,
      result: workflowStatus.result,
      error: workflowStatus.error,
      done: workflowStatus.done,
    });
  } catch (error) {
    log.error(`Classroom job retrieval failed [jobId=${resolvedJobId ?? 'unknown'}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve classroom generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
