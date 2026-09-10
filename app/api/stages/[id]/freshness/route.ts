/**
 * GET /api/stages/[id]/freshness — volatile freshness SSE for one course (the
 * reference's `stages/:id/freshness`, ported onto the owner-bound store).
 *
 * The workbench's push side: when the stage's revision moves, this stream
 * sends the client one frame carrying the current `rev`; the client reacts by
 * pulling the manifest and re-fetching only the scenes that changed.
 *
 * The reference woke this stream from a DB trigger's NOTIFY; the upstream
 * storage package exposes no LISTEN/NOTIFY, so this stream POLLS the
 * owner-bound store for the stage's trigger-maintained revision (the same
 * correctness mechanism as `app/api/agent/owner-events/route.ts`). A frame is
 * emitted when the rev moves; the first frame is sent on connect. `rev` is the
 * per-stage monotonic revision the manifest exposes, so a frame that arrives
 * always reflects the same signal the manifest serves.
 *
 * Degradation is by design: this stream is a pure optimization. A dead or
 * missing stream only costs latency — the client's low-frequency fallback
 * poll still converges. Conventions mirror the sibling SSE routes: a 25s
 * heartbeat comment frame keeps intermediaries from ending the stream, an
 * explicit `retry:` hint sets the browser's reconnect delay, the stream never
 * closes on a terminal state, and a broken socket is the client's
 * EventSource problem, not this route's.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerNotFound } from '@/lib/server/agent-runtime/route-response';

export const runtime = 'nodejs';
// Self-hosted `next start` ignores maxDuration; Vercel's adapter can still use
// it. The 25s heartbeat keeps this sparse stream active through idle periods.
export const maxDuration = 300;

/** How often the stream re-checks the stage's revision. */
export const STAGE_FRESHNESS_POLL_INTERVAL_MS = 5_000;
/** Same ceiling as the sibling SSE streams. */
export const STAGE_FRESHNESS_HEARTBEAT_MS = 25_000;
/** Browser reconnect delay, sent as the SSE `retry:` field. */
export const STAGE_FRESHNESS_RETRY_MS = 3_000;

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(req, responseHeaders);
  const { id: stageId } = await params;

  // Existence-gated, exactly like the manifest route: the owner-bound store
  // reads a foreign or missing stage as absent, and the 404 carries the
  // owner cookie the same way every response of this family does.
  const store = await getOwnerScopedDocumentStore(ownerId);
  const initial = await store.readFreshnessManifest(stageId);
  if (!initial) return ownerNotFound(responseHeaders);

  const encoder = new TextEncoder();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const clearTimers = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // A broken socket is not guaranteed to invoke cancel() in every
          // runtime; stop the timers the moment enqueue proves it closed.
          closed = true;
          clearTimers();
          return false;
        }
      };

      let lastRev = 0;

      // The frame carries the current rev so a client that wants to skip the
      // manifest round-trip when nothing changed can, but the contract is
      // "pull the manifest on every frame" — rev is informational, never
      // authoritative. A read failure sends rev 0 (never a terminal state: a
      // stage can always be written again), matching the reference.
      const emitFreshness = async () => {
        if (closed) return;
        let rev = 0;
        try {
          const manifest = await store.readFreshnessManifest(stageId);
          rev = manifest ? manifest.rev : 0;
        } catch {
          // Fall through to the rev-0 frame.
        }
        if (rev === lastRev) return;
        lastRev = rev;
        write(
          `event: stage_freshness\ndata: ${JSON.stringify({
            type: 'stage_freshness',
            stageId,
            rev,
          })}\n\n`,
        );
      };

      // Chained setTimeout: the next poll is scheduled only after the previous
      // read settles, so polls can never overlap.
      const schedulePoll = () => {
        if (closed) return;
        pollTimer = setTimeout(async () => {
          try {
            await emitFreshness();
          } finally {
            schedulePoll();
          }
        }, STAGE_FRESHNESS_POLL_INTERVAL_MS);
      };

      // Reconnect hint + the first frame of the stream.
      write(`retry: ${STAGE_FRESHNESS_RETRY_MS}\n\n`);
      await emitFreshness();

      heartbeatTimer = setInterval(() => {
        if (closed) return;
        write(': ping\n\n');
      }, STAGE_FRESHNESS_HEARTBEAT_MS);
      schedulePoll();
    },
    cancel() {
      closed = true;
      clearTimers();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...Object.fromEntries(responseHeaders),
    },
  });
}
