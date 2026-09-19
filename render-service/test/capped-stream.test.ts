/**
 * The upload body cap must count *actual* bytes and abort the stream the instant
 * they exceed the limit — a `Content-Length` check alone is bypassable via a
 * chunked or length-lying upload, so this is the real bound before `formData()`
 * / `arrayBuffer()` can buffer a hostile body.
 */
import { describe, it, expect } from 'vitest';
import { capBodyStream } from '../src/capped-stream.js';

/** A ReadableStream that emits `count` chunks of `chunk` bytes each. */
function streamOf(chunk: number, count: number): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= count) {
        controller.close();
        return;
      }
      emitted++;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
}

describe('capBodyStream', () => {
  it('passes a body under the cap through untouched', async () => {
    const { stream, exceeded } = capBodyStream(streamOf(1000, 5), 10_000);
    expect(await drain(stream)).toBe(5000);
    expect(exceeded()).toBe(false);
  });

  it('aborts and flags a body that exceeds the cap', async () => {
    const { stream, exceeded } = capBodyStream(streamOf(1000, 100), 5000);
    await expect(drain(stream)).rejects.toBeTruthy();
    expect(exceeded()).toBe(true);
  });

  it('does not flag exceeded when the body ends exactly at the cap', async () => {
    const { stream, exceeded } = capBodyStream(streamOf(1000, 5), 5000);
    expect(await drain(stream)).toBe(5000);
    expect(exceeded()).toBe(false);
  });
});
