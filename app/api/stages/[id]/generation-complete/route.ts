/**
 * POST /api/stages/[id]/generation-complete
 *
 * Monotonically marks an existing stage outline as generation-complete.
 * Owner-only. This route deliberately performs a narrow UPDATE so a stale
 * load-time repair cannot overwrite newer classroom content.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { markStageGenerationComplete } from '@/lib/persistence/stage-meta';
import { getStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
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

      const db = await getStageAccessDb();
      const touched = await markStageGenerationComplete(db, stageId);

      if (!touched) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }

      console.info('Stage generation marked complete', { stageId, ownerId });
      return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
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
