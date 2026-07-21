/**
 * A byte-capped wrapper around a request body stream.
 *
 * `Content-Length` is client-supplied and easy to omit, lie about, or sidestep
 * with a chunked (`Transfer-Encoding: chunked`) upload — so a length check alone
 * can't stop an unbounded body from being buffered into memory. This wraps the
 * body stream so the *actual* bytes are counted as they flow, and the stream is
 * aborted the instant they exceed `capBytes`. Nothing downstream (a proxying
 * `fetch`, a `formData()` parse) ever buffers more than the cap.
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
