/**
 *   GET /api/generation-runs/:id
 *     The run's snapshot, with the `seq` of its last event: follow it with
 *     `GET …/events?after=<seq>`, or poll this snapshot. `media` holds the
 *     state of every image and video the run has reached, by element id.
 *
 *   DELETE /api/generation-runs/:id
 *     Discard a run that has no course yet (its course card is the pending
 *     course): the run ends. A run whose course exists answers 409
 *     `RUN_STATE_CONFLICT`; deleting the course ends it instead. Repeating a
 *     discard answers the same.
 *
 * Another owner's run answers the same 404 as an unknown one.
 */
import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import {
  ownerApiError,
  ownerNotFound,
  withOwnerResponseHeaders,
} from '@/lib/server/agent-runtime/route-response';
import {
  discardGenerationRun,
  isRunId,
  readGenerationRun,
  readGenerationRunMedia,
  RunCommandConflictError,
  runSnapshot,
} from '@/lib/server/generation/run/store';
import { runMediaStates } from '@/lib/server/generation/run/media';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const run = isRunId(id) ? await readGenerationRun(id, ownerId) : null;
    if (!run) return ownerNotFound(responseHeaders);
    const media = runMediaStates(await readGenerationRunMedia(run.id));
    return withOwnerResponseHeaders(
      apiSuccess({ run: { ...runSnapshot(run), media } }),
      responseHeaders,
    );
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    if (!isRunId(id)) return ownerNotFound(responseHeaders);
    try {
      const result = await discardGenerationRun(id, ownerId);
      if (!result) return ownerNotFound(responseHeaders);
      return withOwnerResponseHeaders(apiSuccess({ ...result }), responseHeaders);
    } catch (error) {
      if (error instanceof RunCommandConflictError) {
        return ownerApiError('RUN_STATE_CONFLICT', 409, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
