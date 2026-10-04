import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidClassroomJobId,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
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

    // Only the owner that created the job may poll it; for anyone else it is
    // the same 404 as an unknown id.
    return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
      try {
        const job = await readClassroomGenerationJob(jobId, ownerId);
        if (!job) {
          return ownerApiError(
            'INVALID_REQUEST',
            404,
            'Classroom generation job not found',
            responseHeaders,
          );
        }

        const pollUrl = `${buildRequestOrigin(req)}/api/generate-classroom/${jobId}`;

        return withOwnerResponseHeaders(
          apiSuccess({
            jobId: job.id,
            status: job.status,
            step: job.step,
            progress: job.progress,
            message: job.message,
            pollUrl,
            pollIntervalMs: 5000,
            scenesGenerated: job.scenesGenerated,
            totalScenes: job.totalScenes,
            result: job.result,
            error: job.error,
            done: job.status === 'succeeded' || job.status === 'failed',
          }),
          responseHeaders,
        );
      } catch (error) {
        log.error(`Classroom job retrieval failed [jobId=${jobId}]:`, error);
        return ownerApiError(
          'INTERNAL_ERROR',
          500,
          'Failed to retrieve classroom generation job',
          responseHeaders,
          error instanceof Error ? error.message : String(error),
        );
      }
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
