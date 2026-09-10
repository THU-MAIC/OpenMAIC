/**
 * Durable, sparse SSE tail for the current owner's session summaries.
 * A degraded caught_up is not authoritative: clients should schedule one full
 * reconciliation and may later receive a non-degraded caught_up on recovery.
 *
 * Access model: there is no per-route auth challenge. Every request is
 * granted an anonymous cookie identity, and every store read is scoped to
 * that identity.
 */
import type { PersistedOwnerSessionEvent } from '@openmaic/storage';
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { subscribeAgentEventWakeup } from '@/lib/server/agent-runtime/event-notify-bus';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

export const runtime = 'nodejs';
// Self-hosted `next start` ignores maxDuration; Vercel's adapter can still use
// it. The 25s heartbeat keeps this sparse stream active through idle periods.
export const maxDuration = 300;

// LISTEN/NOTIFY supplies low latency. This is deliberately retained as a
// correctness fallback because NOTIFY is lossy across listener disconnects.
export const OWNER_EVENT_POLL_INTERVAL_MS = 30_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
export const OWNER_EVENT_REPLAY_LIMIT = 1_000;
const BACKLOG_PAGE = 500;

function parseLastEventId(value: string | null): bigint {
  if (!value || !/^\d+$/.test(value)) return BigInt(0);
  try {
    return BigInt(value);
  } catch {
    return BigInt(0);
  }
}

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  // Identity belongs to the request, not the URL. EventSource reconnects to
  // this same stable path with the anonymous cookie minted on first attach.
  // This slice resolves only the anonymous cookie identity; a future auth
  // integration must thread `authenticatedOwnerId` through here, or sessions
  // created under authenticated identities would be unreachable by their own
  // owner.
  const responseHeaders = new Headers();
  const ownerId = resolveRequestOwnerId(req, responseHeaders);
  const store = await getAgentSessionStore();

  const url = new URL(req.url);
  const lastEventId = parseLastEventId(
    req.headers.get('last-event-id') ?? url.searchParams.get('lastEventId'),
  );
  const encoder = new TextEncoder();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeWakeup: (() => void) | null = null;
  let closed = false;

  const clearTimers = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
    unsubscribeWakeup?.();
    unsubscribeWakeup = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let backlogDone = false;
      let sentSinceAttach = 0;
      let cursor = lastEventId;
      let retirementCheckInFlight = false;
      let consecutiveBacklogFailures = 0;
      let degradedCaughtUp = false;
      let attachCursorChecked = false;
      let backlogSkippedForResync = false;
      let initializing = true;
      let wakeDuringInitialization = false;
      let repollRequested = false;
      let pollInFlight: Promise<void> | null = null;

      const write = (chunk: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // Some runtimes do not invoke cancel() for every broken socket.
          // Treat an enqueue failure as closure so this dead connection cannot
          // retain its heartbeat and poll timers indefinitely.
          closed = true;
          clearTimers();
          return false;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        clearTimers();
        try {
          controller.close();
        } catch {
          // The request closed between the guard and close.
        }
      };

      const emitCaughtUp = (degraded = false) =>
        write(
          `event: caught_up\ndata: ${JSON.stringify({
            type: 'caught_up',
            replayed: sentSinceAttach,
            fromEventId: lastEventId.toString(),
            ...(degraded ? { degraded: true } : {}),
          })}\n\n`,
        );

      const markCaughtUp = (degraded = false) => {
        if (backlogDone) return;
        if (!emitCaughtUp(degraded)) return;
        backlogDone = true;
        degradedCaughtUp = degraded;
      };

      const checkAttachCursor = async () => {
        if (attachCursorChecked) return true;
        let currentEventId: bigint;
        try {
          currentEventId = await store.readMaxId(ownerId);
        } catch {
          consecutiveBacklogFailures += 1;
          if (consecutiveBacklogFailures >= 3) markCaughtUp(true);
          return false;
        }
        consecutiveBacklogFailures = 0;
        attachCursorChecked = true;

        const reason =
          lastEventId > currentEventId
            ? 'cursor_ahead'
            : currentEventId - lastEventId > BigInt(OWNER_EVENT_REPLAY_LIMIT)
              ? 'too_far_behind'
              : null;
        if (!reason) return true;

        cursor = currentEventId;
        backlogDone = true;
        degradedCaughtUp = false;
        backlogSkippedForResync = true;
        return write(
          `event: resync_required\ndata: ${JSON.stringify({
            type: 'resync_required',
            reason,
            fromEventId: lastEventId.toString(),
            currentEventId: currentEventId.toString(),
          })}\n\n`,
        );
      };

      const writePage = (events: PersistedOwnerSessionEvent[]) => {
        for (const event of events) {
          if (
            !write(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
                ...event,
                // A degraded catch-up set `backlogDone` without draining, so
                // the events that arrive while recovering are still history:
                // keep labelling them backlog until the real signal goes out.
                phase: backlogDone && !degradedCaughtUp ? 'live' : 'backlog',
              })}\n\n`,
            )
          ) {
            return false;
          }
          cursor = BigInt(event.id);
          sentSinceAttach += 1;
        }
        return true;
      };

      const readPage = () => store.readAfter(ownerId, cursor, BACKLOG_PAGE);

      const drainBacklog = async () => {
        if (!(await checkAttachCursor()) || backlogSkippedForResync) return;
        for (;;) {
          if (closed) return;
          let page: PersistedOwnerSessionEvent[];
          try {
            page = await readPage();
          } catch {
            consecutiveBacklogFailures += 1;
            if (consecutiveBacklogFailures >= 3) markCaughtUp(true);
            return;
          }
          consecutiveBacklogFailures = 0;
          if (!writePage(page)) return;
          if (page.length < BACKLOG_PAGE) break;
        }
        markCaughtUp();
      };

      const poll = async () => {
        if (closed) return;
        if (!attachCursorChecked) {
          if (!(await checkAttachCursor()) || backlogSkippedForResync) return;
        }
        try {
          const page = await readPage();
          consecutiveBacklogFailures = 0;
          if (!writePage(page)) return;
          if (degradedCaughtUp) {
            // The authoritative signal has to pass the SAME exhaustion check
            // as the normal path. A degraded window is exactly when backlog
            // piles up, so the first successful page is often full: emitting
            // here would announce "the list is authoritative now" while
            // thousands of events are still queued behind it.
            if (page.length < BACKLOG_PAGE && emitCaughtUp()) degradedCaughtUp = false;
            return;
          }
          if (!backlogDone && page.length < BACKLOG_PAGE) markCaughtUp();
        } catch {
          // Before initial catch-up, retain backlog mode and retry. Only after
          // three consecutive failures do we unblock the UI with an explicit
          // degraded signal. Live-tail failures simply retry next tick.
          if (!backlogDone) {
            consecutiveBacklogFailures += 1;
            if (consecutiveBacklogFailures >= 3) markCaughtUp(true);
          }
        }
      };

      // Both timer and NOTIFY enter the same serialized gate. If a wakeup
      // lands during a read, exactly one follow-up read runs after it settles;
      // concurrent reads could duplicate frames or move the cursor backwards.
      const requestPoll = (): Promise<void> => {
        if (closed) return Promise.resolve();
        if (initializing) {
          wakeDuringInitialization = true;
          return Promise.resolve();
        }
        if (pollInFlight) {
          repollRequested = true;
          return pollInFlight;
        }
        pollInFlight = (async () => {
          do {
            repollRequested = false;
            await poll();
          } while (repollRequested && !closed);
        })().finally(() => {
          pollInFlight = null;
        });
        return pollInFlight;
      };

      const tick = () => {
        if (closed) return;
        pollTimer = setTimeout(() => {
          if (closed) return;
          void requestPoll().then(tick, tick);
        }, OWNER_EVENT_POLL_INTERVAL_MS);
      };

      // Retirement is checked on the independent heartbeat, not every event
      // poll. Owner merges are rare; this caps idle cost at one indexed lookup
      // per 25s while noticing established stale streams.
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        write(': ping\n\n');
        if (closed || retirementCheckInFlight) return;
        retirementCheckInFlight = true;
        void store
          .readRetirement(ownerId)
          .then((newOwnerId) => {
            if (!newOwnerId || closed) return;
            // Native EventSource reconnects a clean 200 EOF with the same
            // Last-Event-ID. The client MUST close this instance, construct a
            // new EventSource without that cursor, and perform one full session
            // list reconciliation because session_created omits list fields
            // such as prompt/stageId.
            write(
              `event: owner_moved\ndata: ${JSON.stringify({
                type: 'owner_moved',
                newOwnerId,
                action: 'reconnect',
              })}\n\n`,
            );
            close();
          })
          .catch(() => {
            // A transient PG failure is retried on the next heartbeat.
          })
          .finally(() => {
            retirementCheckInFlight = false;
          });
      }, SSE_HEARTBEAT_INTERVAL_MS);

      // Register before the initial read so a commit racing with backlog
      // exhaustion cannot fall into the 30s fallback window. The callback is
      // removed on every stream close path together with both timers.
      unsubscribeWakeup = subscribeAgentEventWakeup({ kind: 'owner', ownerId }, () => {
        void requestPoll();
      });
      await drainBacklog();
      initializing = false;
      if (wakeDuringInitialization) await requestPoll();
      tick();
    },
    cancel() {
      closed = true;
      clearTimers();
    },
  });

  responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-cache, no-transform');
  responseHeaders.set('Connection', 'keep-alive');
  return new Response(stream, { headers: responseHeaders });
}
