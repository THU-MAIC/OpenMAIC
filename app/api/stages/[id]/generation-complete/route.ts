/**
 * POST /api/stages/[id]/generation-complete
 *
 * Monotonically marks an existing stage outline as generation-complete.
 * Owner-only. This route deliberately performs a narrow UPDATE so a stale
 * load-time repair cannot overwrite newer classroom content. A course its
 * generation run is still producing answers 409 `COURSE_GENERATING`: the run
 * decides when it is complete.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { markStageGenerationComplete } from '@/lib/persistence/stage-meta';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { assertCourseWritableIn } from '@/lib/server/generation/run/store';
import { resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id: stageId } = await params;
    try {
      const access = await resolveStageAccess(stageId);

      // Absent and tombstoned are the same 404 — the caller must not learn
      // that an id used to be a real course, and a deleted course has no
      // state left worth repairing.
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      // Owner only.
      if (access.ownerId !== ownerId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
      }

      const { withTransaction } = await getServerPersistenceProvider(
        process.env.DATABASE_URL ?? '',
      );
      // Under the course's ownership row, which every run commit into the
      // course takes too, so the guard's answer holds for the update.
      const touched = await withTransaction(async (tx) => {
        await tx.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [stageId]);
        await assertCourseWritableIn(tx, stageId);
        return markStageGenerationComplete(tx, stageId);
      });

      if (!touched) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      console.info('Stage generation marked complete', { stageId, ownerId });
      return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
      const refused = ownerWriteErrorResponse(error, responseHeaders);
      if (refused) return refused;
      console.error('Failed to mark stage generation complete', {
        stageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}
