/**
 * GET /api/generate-classroom/capabilities — what a classroom generation job
 * on this server is configured to do, and which uploads it can generate from.
 * Read-only and owner-free; it sits behind the same access-code gate as every
 * other API route.
 *
 * Every fact is derived, never restated: `capabilities` is what the generation
 * pipeline itself reads; `formats` are the upload policy's formats that an
 * extractor available on this server can read (the same check a submission's
 * `materialIds` must pass); the byte caps are the upload route's own limits;
 * `maxCount` and `maxTotalBytes` bound one request's `materialIds`.
 */
import type { NextRequest } from 'next/server';

import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import { apiSuccess } from '@/lib/server/api-response';
import {
  MAX_CLASSROOM_MATERIAL_TOTAL_BYTES,
  MAX_CLASSROOM_MATERIALS,
} from '@/lib/server/classroom-materials';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import { resolveExtractableMimeTypes } from '@/lib/server/material-extraction/availability';
import {
  MATERIAL_DOCUMENT_UPLOAD_LIMIT,
  MATERIAL_MEDIA_UPLOAD_LIMIT,
} from '@/lib/server/materials/upload-limits';
import { WORKBENCH_MATERIAL_FORMATS } from '@/lib/workbench/material-upload-policy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // The formats this caller's document and speech services can read.
  const workspaceId = await requestWorkspaceId(req);
  const extractable = await resolveExtractableMimeTypes({
    ownerId: workspaceId ?? undefined,
    forward: false,
  });
  return apiSuccess({
    capabilities: await resolveServerGenerationCapabilities(workspaceId),
    materials: {
      formats: WORKBENCH_MATERIAL_FORMATS.filter((format) => extractable.has(format.mime)),
      maxCount: MAX_CLASSROOM_MATERIALS,
      maxTotalBytes: MAX_CLASSROOM_MATERIAL_TOTAL_BYTES,
      maxDocumentBytes: MATERIAL_DOCUMENT_UPLOAD_LIMIT,
      maxMediaBytes: MATERIAL_MEDIA_UPLOAD_LIMIT,
    },
  });
}
