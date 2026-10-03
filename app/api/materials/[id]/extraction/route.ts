/**
 * POST /api/materials/[id]/extraction — extract one of the caller's own
 * library uploads again after its extraction failed (the composer's Retry),
 * or start one that never started (`idle`). Answers the material as
 * `GET /api/materials/[id]` does, now `extracting`. An extraction that is
 * running or ready is left as it is (`409`); an id the owner does not have
 * answers a plain 404. Needs only server persistence.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import {
  getOwnerMaterial,
  publicMaterial,
  startOwnerMaterialExtractions,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { ownerApiError, ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { isMaterialId } from '@/lib/server/materials/material-id';
import { wakeOwnerMaterialExtractor } from '@/lib/server/materials/extractor-wake';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    if (!isMaterialId(id)) return ownerNotFound(responseHeaders);
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const started = await startOwnerMaterialExtractions(pool, ownerId, [id], ['failed', 'idle']);
    const record = await getOwnerMaterial(pool, ownerId, id);
    if (!record) return ownerNotFound(responseHeaders);
    if (started.length === 0) {
      return ownerApiError(
        'INVALID_REQUEST',
        409,
        `The material's extraction is ${record.extraction?.status ?? 'idle'}`,
        responseHeaders,
      );
    }
    wakeOwnerMaterialExtractor();
    return ownerJson({ material: publicMaterial(record) }, 200, responseHeaders);
  });
}
