/**
 * The server-sent event streams of generation runs: a durable read that a
 * `NOTIFY` wake-up triggers early and a fallback poll triggers anyway (NOTIFY
 * is lossy), serialized so two reads never race the cursor, with a heartbeat
 * comment that keeps idle intermediaries from closing the stream. The shape of
 * the agent runtime's session and owner streams.
 */
import {
  subscribeAgentEventWakeup,
  type AgentEventWakeupRoute,
} from '@/lib/server/agent-runtime/event-notify-bus';

export const RUN_SSE_HEARTBEAT_INTERVAL_MS = 25_000;

/** One SSE frame. `id` is what `Last-Event-ID` resumes from. */
export function sseFrame(event: string, data: unknown, id?: number | string): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface PolledStreamOptions {
  wakeup: AgentEventWakeupRoute;
  pollIntervalMs: number;
  heartbeatIntervalMs?: number;
  /**
   * Read what is new and write it. Called once at attach (the backlog) and on
   * every wake-up and poll after that, never concurrently. `write` answers
   * false once the client is gone.
   */
  read: (write: (chunk: string) => boolean, phase: 'backlog' | 'live') => Promise<void>;
}

export function polledEventStream(options: PolledStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const clear = () => {
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // Not every runtime calls cancel() for a broken socket.
          clear();
          return false;
        }
      };

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
            try {
              await options.read(write, 'live');
            } catch {
              // A transient database failure: the next wake-up or poll retries.
            }
          } while (again && !closed);
        })().finally(() => {
          inFlight = null;
        });
        return inFlight;
      };
      const tick = () => {
        if (closed) return;
        pollTimer = setTimeout(() => void read().then(tick, tick), options.pollIntervalMs);
      };

      heartbeatTimer = setInterval(
        () => write(': ping\n\n'),
        options.heartbeatIntervalMs ?? RUN_SSE_HEARTBEAT_INTERVAL_MS,
      );
      // Subscribe before the first read so a commit racing the backlog is not
      // left to the fallback poll.
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
    cancel() {
      clear();
    },
  });
}

export function sseHeaders(headers: Headers): Headers {
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache, no-transform');
  headers.set('Connection', 'keep-alive');
  return headers;
}
