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

export function capBodyStream(body: ReadableStream<Uint8Array>, capBytes: number): CappedBody {
  let total = 0;
  let tripped = false;
  const reader = body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > capBytes) {
        tripped = true;
        controller.error(new Error('Upload exceeds the maximum allowed size'));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });

  return { stream, exceeded: () => tripped };
}
