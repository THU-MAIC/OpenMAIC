/**
 *   POST /api/generate-classroom
 *     Start a classroom generation job: `{ requirement, materialIds? }`. The
 *     job is a generation run (`lib/server/generate-classroom-job.ts`) of the
 *     request owner, with the outline confirmed automatically. 202 with the
 *     job; 400 for a body it cannot generate from, or when a model the run
 *     needs (outline, actions, content for some scene type) is not
 *     configured or cannot be built; 429 `ACTIVE_RUN_LIMIT` when the owner
 *     already has the configured number of runs in progress; a host's
 *     `authorizeStart` hook may refuse it last, with its own status and code.
 */
import { type NextRequest } from 'next/server';
import { apiSuccess } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import {
  classroomJobView,
  requiredModelRefusal,
  parseClassroomJobBody,
} from '@/lib/server/generate-classroom-job';
import { MAX_START_BODY_BYTES, readJsonBody } from '@/lib/server/generation/run/input';
import { startGenerationRun, startRefusal } from '@/lib/server/generation/run/start';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  // Materials are owner-scoped, so the run is the request owner's: the same
  // owner that uploaded them. The owner is resolved before anything else so
  // every response, including a 400, carries its cookies (see
  // `withRequestOwner`).
  return withRequestOwner(req, async (principal, responseHeaders) => {
    const { ownerId } = principal;
    const body = await readJsonBody(req, MAX_START_BODY_BYTES);
    if (!body.ok) {
      return ownerApiError('INVALID_REQUEST', body.status, body.message, responseHeaders);
    }
    const parsed = parseClassroomJobBody(body.value);
    if (!parsed.ok) return ownerApiError(parsed.code, 400, parsed.message, responseHeaders);
    const input = parsed.input;

    try {
      const refused = await requiredModelRefusal(ownerId);
      if (refused) return ownerApiError(refused.code, 400, refused.message, responseHeaders);

      const run = await startGenerationRun(ownerId, input, {
        principal,
        request: req,
        origin: 'generate-classroom',
      });
      return withOwnerResponseHeaders(
        apiSuccess(classroomJobView(run, {}, buildRequestOrigin(req)), 202),
        responseHeaders,
      );
    } catch (error) {
      const refusal = startRefusal(error);
      if (refusal) {
        const response = ownerApiError(
          refusal.code,
          refusal.status,
          refusal.message,
          responseHeaders,
        );
        for (const [key, value] of refusal.headers ?? []) response.headers.append(key, value);
        return response;
      }
      log.error(
        `Classroom generation job creation failed [requirement="${input.requirement.substring(0, 60)}..."]:`,
        error,
      );
      // The error is logged above; its text (a database error, say) stays off the wire.
      return ownerApiError(
        'INTERNAL_ERROR',
        500,
        'Failed to create classroom generation job',
        responseHeaders,
      );
    }
  });
}
