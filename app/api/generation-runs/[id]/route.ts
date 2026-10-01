/**
 *   GET /api/generation-runs/:id
 *     The run's snapshot, with the `seq` of its last event: follow it with
 *     `GET …/events?after=<seq>`, or poll this snapshot. Another owner's run
 *     answers the same 404 as an unknown one.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { ownerNotFound, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { isRunId, readGenerationRun, runSnapshot } from '@/lib/server/generation/run/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const run = isRunId(id) ? await readGenerationRun(id, ownerId) : null;
    if (!run) return ownerNotFound(responseHeaders);
    return withOwnerResponseHeaders(apiSuccess({ run: runSnapshot(run) }), responseHeaders);
  });
}
