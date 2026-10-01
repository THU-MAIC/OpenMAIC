/**
 *   GET /api/generation-runs/events
 *     The owner's run changes over SSE, for course lists: one `runs` frame
 *     with every active run at attach, then a `run` frame with a run's
 *     snapshot each time it changes (state, progress, its course appearing),
 *     including the change that completes or ends it. Woken by the same
 *     `NOTIFY` as the run's own commits, with a fallback poll.
 */
import type { NextRequest } from 'next/server';

import {
  listActiveGenerationRuns,
  listGenerationRunsUpdatedSince,
  runSnapshot,
} from '@/lib/server/generation/run/store';
import { polledEventStream, sseFrame, sseHeaders } from '@/lib/server/generation/run/sse';
import { authenticateRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const OWNER_RUN_EVENTS_POLL_INTERVAL_MS = 30_000;
/**
 * How far before the newest change already sent each read looks back: a
 * transaction's `updated_at` is its start, so one that committed late can
 * carry an older stamp than a change already seen.
 */
const COMMIT_SKEW_MS = 60_000;

export async function GET(req: NextRequest) {
  const owner = await authenticateRequestOwner(req);
  if (!owner.ok) return owner.response;
  const { principal, responseHeaders } = owner;
  const ownerId = principal.ownerId;
  // The last seq sent per run: a run is sent again only when it moved on.
  const sent = new Map<string, number>();
  let newest = Date.now();

  const stream = polledEventStream({
    wakeup: { kind: 'generation-run-owner', ownerId },
    pollIntervalMs: OWNER_RUN_EVENTS_POLL_INTERVAL_MS,
    read: async (write, phase) => {
      if (phase === 'backlog') {
        const active = await listActiveGenerationRuns(ownerId);
        for (const run of active) sent.set(run.id, run.seq);
        write(sseFrame('runs', { type: 'runs', runs: active.map(runSnapshot) }));
        return;
      }
      const changed = await listGenerationRunsUpdatedSince(
        ownerId,
        new Date(newest - COMMIT_SKEW_MS),
      );
      for (const run of changed) {
        newest = Math.max(newest, Date.parse(run.updatedAt));
        if ((sent.get(run.id) ?? -1) >= run.seq) continue;
        if (!write(sseFrame('run', { type: 'run', run: runSnapshot(run) }))) return;
        sent.set(run.id, run.seq);
      }
    },
  });
  return new Response(stream, { headers: sseHeaders(responseHeaders) });
}
