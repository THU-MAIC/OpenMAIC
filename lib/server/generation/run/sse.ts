/**
 * The server-sent event streams of generation runs: a durable read that a
 * `NOTIFY` wake-up triggers early and a fallback poll triggers anyway (NOTIFY
 * is lossy), serialized so two reads never race the cursor, with a heartbeat
 * comment that keeps idle intermediaries from closing the stream. The shape of
 * the agent runtime's session and owner streams.
 *
 * A stream holds no more than {@link RUN_SSE_QUEUE_BYTES} queued for a slow
 * client: a read stops writing once the queue is full (its cursor stays where
 * the last written frame left it) and resumes when the client drains it. One
 * owner may hold at most {@link maxRunStreamsPerOwner} streams per process.
 */
import {
  subscribeAgentEventWakeup,
  type AgentEventWakeupRoute,
} from '@/lib/server/agent-runtime/event-notify-bus';

export const RUN_SSE_HEARTBEAT_INTERVAL_MS = 25_000;
/** The bytes a stream queues for its client before it stops reading. */
export const RUN_SSE_QUEUE_BYTES = 256 * 1024;

/** One SSE frame. `id` is what `Last-Event-ID` resumes from. */
export function sseFrame(event: string, data: unknown, id?: number | string): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Concurrent streams per owner ──

const STREAMS_KEY = Symbol.for('openmaic.generation-runs.streams');
const streamState = globalThis as typeof globalThis & {
  [STREAMS_KEY]?: Map<string, number>;
};
const openStreams = (streamState[STREAMS_KEY] ??= new Map());

/** How many run streams (run event streams and the owner stream together) one owner may hold. */
export function maxRunStreamsPerOwner(): number {
  const raw = Number(process.env.OPENMAIC_GENERATION_RUN_STREAMS_PER_OWNER ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : 16;
}

/** Take one of the owner's stream slots; a release function, or null when they are all taken. */
export function acquireRunStreamSlot(ownerId: string): (() => void) | null {
  const open = openStreams.get(ownerId) ?? 0;
  if (open >= maxRunStreamsPerOwner()) return null;
  openStreams.set(ownerId, open + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (openStreams.get(ownerId) ?? 1) - 1;
    if (remaining > 0) openStreams.set(ownerId, remaining);
    else openStreams.delete(ownerId);
  };
}

/** The streams an owner holds now (tests). */
export function openRunStreamsOf(ownerId: string): number {
  return openStreams.get(ownerId) ?? 0;
}

export interface PolledStreamOptions {
  wakeup: AgentEventWakeupRoute;
  pollIntervalMs: number;
  heartbeatIntervalMs?: number;
  /**
   * Read what is new and write it. Called once at attach (the backlog) and on
   * every wake-up, poll and drain after that, never concurrently. `write`
   * answers false when the frame was not written (the client's queue is full,
   * or it is gone): the read stops there and resumes from the same place.
   */
  read: (write: (chunk: string) => boolean, phase: 'backlog' | 'live') => Promise<void>;
  /** Runs once when the stream ends, however it ends. */
  onClose?: () => void;
}

export function polledEventStream(options: PolledStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Set once a read stopped on a full queue: the next pull reads again.
  let blocked = false;
  let requestRead: (() => Promise<void>) | null = null;

  const clear = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    options.onClose?.();
  };

  const write = (chunk: string) => {
    const controller = controllerRef;
    if (closed || !controller) return false;
    if ((controller.desiredSize ?? 0) <= 0) {
      blocked = true;
      return false;
    }
    try {
      controller.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      // Not every runtime calls cancel() for a broken socket.
      clear();
      return false;
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        controllerRef = controller;
        let initializing = true;
        let wokenDuringInitialization = false;
        let inFlight: Promise<void> | null = null;
        let again = false;
        const read = (): Promise<void> => {
          if (closed) return Promise.resolve();
          if (initializing) {
            wokenDuringInitialization = true;
            return Promise.resolve();
          }
          if (inFlight) {
            again = true;
            return inFlight;
          }
          inFlight = (async () => {
            do {
              again = false;
              blocked = false;
              try {
                await options.read(write, 'live');
              } catch {
                // A transient database failure: the next wake-up or poll retries.
              }
            } while (again && !closed && !blocked);
          })().finally(() => {
            inFlight = null;
          });
          return inFlight;
        };
        requestRead = read;
        const tick = () => {
          if (closed) return;
          pollTimer = setTimeout(() => void read().then(tick, tick), options.pollIntervalMs);
        };

        heartbeatTimer = setInterval(
          () => write(': ping\n\n'),
          options.heartbeatIntervalMs ?? RUN_SSE_HEARTBEAT_INTERVAL_MS,
        );
        // Subscribe before the first read so a commit racing the backlog is
        // not left to the fallback poll.
        unsubscribe = subscribeAgentEventWakeup(options.wakeup, () => void read());
        try {
          await options.read(write, 'backlog');
        } catch {
          // The live reads retry.
        }
        initializing = false;
        if (wokenDuringInitialization) await read();
        tick();
      },
      pull() {
        // The client drained the queue: go on where a full queue stopped.
        if (blocked && requestRead) void requestRead();
      },
      cancel() {
        clear();
      },
    },
    { highWaterMark: RUN_SSE_QUEUE_BYTES, size: (chunk) => chunk.byteLength },
  );
}

export function sseHeaders(headers: Headers): Headers {
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Connection', 'keep-alive');
  return headers;
}
