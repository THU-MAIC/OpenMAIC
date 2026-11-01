import { usesClassicExtraction } from '@/lib/persistence/material-extraction-format';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import {
  getOwnerMaterial,
  publicMaterial,
  startOwnerMaterialExtractions,
} from '@/lib/persistence/owner-materials';
/** Start one owner's source extraction; the existing worker scanner claims it. */
import { wakeOwnerMaterialExtractor } from '@/lib/server/materials/extractor-wake';
import type { NextRequest } from 'next/server';
import {
  isServerPersistenceConfigured,
  isAgentRuntimeConfigured,
} from '@/lib/config/feature-flags';
import { ensureOwnerMaterialExtraction } from '@/lib/persistence/owner-material-extraction';
import { ownerJson, ownerApiError } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  libraryNotFound,
  libraryPersistence,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const persistence = await libraryPersistence();
      const record = await persistence.withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return getOwnerMaterial(tx, ownerId, id);
      });
      if (!record || record.kind !== 'source' || record.derivedFrom)
        return libraryNotFound(headers);
      if (usesClassicExtraction(record)) {
        const started = await startOwnerMaterialExtractions(
          persistence.pool,
          ownerId,
          [id],
          ['idle', 'failed'],
        );
        if (!started.length)
          return ownerApiError(
            'INVALID_REQUEST',
            409,
            `The material's extraction is ${record.extraction?.status ?? 'idle'}`,
            headers,
          );
        wakeOwnerMaterialExtractor();
        const current = await getOwnerMaterial(persistence.pool, ownerId, id);
        return current
          ? ownerJson({ material: publicMaterial(current) }, 200, headers)
          : libraryNotFound(headers);
      }
      if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404, headers });
      const outcome = await ensureOwnerMaterialExtraction(
        persistence.withTransaction,
        ownerId,
        id,
        { fence: 'request' },
      );
      // As with extract_material, queueing is enough: instrumentation starts the scanner.
      if (!outcome) return libraryNotFound(headers);
      return ownerJson(outcome, 200, headers);
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
