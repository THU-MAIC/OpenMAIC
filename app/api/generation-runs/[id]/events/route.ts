/**
 *   GET /api/generation-runs/:id/events?after=<seq>
 *     The run's ordered event log over SSE: every event with a `seq` above
 *     `after` (or `Last-Event-ID`, which a reconnecting `EventSource` sends),
 *     one `caught_up` frame when the backlog is drained, then each event as
 *     it commits (outline items stream as the model writes them). Frames
 *     carry `id: <seq>`. The stream stays open with a heartbeat; a client that
 *     cannot hold one polls `GET /api/generation-runs/:id` instead. A
 *     finished run keeps only its final events: a cursor behind them gets a
 *     `resync` frame (reload the snapshot), then the events it keeps.
 *
 * Another owner's run answers the same 404 as an unknown one; an owner
 * holding too many run streams gets 429. The stream only reads: closing it
 * never affects the run.
 */
import type { NextRequest } from 'next/server';

import {
  isRunId,
  readGenerationRun,
  readGenerationRunEvents,
} from '@/lib/server/generation/run/store';
import {
  acquireRunStreamSlot,
  polledEventStream,
  sseFrame,
  sseHeaders,
} from '@/lib/server/generation/run/sse';
import { authenticateRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The fallback poll: NOTIFY wakes the stream within ~100 ms; this catches a lost one. */
export const RUN_EVENTS_POLL_INTERVAL_MS = 5_000;
const PAGE = 500;

function parseCursor(value: string | null): number {
  return value && /^\d{1,15}$/.test(value) ? Number(value) : 0;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await authenticateRequestOwner(req);
  if (!owner.ok) return owner.response;
  const { principal, responseHeaders } = owner;
  const run = isRunId(id) ? await readGenerationRun(id, principal.ownerId) : null;
  if (!run) return new Response('Not found', { status: 404, headers: responseHeaders });
  const release = acquireRunStreamSlot(principal.ownerId);
  if (!release) {
    responseHeaders.set('Retry-After', '5');
    return new Response('Too many open generation run streams', {
      status: 429,
      headers: responseHeaders,
    });
  }

  const url = new URL(req.url);
  let cursor = parseCursor(req.headers.get('last-event-id') ?? url.searchParams.get('after'));
  const from = cursor;
  let caughtUp = false;

  const stream = polledEventStream({
    wakeup: { kind: 'generation-run', runId: id },
    pollIntervalMs: RUN_EVENTS_POLL_INTERVAL_MS,
    onClose: release,
    signal: req.signal,
    read: async (write) => {
      for (;;) {
        const page = await readGenerationRunEvents(id, cursor, PAGE);
        // A gap after the cursor means the events were compacted away (a
        // finished run keeps its final ones): the client reloads the
        // snapshot, then follows on from what is kept.
        if (page.length > 0 && page[0]!.seq > cursor + 1) {
          if (
            !write(
              sseFrame('resync', {
                type: 'resync',
                reason: 'compacted',
                from: cursor,
                snapshot: `/api/generation-runs/${id}`,
                oldestSeq: page[0]!.seq,
              }),
            )
          ) {
            return;
          }
          cursor = page[0]!.seq - 1;
        }
        for (const event of page) {
          if (
            !write(
              sseFrame(event.type, { ...event, phase: caughtUp ? 'live' : 'backlog' }, event.seq),
            )
          ) {
            return;
          }
          cursor = event.seq;
        }
        if (page.length < PAGE) break;
      }
      if (!caughtUp) {
        caughtUp = write(sseFrame('caught_up', { type: 'caught_up', from, seq: cursor }));
      }
    },
  });
  return new Response(stream, { headers: sseHeaders(responseHeaders) });
}
