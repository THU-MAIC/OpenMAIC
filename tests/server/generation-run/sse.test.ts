/**
 * The run event streams' flow control: a slow client gets a bounded queue
 * (the read stops and resumes where it stopped once the client drains it),
 * and one owner holds a bounded number of streams.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  subscribeAgentEventWakeup: () => () => undefined,
}));

import {
  acquireRunStreamSlot,
  openRunStreamsOf,
  polledEventStream,
  RUN_SSE_QUEUE_BYTES,
  sseFrame,
} from '@/lib/server/generation/run/sse';

describe('run event streams', () => {
  it('stops reading at a full queue and resumes from the same frame when drained', async () => {
    const frame = (seq: number) => sseFrame('item', { seq, padding: 'x'.repeat(1000) }, seq);
    const total = 1000; // ~1 MB, several times the queue
    let cursor = 0;
    let reads = 0;
    const stream = polledEventStream({
      wakeup: { kind: 'generation-run', runId: 'run-x' },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      read: async (write) => {
        reads += 1;
        while (cursor < total) {
          if (!write(frame(cursor + 1))) return;
          cursor += 1;
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Nothing was read by the client: the queue holds about its bound, no more.
    expect(cursor).toBeGreaterThan(0);
    expect(cursor).toBeLessThan(total);
    expect(cursor * frame(1).length).toBeLessThanOrEqual(RUN_SSE_QUEUE_BYTES + frame(1).length);

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(`id: ${total}\n`)) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(reads).toBeGreaterThan(1);
  });

  it('caps the streams one owner holds, and frees a slot when one closes', async () => {
    const releases = Array.from({ length: 16 }, () => acquireRunStreamSlot('owner-cap'));
    expect(releases.every(Boolean)).toBe(true);
    expect(acquireRunStreamSlot('owner-cap')).toBeNull();
    expect(acquireRunStreamSlot('owner-other')).not.toBeNull();
    releases[0]!();
    releases[0]!();
    expect(openRunStreamsOf('owner-cap')).toBe(15);
    const again = acquireRunStreamSlot('owner-cap');
    expect(again).not.toBeNull();
    for (const release of [...releases, again]) release!();
    expect(openRunStreamsOf('owner-cap')).toBe(0);
  });

  it('releases its slot when the client goes away', async () => {
    const release = acquireRunStreamSlot('owner-close')!;
    const stream = polledEventStream({
      wakeup: { kind: 'generation-run-owner', ownerId: 'owner-close' },
      pollIntervalMs: 60_000,
      read: async () => undefined,
      onClose: release,
    });
    expect(openRunStreamsOf('owner-close')).toBe(1);
    await stream.cancel();
    expect(openRunStreamsOf('owner-close')).toBe(0);
  });

  it('sends a frame larger than the queue only when the queue is empty', async () => {
    const small = sseFrame('small', { padding: 'x'.repeat(200_000) }, 1);
    const large = sseFrame('large', { padding: 'y'.repeat(RUN_SSE_QUEUE_BYTES * 2) }, 2);
    const written: string[] = [];
    let pending = [small, large];
    const stream = polledEventStream({
      wakeup: { kind: 'generation-run', runId: 'run-big' },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      read: async (write) => {
        while (pending.length > 0) {
          if (!write(pending[0]!)) return;
          written.push(pending[0]!.slice(0, 12));
          pending = pending.slice(1);
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The small frame is queued; the large one waits for an empty queue.
    expect(written).toHaveLength(1);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: large')) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
    }
    expect(written).toHaveLength(2);
    await reader.cancel();
  });

  it('ends and frees its slot when the request is aborted', async () => {
    const release = acquireRunStreamSlot('owner-abort')!;
    const request = new AbortController();
    const stream = polledEventStream({
      wakeup: { kind: 'generation-run-owner', ownerId: 'owner-abort' },
      pollIntervalMs: 60_000,
      read: async () => undefined,
      onClose: release,
      signal: request.signal,
    });
    expect(openRunStreamsOf('owner-abort')).toBe(1);
    request.abort();
    expect(openRunStreamsOf('owner-abort')).toBe(0);
    const { done } = await stream.getReader().read();
    expect(done).toBe(true);
  });
});
