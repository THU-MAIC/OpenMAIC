/**
 * GET /api/generate-classroom/capabilities — what a classroom generation job
 * on this server will do, and which uploads `POST /api/materials` accepts for
 * it. Read-only and owner-free; it sits behind the same access-code gate as
 * every other API route.
 *
 * Every fact is derived, never restated: the capabilities are the ones the
 * generation pipeline itself reads, and the formats and byte caps are the
 * upload route's own policy and limits, and `maxCount` is the most
 * `materialIds` one generation request accepts.
 */
import { apiSuccess } from '@/lib/server/api-response';
import { MAX_CLASSROOM_MATERIALS } from '@/lib/server/classroom-materials';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import {
  MATERIAL_DOCUMENT_UPLOAD_LIMIT,
  MATERIAL_MEDIA_UPLOAD_LIMIT,
} from '@/lib/server/materials/upload-limits';
import { WORKBENCH_MATERIAL_FORMATS } from '@/lib/workbench/material-upload-policy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return apiSuccess({
    capabilities: resolveServerGenerationCapabilities(),
    materials: {
      formats: WORKBENCH_MATERIAL_FORMATS,
      maxCount: MAX_CLASSROOM_MATERIALS,
      maxDocumentBytes: MATERIAL_DOCUMENT_UPLOAD_LIMIT,
      maxMediaBytes: MATERIAL_MEDIA_UPLOAD_LIMIT,
    },
  });
}
