import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import {
  ClassroomMaterialsRejectedError,
  MAX_CLASSROOM_MATERIALS,
  resolveClassroomMaterials,
} from '@/lib/server/classroom-materials';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { isMaterialId } from '@/lib/server/materials/material-id';
import { ownerApiError, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { WorkspaceEndpointError } from '@/lib/server/model-config/media';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

const PDF_CONTENT_REMOVED_MESSAGE =
  'pdfContent is no longer accepted: upload the document with POST /api/materials and pass the returned materialId in materialIds';

const INVALID_MATERIAL_IDS_MESSAGE = `materialIds must be an array of at most ${MAX_CLASSROOM_MATERIALS} material ids`;

type ParsedBody =
  | { ok: true; input: GenerateClassroomInput }
  | { ok: false; code: 'INVALID_REQUEST' | 'MISSING_REQUIRED_FIELD'; message: string };

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
    return { ok: false, code: 'INVALID_REQUEST', message: PDF_CONTENT_REMOVED_MESSAGE };
  }

  const requirement = body.requirement;
  if (typeof requirement !== 'string' || !requirement) {
    return {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Missing required field: requirement',
    };
  }

  if (body.materialIds === undefined) return { ok: true, input: { requirement } };
  if (
    !Array.isArray(body.materialIds) ||
    body.materialIds.some((id) => typeof id !== 'string' || !isMaterialId(id.trim()))
  ) {
    return { ok: false, code: 'INVALID_REQUEST', message: INVALID_MATERIAL_IDS_MESSAGE };
  }
  const materialIds = [...new Set((body.materialIds as string[]).map((id) => id.trim()))];
  if (materialIds.length > MAX_CLASSROOM_MATERIALS) {
    return { ok: false, code: 'INVALID_REQUEST', message: INVALID_MATERIAL_IDS_MESSAGE };
  }
  return {
    ok: true,
    input: { requirement, ...(materialIds.length ? { materialIds } : {}) },
  };
}

export async function POST(req: NextRequest) {
  // Materials are owner-scoped, so generation runs as the request owner: the
  // same owner that uploaded them. The owner is resolved before anything else
  // so every response, including a 400, carries its cookies (see
  // `withRequestOwner`).
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return ownerApiError('INVALID_REQUEST', 400, 'Invalid JSON body', responseHeaders);
    }
    const parsed = parseBody(raw);
    if (!parsed.ok) return ownerApiError(parsed.code, 400, parsed.message, responseHeaders);
    const body = parsed.input;

    try {
      if (body.materialIds) {
        try {
          await resolveClassroomMaterials(ownerId, body.materialIds, { forward: false });
        } catch (error) {
          if (error instanceof ClassroomMaterialsRejectedError) {
            return ownerApiError('INVALID_REQUEST', 400, error.message, responseHeaders);
          }
          // A document or speech service this workspace may not use.
          if (error instanceof WorkspaceEndpointError) {
            return ownerApiError('INVALID_URL', 403, error.message, responseHeaders);
          }
          throw error;
        }
      }

      const baseUrl = buildRequestOrigin(req);
      const jobId = nanoid(10);
      const job = await createClassroomGenerationJob(jobId, body, { ownerId });
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
