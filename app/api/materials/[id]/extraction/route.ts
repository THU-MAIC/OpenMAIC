/** Start one owner's source extraction; the existing worker scanner claims it. */
import type { NextRequest } from 'next/server';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { ensureOwnerMaterialExtraction } from '@/lib/persistence/owner-material-extraction';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  libraryNotFound,
  libraryPersistence,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const persistence = await libraryPersistence();
      const outcome = await ensureOwnerMaterialExtraction(
        persistence.withTransaction,
        ownerId,
        id,
        { fence: 'request' },
      );
      // As with extract_material, queueing is enough: instrumentation starts the scanner.
      return outcome ? ownerJson(outcome, 200, headers) : libraryNotFound(headers);
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
