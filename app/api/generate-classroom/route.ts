import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import {
  ClassroomMaterialsUnavailableError,
  MAX_CLASSROOM_MATERIALS,
  resolveClassroomMaterials,
} from '@/lib/server/classroom-materials';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

const PDF_CONTENT_REMOVED_MESSAGE =
  'pdfContent is no longer accepted: upload the document with POST /api/materials and pass the returned materialId in materialIds';

const INVALID_MATERIAL_IDS_MESSAGE = `materialIds must be an array of at most ${MAX_CLASSROOM_MATERIALS} non-empty strings`;

type ParsedBody = { ok: true; input: GenerateClassroomInput } | { ok: false; response: Response };

/**
 * The request body is `{ requirement, materialIds? }`. Optional capabilities
 * are not request fields (they follow the server's provider configuration),
 * and other unknown fields are ignored. The one removed field that is refused
 * rather than ignored is `pdfContent`: ignoring it would silently generate
 * without the caller's document.
 */
function parseBody(raw: unknown): ParsedBody {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (body.pdfContent !== undefined) {
    return { ok: false, response: apiError('INVALID_REQUEST', 400, PDF_CONTENT_REMOVED_MESSAGE) };
  }

  const requirement = body.requirement;
  if (typeof requirement !== 'string' || !requirement) {
    return {
      ok: false,
      response: apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement'),
    };
  }

  if (body.materialIds === undefined) return { ok: true, input: { requirement } };
  if (
    !Array.isArray(body.materialIds) ||
    body.materialIds.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    return { ok: false, response: apiError('INVALID_REQUEST', 400, INVALID_MATERIAL_IDS_MESSAGE) };
  }
  const materialIds = [...new Set((body.materialIds as string[]).map((id) => id.trim()))];
  if (materialIds.length > MAX_CLASSROOM_MATERIALS) {
    return { ok: false, response: apiError('INVALID_REQUEST', 400, INVALID_MATERIAL_IDS_MESSAGE) };
  }
  return {
    ok: true,
    input: { requirement, ...(materialIds.length ? { materialIds } : {}) },
  };
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return parsed.response;
  const body = parsed.input;

  // Materials are owner-scoped, so generation runs as the request owner: the
  // same owner that uploaded them (see `withRequestOwner` for how a request
  // resolves one, and why every response carries its cookies).
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      if (body.materialIds) {
        try {
          await resolveClassroomMaterials(ownerId, body.materialIds);
        } catch (error) {
          if (error instanceof ClassroomMaterialsUnavailableError) {
            return ownerApiError('INVALID_REQUEST', 400, error.message, responseHeaders);
          }
          throw error;
        }
      }

      const baseUrl = buildRequestOrigin(req);
      const jobId = nanoid(10);
      const job = await createClassroomGenerationJob(jobId, body);
      const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

      after(() => runClassroomGenerationJob(jobId, body, baseUrl, { ownerId }));

      return withOwnerResponseHeaders(
        apiSuccess(
          {
            jobId,
            status: job.status,
            step: job.step,
            message: job.message,
            pollUrl,
            pollIntervalMs: 5000,
          },
          202,
        ),
        responseHeaders,
      );
    } catch (error) {
      log.error(
        `Classroom generation job creation failed [requirement="${body.requirement.substring(0, 60)}..."]:`,
        error,
      );
      return ownerApiError(
        'INTERNAL_ERROR',
        500,
        'Failed to create classroom generation job',
        responseHeaders,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  });
}
