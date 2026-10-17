/**
 * GET /api/materials/[id]/original — the original file of a source in the
 * request owner's library, for the library page's "open the original"
 * (RFC #1716 §7).
 *
 * A thin adapter over the shared reader (`readOwnerMaterialBytes`): pool
 * first, then a retained old object that matches its recorded digest. The row
 * is read under the request owner, ready and not deleted, and must be a
 * source; a missing, another owner's, deleted or derived material answers the
 * plain 404 every agent-runtime route uses. Bytes that cannot be read answer
 * 503 `unavailable`. Images, audio and video open inline; every other type
 * downloads (see `lib/server/materials/original-response.ts`).
 *
 * Gated like the rest of `/api/materials`: without the configured agent
 * runtime it answers a plain 404.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { materialDisplayName } from '@/lib/persistence/material-library';
import { getReadyOwnerMaterials } from '@/lib/persistence/owner-materials';
import { ownerNotFound, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  libraryPersistence,
  libraryRefusal,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';
import {
  OwnerMaterialBytesUnavailableError,
  readOwnerMaterialBytes,
} from '@/lib/server/materials/owner-material-bytes';
import {
  originalDownloadName,
  originalResponseHeaders,
} from '@/lib/server/materials/original-response';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const { pool } = await libraryPersistence();
    const [record] = await getReadyOwnerMaterials(pool, ownerId, [id]);
    if (!record || record.kind !== 'source') return ownerNotFound(headers);
    // Served under the name it shows now; original_name stays the uploaded name.
    const displayName = await materialDisplayName(pool, ownerId, id);
    if (displayName === undefined) return ownerNotFound(headers);
    const fileName = originalDownloadName(displayName, record.originalName);
    let bytes: Buffer;
    try {
      bytes = await readOwnerMaterialBytes(record);
    } catch (error) {
      if (error instanceof OwnerMaterialBytesUnavailableError) {
        return libraryRefusal(
          503,
          'unavailable',
          'The original file cannot be read',
          headers,
          {},
          'ASSET_NOT_FOUND',
        );
      }
      // The reader's fenced re-read waits on the owner's identity lock: busy is 503.
      return libraryWriteError(error, headers);
    }
    return withOwnerResponseHeaders(
      new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: originalResponseHeaders({
          materialId: record.id,
          mime: record.mime,
          originalName: fileName,
          byteLength: bytes.byteLength,
        }),
      }),
      headers,
    );
  });
}
