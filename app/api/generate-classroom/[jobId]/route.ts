/**
 *   GET /api/generate-classroom/:jobId
 *     The job, read from its generation run (the job id is the run id); see
 *     `lib/server/generate-classroom-job.ts` for how run states map onto job
 *     statuses. Only the owner that created the job (or the account it was
 *     claimed into) may poll it; for anyone else it is the same 404 as an
 *     unknown id.
 */
import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { classroomJobView } from '@/lib/server/generate-classroom-job';
import { runMediaStates } from '@/lib/server/generation/run/media';
import { isRunId, readGenerationRunWithMedia } from '@/lib/server/generation/run/store';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomJob API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
  }

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      // The run and its media in one read, so the two agree.
      const read = isRunId(jobId) ? await readGenerationRunWithMedia(jobId, ownerId) : null;
      if (!read) {
        return ownerApiError(
          'INVALID_REQUEST',
          404,
          'Classroom generation job not found',
          responseHeaders,
        );
      }
      return withOwnerResponseHeaders(
        apiSuccess(classroomJobView(read.run, runMediaStates(read.media), buildRequestOrigin(req))),
        responseHeaders,
      );
    } catch (error) {
      log.error(`Classroom job retrieval failed [jobId=${jobId}]:`, error);
      return ownerApiError(
        'INTERNAL_ERROR',
        500,
        'Failed to retrieve classroom generation job',
        responseHeaders,
      );
    }
  });
}
