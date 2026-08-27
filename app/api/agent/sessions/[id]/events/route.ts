/**
 * Agent runtime control plane — the session event stream (SSE).
 *
 *   GET /api/agent/sessions/:id/events
 *     Honors `Last-Event-ID` (header or `?lastEventId=`): everything durable
 *     with `seq > lastEventId` is replayed first (intermediate `message_update`
 *     tokens are dropped; the last update in each run already has the full
 *     text), then whatever lands afterwards. A client attaching mid-run and
 *     one attaching between runs take the exact same path. The log is the
 *     single source of truth; the live stream is just its tail.
 *
 * Frames:
 *   - one `caught_up` event when the backlog has been drained (a real, named
 *     event rather than a comment, which `EventSource` would drop). A
 *     `degraded: true` caught_up is not authoritative and asks the client to
 *     schedule a full reconciliation; recovery emits one plain caught_up;
 *   - runner/pi/control-plane events as `id:` + `event:` + `data:`.
 *
 * The stream does NOT close at `session_end`: a session is a long-lived
 * conversation (continuous chat), and a run boundary is just another frame.
 * The attach ends when the client disconnects or an HTTP intermediary cuts
 * the stream. Native `EventSource` then reconnects with `Last-Event-ID` and
 * resumes through the same replay path without losing durable events.
 *
 * Access model: there is no per-route auth challenge. Every request is
 * granted an anonymous cookie identity, and every store read is scoped to
 * that identity. A session owned by another identity is indistinguishable
 * from a missing one — both are 404 with the same response.
 *
 * This handler is a pure READER of the store. A disconnect closes this
 * reader and nothing else: the runner keeps running, and its events keep
 * landing in the log.
 */
import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import type { NextRequest } from 'next/server';

import { HOST_AGENT_LIFECYCLE as LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { subscribeAgentEventWakeup } from '@/lib/server/agent-runtime/event-notify-bus';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

export const runtime = 'nodejs';
// Self-hosted `next start` does not enforce maxDuration; it remains useful to
// Vercel's build adapter. EventSource resumes durable events with Last-Event-ID.
// The 25s heartbeat prevents idle intermediaries from ending the stream early.
export const maxDuration = 300;

// LISTEN/NOTIFY supplies low latency. Polling remains an explicit correctness
// fallback for notifications lost during disconnects; terminal streams retain
// their longer backoff.
export const POLL_INTERVAL_MS = 5_000;
// Terminal streams poll less often than active ones, but 10s is the ceiling.
// The worst case is "session already terminal -> user steers": this is exactly
// the moment the user is waiting for the result. Terminal streams exist only
// while the user actually has that session open, so the extra cost is small.
export const TERMINAL_POLL_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
/** Same default as `readEventsAfter`. A full page means more backlog remains. */
const BACKLOG_PAGE = 500;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }
  const { id } = await params;
  const responseHeaders = new Headers();
  // The identity cookie is minted for the requester regardless of the target
  // session, and the owner is resolved before the session lookup: a request
  // for a missing session and one for a session owned by someone else return
  // byte-identical 404s (same status, body, and cookie headers), so the
  // response cannot be used to probe whether a session UUID exists. This
  // slice resolves only the anonymous cookie identity; a future auth
  // integration must thread `authenticatedOwnerId` through here, or sessions
  // created under authenticated identities would be unreachable by their own
  // owner.
  const ownerId = resolveRequestOwnerId(req, responseHeaders);
  const store = await getAgentSessionStore();
  const meta = await store.getSession(id);
  if (!meta) {
    return new Response('Not found', { status: 404, headers: responseHeaders });
  }
  if (meta.ownerId !== ownerId) {
    return new Response('Not found', { status: 404, headers: responseHeaders });
  }

  const url = new URL(req.url);
  const headerId = req.headers.get('last-event-id');
  const lastEventId = Number(headerId ?? url.searchParams.get('lastEventId') ?? 0) || 0;

  const encoder = new TextEncoder();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeWakeup: (() => void) | null = null;
  // Hoisted so cancel() can stop an in-flight-then-scheduled poll, not just
  // the timer: after a client disconnect, `closed` makes every later poll a
  // no-op and `write` a dead end.
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
      let terminal = false;
      let consecutiveBacklogFailures = 0;
      let degradedCaughtUp = false;
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
          // A broken socket is not guaranteed to invoke cancel() in every
          // runtime. Stop both timers as soon as enqueue proves it is closed.
          closed = true;
          clearTimers();
          return false;
        }
      };

      // "You are caught up" is a real, named SSE event, not a comment: a
      // client attaching during a long tool call would otherwise sit on
      // "replaying" until the next event, and a re-attach at the last event
      // id of an idle session would receive zero frames and wait forever.
      const emitCaughtUp = (degraded = false) =>
        write(
          `event: caught_up\ndata: ${JSON.stringify({
            type: 'caught_up',
            replayed: sentSinceAttach,
            fromEventId: lastEventId,
            ...(degraded ? { degraded: true } : {}),
          })}\n\n`,
        );

      const markCaughtUp = (degraded = false) => {
        if (backlogDone) return;
        if (!emitCaughtUp(degraded)) return;
        backlogDone = true;
        degradedCaughtUp = degraded;
      };

      const writePage = (events: PersistedAgentSessionEvent[]) => {
        for (const event of events) {
          if (
            !write(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
                ...event,
                // A degraded catch-up set `backlogDone` without draining, so
                // events arriving while recovering are still history: keep
                // labelling them backlog until the real signal goes out.
                phase: backlogDone && !degradedCaughtUp ? 'live' : 'backlog',
              })}\n\n`,
            )
          ) {
            return false;
          }
          cursor = event.id;
          sentSinceAttach += 1;
          const data = event.data as { status?: unknown } | null;
          const isTerminalEnd =
            event.type === LIFECYCLE.sessionEnd &&
            (data?.status === 'succeeded' ||
              data?.status === 'failed' ||
              data?.status === 'cancelled');
          // A terminal session_end is normally the last frame. Any later
          // durable frame proves activity resumed (usually user_message then
          // session_start/session_resumed), so polling switches both ways.
          if (isTerminalEnd) terminal = true;
          else if (terminal) terminal = false;
        }
        return true;
      };

      const drainBacklog = async () => {
        for (;;) {
          if (closed) return;
          let page;
          try {
            page = await store.readEventsAfterForReplay(id, cursor, BACKLOG_PAGE);
          } catch {
            consecutiveBacklogFailures += 1;
            if (consecutiveBacklogFailures >= 3) markCaughtUp(true);
            return;
          }
          consecutiveBacklogFailures = 0;
          if (!writePage(page.events)) return;
          // Pagination judges by the RAW page size (`scanned`), not the
          // compacted length: a page of pure message_update compacts to two
          // frames and would otherwise look "exhausted" mid-log.
          if (page.scanned < BACKLOG_PAGE) break;
        }
        markCaughtUp();
      };

      const poll = async () => {
        if (closed) return;
        let page;
        try {
          page = await store.readEventsAfterForReplay(id, cursor, BACKLOG_PAGE);
        } catch {
          if (!backlogDone) {
            consecutiveBacklogFailures += 1;
            if (consecutiveBacklogFailures >= 3) markCaughtUp(true);
          }
          return; // transient PG hiccup — the next poll retries
        }
        consecutiveBacklogFailures = 0;
        if (!writePage(page.events)) return;
        if (degradedCaughtUp) {
          // Same exhaustion check as the normal path below: a degraded window
          // is when backlog piles up, so the first successful page is often
          // full and announcing catch-up there would be another lie.
          if (page.scanned < BACKLOG_PAGE && emitCaughtUp()) degradedCaughtUp = false;
          return;
        }
        if (!backlogDone && page.scanned < BACKLOG_PAGE) markCaughtUp();
      };

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

      // Serialized polling: the next poll is scheduled only after the
      // previous one has SETTLED, so a PG read slower than the interval can
      // never start a second concurrent poll. Two in-flight polls share the
      // cursor and would emit duplicate frames — worse, the slower one would
      // rewind the cursor for the poll after it.
      const tick = () => {
        if (closed) return;
        // An idle historical session may wait up to 10 seconds for its first
        // reactivation frame; the user action already has optimistic UI. Once
        // that frame arrives, the next read returns to the 5s cadence.
        const interval = terminal ? TERMINAL_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
        pollTimer = setTimeout(() => {
          if (closed) return;
          // Reschedule only after poll settles. tick then re-reads terminal, so
          // a reactivation discovered by this poll restores the 5s cadence.
          void requestPoll().then(tick, tick);
        }, interval);
      };

      write(`: replaying from event ${lastEventId}\n\n`);
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        write(': ping\n\n');
      }, HEARTBEAT_INTERVAL_MS);
      // Register before the initial read so a commit racing with backlog
      // exhaustion cannot fall into the 5s fallback window. The callback is
      // removed on every stream close path together with both timers.
      unsubscribeWakeup = subscribeAgentEventWakeup({ kind: 'session', sessionId: id }, () => {
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
