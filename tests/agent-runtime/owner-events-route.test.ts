import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readOwnerRetirement: vi.fn(),
  readOwnerSessionEventMaxId: vi.fn(),
  readOwnerSessionEventsAfter: vi.fn(),
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
    readRetirement: mocks.readOwnerRetirement,
    readMaxId: mocks.readOwnerSessionEventMaxId,
    readAfter: mocks.readOwnerSessionEventsAfter,
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
  OWNER_EVENT_POLL_INTERVAL_MS,
  OWNER_EVENT_REPLAY_LIMIT,
  SSE_HEARTBEAT_INTERVAL_MS,
} from '@/app/api/agent/owner-events/route';

function call(lastEventId?: { header?: string; query?: string }) {
  const query = lastEventId?.query ? `?lastEventId=${lastEventId.query}` : '';
  const req = new NextRequest(`http://localhost/api/agent/owner-events${query}`, {
    headers: lastEventId?.header ? { 'last-event-id': lastEventId.header } : undefined,
  });
  return GET(req);
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
  mocks.resolveRequestOwnerId.mockReturnValue('user:mine');
  mocks.readOwnerRetirement.mockResolvedValue(null);
  mocks.readOwnerSessionEventMaxId.mockResolvedValue(BigInt(0));
  mocks.readOwnerSessionEventsAfter.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET owner session events', () => {
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

  it('scopes every store read to the resolved request owner', async () => {
    mocks.resolveRequestOwnerId.mockReturnValue('user:requestor');
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(BigInt(1));
    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: '1',
        ownerId: 'user:requestor',
        sessionId: 'session-1',
        ts: 123,
        type: 'session_status',
        status: 'running',
        attempt: 1,
      },
    ]);

    const response = await call({ header: '0' });
    const reader = response.body!.getReader();
    const event = await readChunk(reader);

    expect(event).toContain('id: 1\nevent: session_status');
    expect(event).toContain('"ownerId":"user:requestor"');
    expect(mocks.readOwnerSessionEventMaxId).toHaveBeenCalledWith('user:requestor');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith(
      'user:requestor',
      BigInt(0),
      500,
    );
    await reader.cancel();
  });

  it('an owner with no sessions receives an empty stream scoped to that owner', async () => {
    mocks.resolveRequestOwnerId.mockReturnValue('user:requestor');

    const response = await call();
    const reader = response.body!.getReader();
    const caughtUp = await readChunk(reader);

    expect(caughtUp).toContain('event: caught_up');
    expect(caughtUp).toContain('"replayed":0');
    expect(mocks.readOwnerSessionEventMaxId).toHaveBeenCalledWith('user:requestor');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith(
      'user:requestor',
      BigInt(0),
      500,
    );
    await reader.cancel();
  });

  it.each([
    ['query lastEventId=0', { query: '0' }, BigInt(0)],
    ['Last-Event-ID header', { header: '7', query: '2' }, BigInt(7)],
    [
      'BIGINT Last-Event-ID without JS rounding',
      { header: '9007199254740993' },
      BigInt('9007199254740993'),
    ],
  ])('replays from %s and emits a named caught_up event', async (_name, input, expectedCursor) => {
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(expectedCursor + BigInt(1));
    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: (expectedCursor + BigInt(1)).toString(),
        ownerId: 'user:mine',
        sessionId: 'session-1',
        ts: 123,
        type: 'session_status',
        status: 'running',
        attempt: 1,
      },
    ]);

    const response = await call(input);
    const reader = response.body!.getReader();

    expect(response.status).toBe(200);
    expect(await readChunk(reader)).toContain(
      `id: ${expectedCursor + BigInt(1)}\nevent: session_status`,
    );
    expect(await readChunk(reader)).toContain('event: caught_up');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith(
      'user:mine',
      expectedCursor,
      500,
    );
    await reader.cancel();
  });

  it('retries a failed backlog in backlog phase and emits caught_up only after success', async () => {
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(BigInt(8));
    mocks.readOwnerSessionEventsAfter
      .mockRejectedValueOnce(new Error('pg unavailable'))
      .mockResolvedValueOnce([
        {
          id: '8',
          ownerId: 'user:mine',
          sessionId: 'session-after-retry',
          ts: 789,
          type: 'session_status',
          status: 'queued',
          attempt: 0,
        },
      ]);

    const response = await call({ header: '7' });
    const reader = response.body!.getReader();
    await Promise.resolve();
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    const replayed = await readNonHeartbeatChunk(reader);
    expect(replayed).toContain('id: 8\nevent: session_status');
    expect(replayed).toContain('"phase":"backlog"');
    const caughtUp = await readChunk(reader);
    expect(caughtUp).toContain('event: caught_up');
    expect(caughtUp).not.toContain('"degraded":true');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenNthCalledWith(
      2,
      'user:mine',
      BigInt(7),
      500,
    );
    await reader.cancel();
  });

  it('fails loud when the client cursor is ahead, resets to max, and keeps the live stream open', async () => {
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(BigInt(100));

    const response = await call({ header: '101' });
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(
      'event: resync_required\ndata: {"type":"resync_required","reason":"cursor_ahead","fromEventId":"101","currentEventId":"100"}\n\n',
    );
    expect(mocks.readOwnerSessionEventsAfter).not.toHaveBeenCalled();

    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: '102',
        ownerId: 'user:mine',
        sessionId: 'session-live',
        ts: 123,
        type: 'session_status',
        status: 'running',
        attempt: 1,
      },
    ]);
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    const live = await readNonHeartbeatChunk(reader);
    expect(live).toContain('id: 102\nevent: session_status');
    expect(live).toContain('"phase":"live"');
    expect(live).not.toContain('event: caught_up');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith('user:mine', BigInt(100), 500);
    await reader.cancel();
  });

  it('resyncs instead of replaying beyond the bounded window, then tails after the max', async () => {
    const current = BigInt(OWNER_EVENT_REPLAY_LIMIT) + BigInt(101);
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(current);
    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: '102',
        ownerId: 'user:mine',
        sessionId: 'would-be-backlog',
        ts: 123,
        type: 'session_status',
        status: 'running',
        attempt: 1,
      },
    ]);

    const response = await call({ header: '100' });
    const reader = response.body!.getReader();
    const first = await readChunk(reader);
    expect(first).toBe(
      `event: resync_required\ndata: {"type":"resync_required","reason":"too_far_behind","fromEventId":"100","currentEventId":"${current}"}\n\n`,
    );
    expect(first).not.toContain('event: session_status');
    expect(first).not.toContain('event: caught_up');
    expect(mocks.readOwnerSessionEventsAfter).not.toHaveBeenCalled();

    mocks.readOwnerSessionEventsAfter.mockReset().mockResolvedValueOnce([
      {
        id: String(current + BigInt(1)),
        ownerId: 'user:mine',
        sessionId: 'session-live',
        ts: 456,
        type: 'session_status',
        status: 'succeeded',
        attempt: 1,
      },
    ]);
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    const live = await readNonHeartbeatChunk(reader);
    expect(live).toContain(`id: ${current + BigInt(1)}\nevent: session_status`);
    expect(live).toContain('"phase":"live"');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith('user:mine', current, 500);
    await reader.cancel();
  });

  it('still replays when the attach cursor is exactly at the replay limit', async () => {
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(BigInt(OWNER_EVENT_REPLAY_LIMIT));
    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([]);

    const response = await call({ header: '0' });
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toContain('event: caught_up');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith('user:mine', BigInt(0), 500);
    await reader.cancel();
  });

  it('forwards an owner event immediately on a wakeup, without waiting for the 30s poll', async () => {
    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toContain('event: caught_up');

    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: '1',
        ownerId: 'user:mine',
        sessionId: 'session-live',
        ts: 123,
        type: 'session_status',
        status: 'running',
        attempt: 1,
      },
    ]);
    // The LISTEN/NOTIFY wakeup fires the instant a durable owner projection
    // commits. No timer advance: the frame must land on the wake alone, or
    // the session list would still refresh on the 30s fallback clock.
    mocks.wake?.();

    expect(await readChunk(reader)).toContain('id: 1\nevent: session_status');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledTimes(2);
    await reader.cancel();
    expect(mocks.unsubscribeWakeup).toHaveBeenCalledOnce();
  });

  it('converges within the 30s polling interval', async () => {
    // Absolute time bound, not the imported constant: this test pins how FAST
    // the fallback converges. If the advance used the constant itself, a
    // constant change (30s -> 300s) would silently keep every assertion green.
    expect(OWNER_EVENT_POLL_INTERVAL_MS).toBeLessThanOrEqual(30_000);
    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toContain('event: caught_up');
    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: '1',
        ownerId: 'user:mine',
        sessionId: 'session-fallback',
        ts: 123,
        type: 'session_status',
        status: 'succeeded',
        attempt: 1,
      },
    ]);

    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledTimes(1);
    let delivered = false;
    const fallbackFrame = readNonHeartbeatChunk(reader).then((chunk) => {
      delivered = chunk.includes('id: 1\nevent: session_status');
      return chunk;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toBe(true);
    expect(await fallbackFrame).toContain('id: 1\nevent: session_status');
    expect(mocks.wake).toBeTypeOf('function'); // registered, deliberately never invoked
    await reader.cancel();
  });

  it('emits degraded caught_up after three failures and one authoritative recovery signal', async () => {
    mocks.readOwnerSessionEventsAfter.mockRejectedValue(new Error('pg unavailable'));

    const response = await call();
    const reader = response.body!.getReader();
    let settled = false;
    const firstFrame = readNonHeartbeatChunk(reader).then((chunk) => {
      settled = true;
      return chunk;
    });

    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS * 2 - 1);
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await firstFrame).toContain(
      'data: {"type":"caught_up","replayed":0,"fromEventId":"0","degraded":true}',
    );
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledTimes(3);

    mocks.readOwnerSessionEventsAfter.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    const recovered = await readNonHeartbeatChunk(reader);
    expect(recovered).toContain('event: caught_up');
    expect(recovered).not.toContain('"degraded":true');

    let repeated = false;
    const nextFrame = readChunk(reader).then((chunk) => {
      repeated = chunk.includes('event: caught_up');
      return chunk;
    });
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    expect(repeated).toBe(false);
    await reader.cancel();
    await nextFrame;
  });

  it('recovers authoritatively after the attach high-water query degrades three times', async () => {
    mocks.readOwnerSessionEventMaxId.mockRejectedValue(new Error('pg unavailable'));

    const response = await call();
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS * 2);
    expect(await readNonHeartbeatChunk(reader)).toContain(
      'data: {"type":"caught_up","replayed":0,"fromEventId":"0","degraded":true}',
    );
    expect(mocks.readOwnerSessionEventMaxId).toHaveBeenCalledTimes(3);
    expect(mocks.readOwnerSessionEventsAfter).not.toHaveBeenCalled();

    mocks.readOwnerSessionEventMaxId.mockResolvedValue(BigInt(0));
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    const recovered = await readNonHeartbeatChunk(reader);
    expect(recovered).toContain('event: caught_up');
    expect(recovered).not.toContain('"degraded":true');
    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith('user:mine', BigInt(0), 500);
    await reader.cancel();
  });

  it('withholds the recovery signal while the first recovered page is still full', async () => {
    mocks.readOwnerSessionEventsAfter.mockRejectedValue(new Error('pg unavailable'));
    const response = await call();
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS * 2);
    expect(await readNonHeartbeatChunk(reader)).toContain('"degraded":true');

    // Recovery lands on a FULL page: the backlog that piled up during the
    // degraded window is not drained yet, so announcing catch-up here would
    // repeat the lie the degraded signal exists to avoid.
    const fullPage = Array.from({ length: 500 }, (_, index) => ({
      id: String(index + 1),
      ownerId: 'user:mine',
      type: 'session_status' as const,
      sessionId: 'ses_backlog',
      ts: 1,
      status: 'running' as const,
      attempt: 0,
    }));
    mocks.readOwnerSessionEventsAfter.mockResolvedValue(fullPage);
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    // Each event is its own frame, so read until the last one of the page has
    // arrived rather than assuming a chunk count.
    let recovering = '';
    for (let read = 0; read < fullPage.length && !recovering.includes('id: 500\n'); read += 1) {
      recovering += await readNonHeartbeatChunk(reader);
    }
    expect(recovering).toContain('id: 1\nevent: session_status');
    expect(recovering).not.toContain('event: caught_up');
    // Still history, not live tail: the degraded catch-up set backlogDone
    // without draining.
    expect(recovering).toContain('"phase":"backlog"');

    // A short page proves exhaustion -> the authoritative signal goes out, but
    // only AFTER that page's events. Frame order is what separates a guarded
    // recovery from an unguarded one: without the exhaustion check the
    // caught_up would already have been queued behind the full page above,
    // and would therefore arrive BEFORE this event.
    mocks.readOwnerSessionEventsAfter.mockResolvedValue([
      {
        id: '900',
        ownerId: 'user:mine',
        type: 'session_status',
        sessionId: 'ses_tail',
        ts: 2,
        status: 'succeeded',
        attempt: 0,
      },
    ]);
    await vi.advanceTimersByTimeAsync(OWNER_EVENT_POLL_INTERVAL_MS);
    const tailEvent = await readNonHeartbeatChunk(reader);
    expect(tailEvent).toContain('id: 900\nevent: session_status');
    expect(tailEvent).not.toContain('event: caught_up');
    const recovered = await readChunk(reader);
    expect(recovered).toContain('event: caught_up');
    expect(recovered).not.toContain('"degraded":true');
    await reader.cancel();
  });

  it('emits a 25s SSE comment heartbeat and cancel clears every timer', async () => {
    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toContain('event: caught_up');
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS);
    expect(await readChunk(reader)).toBe(': ping\n\n');
    expect(mocks.readOwnerRetirement).toHaveBeenCalledTimes(1);

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS * 2);
    expect(mocks.readOwnerRetirement).toHaveBeenCalledTimes(1);
  });

  it('checks retirement only on heartbeat, emits owner_moved, and ends the established stream', async () => {
    mocks.resolveRequestOwnerId.mockReturnValueOnce('anon:old');
    mocks.readOwnerRetirement.mockResolvedValueOnce('user:new');

    const response = await call();
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toContain('event: caught_up');

    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_INTERVAL_MS - 1);
    expect(mocks.readOwnerRetirement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await readChunk(reader)).toBe(': ping\n\n');
    const moved = await readChunk(reader);
    expect(moved).toContain('event: owner_moved');
    expect(moved).toContain(
      'data: {"type":"owner_moved","newOwnerId":"user:new","action":"reconnect"}',
    );
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(mocks.readOwnerRetirement).toHaveBeenCalledWith('anon:old');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new connection resolves the merged identity and replays its events', async () => {
    mocks.resolveRequestOwnerId.mockReturnValueOnce('user:new');
    mocks.readOwnerSessionEventMaxId.mockResolvedValueOnce(BigInt(9));
    mocks.readOwnerSessionEventsAfter.mockResolvedValueOnce([
      {
        id: '9',
        ownerId: 'user:new',
        sessionId: 'session-after-merge',
        ts: 456,
        type: 'session_created',
        status: 'queued',
        attempt: 0,
      },
    ]);

    const response = await call({ header: '8' });
    const reader = response.body!.getReader();
    const event = await readChunk(reader);

    expect(mocks.readOwnerSessionEventsAfter).toHaveBeenCalledWith('user:new', BigInt(8), 500);
    expect(event).toContain('id: 9\nevent: session_created');
    await reader.cancel();
  });
});
