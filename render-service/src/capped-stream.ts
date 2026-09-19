/**
 * A byte-capped wrapper around a request body stream.
 *
 * The Next proxy already bounds the forwarded body, but this service can also be
 * reached directly (its contract is public and demo deployments may expose it),
 * so it enforces its own ceiling. `Content-Length` is client-supplied and
 * omitted on chunked uploads, so counting the declared length is not enough —
 * this counts the *actual* bytes as they flow and aborts the stream the instant
 * they exceed `capBytes`, before `formData()` / `arrayBuffer()` can buffer them.
 *
 * Returns the capped stream plus an `exceeded()` probe so the caller can tell a
 * cap trip apart from an ordinary malformed-body error after the consumer throws.
 */
export interface CappedBody {
  stream: ReadableStream<Uint8Array>;
  exceeded: () => boolean;
}

export function capBodyStream(
  body: ReadableStream<Uint8Array>,
  capBytes: number,
  signal?: AbortSignal,
): CappedBody {
  let total = 0;
  let tripped = false;
  let stopped = false;
  const reader = body.getReader();
  let onAbort: (() => void) | undefined;

  const cleanup = () => {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!signal) return;
      onAbort = () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        controller.error(signal.reason ?? new Error('Operation aborted'));
        void reader.cancel(signal.reason).catch(() => {});
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          cleanup();
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > capBytes) {
          tripped = true;
          stopped = true;
          cleanup();
          controller.error(new Error('Upload exceeds the maximum allowed size'));
          await reader.cancel().catch(() => {});
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (stopped) return;
        stopped = true;
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      stopped = true;
      cleanup();
      void reader.cancel(reason).catch(() => {});
    },
  });

  return { stream, exceeded: () => tripped };
}
