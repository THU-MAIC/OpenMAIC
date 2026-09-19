import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  readEventsAfterForReplay: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
  wake: undefined as undefined | (() => void),
  unsubscribeWakeup: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => ({
    getSession: mocks.getSession,
    readEventsAfterForReplay: mocks.readEventsAfterForReplay,
  })),
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  subscribeAgentEventWakeup: vi.fn((_route, wake: () => void) => {
    mocks.wake = wake;
    return mocks.unsubscribeWakeup;
  }),
}));

import {
  GET,
  POLL_INTERVAL_MS,
  TERMINAL_POLL_INTERVAL_MS,
} from '@/app/api/agent/sessions/[id]/events/route';

const terminalEvent = {
  id: 4,
  ts: 100,
  attempt: 1,
  type: 'session_end',
  data: { status: 'succeeded' },
};
const resumedEvent = {
  id: 5,
  ts: 200,
  attempt: 1,
  type: 'session_start',
  data: { workerId: 'worker-1' },
};

function call(lastEventId = '0') {
  const req = new NextRequest('http://localhost/api/agent/sessions/session-1/events', {
    headers: { 'last-event-id': lastEventId },
  });
  return GET(req, { params: Promise.resolve({ id: 'session-1' }) });
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return chunk.done ? '' : new TextDecoder().decode(chunk.value);
}

async function readNonHeartbeatChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  for (;;) {
    const chunk = await readChunk(reader);
    if (chunk !== ': ping\n\n') return chunk;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.wake = undefined;
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'user:mine' });
  mocks.resolveRequestOwnerId.mockReturnValue('user:mine');
  mocks.readEventsAfterForReplay.mockResolvedValue({ events: [], scanned: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET per-session events', () => {
  it('preserves an anonymous owner cookie on the SSE response', async () => {
    mocks.resolveRequestOwnerId.mockImplementationOnce((_request, responseHeaders: Headers) => {
      responseHeaders.set('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
      return 'user:mine';
    });

    const response = await call();
    const reader = response.body!.getReader();

    expect(response.headers.get('set-cookie')).toBe('anonymous_id=test; Path=/; HttpOnly');
    expect(mocks.resolveRequestOwnerId).toHaveBeenCalledOnce();
    await reader.cancel();
  });

  it('does not stream a session owned by another identity: 404 and no event-log reads', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'user:someone-else' });
    mocks.resolveRequestOwnerId.mockReturnValue('user:mine');

    const response = await call();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(mocks.resolveRequestOwnerId).toHaveBeenCalledOnce();
    expect(mocks.readEventsAfterForReplay).not.toHaveBeenCalled();
  });

  it('mints the identity cookie on the 404 for a missing and a not-owned session alike', async () => {
    const mint = () => {
      mocks.resolveRequestOwnerId.mockImplementationOnce((_request, responseHeaders: Headers) => {
        responseHeaders.set('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
        return 'user:mine';
      });
    };

    mint();
    mocks.getSession.mockResolvedValue(null);
    const missing = await call();
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Not found');
    expect(missing.headers.get('set-cookie')).toBe('anonymous_id=test; Path=/; HttpOnly');
    expect(mocks.readEventsAfterForReplay).not.toHaveBeenCalled();

    mint();
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'user:someone-else' });
    const notOwned = await call();
    expect(notOwned.status).toBe(404);
    expect(await notOwned.text()).toBe('Not found');
    expect(notOwned.headers.get('set-cookie')).toBe('anonymous_id=test; Path=/; HttpOnly');
    expect(mocks.readEventsAfterForReplay).not.toHaveBeenCalled();
  });

  it('forwards a delta immediately on a session wakeup, without waiting for the poll', async () => {
    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(': replaying from event 0\n\n');
    expect(await readChunk(reader)).toContain('event: caught_up');

    mocks.readEventsAfterForReplay.mockResolvedValueOnce({
      events: [{ id: 1, ts: 123, attempt: 1, type: 'message_update', data: { text: 'now' } }],
      scanned: 1,
    });
    // The LISTEN/NOTIFY wakeup fires the instant a durable delta commits. No
    // timer advance: the frame must land on the wake alone, or token-by-token
    // streaming would still stall on the 5s fallback clock.
    mocks.wake?.();

    expect(await readChunk(reader)).toContain('id: 1\nevent: message_update');
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(2);
    await reader.cancel();
    expect(mocks.unsubscribeWakeup).toHaveBeenCalledOnce();
  });

  it('converges within the 5s polling interval', async () => {
    // Absolute time bound, not the imported constant: this test pins how FAST
    // the fallback converges. If the advance used the constant itself, a
    // constant change (5s -> 300s) would silently keep every assertion green.
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    const response = await call();
    const reader = response.body!.getReader();
    await readChunk(reader);
    await readChunk(reader);
    mocks.readEventsAfterForReplay.mockResolvedValueOnce({
      events: [{ id: 1, ts: 123, attempt: 1, type: 'message_update', data: { text: 'fallback' } }],
      scanned: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(1);
    let delivered = false;
    const fallbackFrame = readChunk(reader).then((chunk) => {
      delivered = chunk.includes('id: 1\nevent: message_update');
      return chunk;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toBe(true);
    expect(await fallbackFrame).toContain('id: 1\nevent: message_update');
    expect(mocks.wake).toBeTypeOf('function'); // registered, deliberately never invoked
    await reader.cancel();
  });

  it('retries backlog failures, degrades after three, and signals recovery only once', async () => {
    mocks.readEventsAfterForReplay.mockRejectedValue(new Error('pg unavailable'));

    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(': replaying from event 0\n\n');

    let degradedSettled = false;
    const degradedFrame = readChunk(reader).then((chunk) => {
      degradedSettled = true;
      return chunk;
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2 - 1);
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(2);
    expect(degradedSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await degradedFrame).toContain(
      'data: {"type":"caught_up","replayed":0,"fromEventId":0,"degraded":true}',
    );
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(3);

    mocks.readEventsAfterForReplay.mockResolvedValue({ events: [], scanned: 0 });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const recovered = await readChunk(reader);
    expect(recovered).toContain('event: caught_up');
    expect(recovered).not.toContain('"degraded":true');

    let repeated = false;
    const nextFrame = readChunk(reader).then((chunk) => {
      repeated = chunk.includes('event: caught_up');
      return chunk;
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(repeated).toBe(false);
    await reader.cancel();
    await nextFrame;
  });

  it('withholds the recovery signal while the recovered page is still unexhausted', async () => {
    mocks.readEventsAfterForReplay.mockRejectedValue(new Error('pg unavailable'));
    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(': replaying from event 0\n\n');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(await readChunk(reader)).toContain('"degraded":true');

    // Recovery lands on an unexhausted page. Pagination judges by the RAW
    // scanned count, so `scanned: 500` means more history follows even though
    // compaction left a single frame -- the authoritative signal must wait.
    mocks.readEventsAfterForReplay.mockResolvedValue({
      events: [{ id: 1, seq: 1, ts: 1, type: 'message_update', data: {} }],
      scanned: 500,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const recovering = await readChunk(reader);
    expect(recovering).toContain('id: 1\nevent: message_update');
    expect(recovering).not.toContain('event: caught_up');
    // A degraded catch-up set backlogDone without draining, so this is still
    // history rather than live tail.
    expect(recovering).toContain('"phase":"backlog"');

    // Exhausted page: the event goes out first, the authoritative caught_up
    // after it. Frame order is what separates a guarded recovery from an
    // unguarded one -- without the check the caught_up above would already
    // have been queued and would arrive BEFORE this event.
    mocks.readEventsAfterForReplay.mockResolvedValue({
      events: [{ id: 2, seq: 2, ts: 2, type: 'message_update', data: {} }],
      scanned: 1,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const tailEvent = await readChunk(reader);
    expect(tailEvent).toContain('id: 2\nevent: message_update');
    expect(tailEvent).not.toContain('event: caught_up');
    const recovered = await readChunk(reader);
    expect(recovered).toContain('event: caught_up');
    expect(recovered).not.toContain('"degraded":true');
    await reader.cancel();
  });

  it('emits a 25s comment heartbeat independently and cancel clears both timers', async () => {
    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(': replaying from event 0\n\n');
    expect(await readChunk(reader)).toContain('event: caught_up');
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(await readChunk(reader)).toBe(': ping\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('attaching to a terminal backlog immediately schedules the longer fallback interval', async () => {
    // Terminal backoff has an absolute ceiling too: a steer on a terminal
    // session must still converge in bounded time, so pin the constant rather
    // than letting it drift upward.
    expect(TERMINAL_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    mocks.readEventsAfterForReplay
      .mockResolvedValueOnce({ events: [terminalEvent], scanned: 1 })
      .mockResolvedValue({ events: [], scanned: 0 });

    const response = await call();
    const reader = response.body!.getReader();
    await readChunk(reader);
    expect(await readChunk(reader)).toContain('id: 4\nevent: session_end');
    await readChunk(reader);

    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_INTERVAL_MS - 1);
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(2);
    expect(mocks.readEventsAfterForReplay).toHaveBeenLastCalledWith('session-1', 4, 500);
    await reader.cancel();
  });

  it('delivers in order from Last-Event-ID and resumes 5s fallback polling after new activity', async () => {
    mocks.readEventsAfterForReplay
      .mockResolvedValueOnce({ events: [terminalEvent], scanned: 1 })
      .mockResolvedValueOnce({ events: [resumedEvent], scanned: 1 })
      .mockResolvedValue({ events: [], scanned: 0 });

    const response = await call('3');
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(': replaying from event 3\n\n');
    expect(await readChunk(reader)).toContain('id: 4\nevent: session_end');
    await readChunk(reader);

    await vi.advanceTimersByTimeAsync(TERMINAL_POLL_INTERVAL_MS);
    expect(await readNonHeartbeatChunk(reader)).toContain('id: 5\nevent: session_start');
    expect(mocks.readEventsAfterForReplay.mock.calls.slice(0, 2)).toEqual([
      ['session-1', 3, 500],
      ['session-1', 4, 500],
    ]);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(mocks.readEventsAfterForReplay).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.readEventsAfterForReplay).toHaveBeenLastCalledWith('session-1', 5, 500);
    await reader.cancel();
  });
});
