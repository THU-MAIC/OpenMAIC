import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MALFORMED_EVENT_RECONCILE_THRESHOLD,
  OWNER_SESSION_JOURNAL_LIMIT,
  OwnerSessionClient,
  STREAM_CONNECTING_SAMPLE_LIMIT,
  STREAM_HEALTH_SAMPLE_MS,
  compareDecimalCursor,
  type OwnerEventSource,
  type OwnerEventSourceInit,
} from '@/lib/workbench/owner-session-client';
import type { ProHomeSessionItem } from '@/lib/workbench/pro-home-data';

class FakeEventSource implements OwnerEventSource {
  readonly listeners = new Map<string, Set<EventListener>>();
  readyState = 1;
  closed = false;
  onerror: ((event: Event) => void) | null = null;

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function row(status: ProHomeSessionItem['status'], updatedAt: number): ProHomeSessionItem {
  return {
    id: 'session-1',
    stageId: 'course-1',
    prompt: 'Build a course',
    status,
    createdAt: 100,
    updatedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('owner session client', () => {
  it('publishes its list newest-first, whatever order the API answered in', async () => {
    // The rail renders in this order, so the contract is the client's own, not a
    // consumer's. (The course-chat bootstrap used to read it to find "the session
    // that owns this course"; that matching is gone — the panes are independent.)
    const old = { ...row('succeeded', 200), id: 'session-old' };
    const recent = { ...row('succeeded', 500), id: 'session-recent' };
    const published: ProHomeSessionItem[][] = [];
    const client = new OwnerSessionClient({
      fetchSessions: vi.fn(async () => [old, recent]),
      createEventSource: () => new FakeEventSource(),
      onSessions: (sessions) => published.push([...sessions]),
      onState: vi.fn(),
    });

    client.start();
    await flushPromises();

    expect(published.at(-1)?.map((session) => session.id)).toEqual([
      'session-recent',
      'session-old',
    ]);
    client.stop();
  });

  it('keeps bigint cursors as decimal strings and compares beyond Number precision', () => {
    expect.soft(compareDecimalCursor('90071992547409931', '90071992547409930')).toBe(1);
    expect.soft(compareDecimalCursor('90071992547409930', '90071992547409931')).toBe(-1);
    expect.soft(compareDecimalCursor('00042', '42')).toBe(0);
  });

  it('reapplies events newer than the fetch cursor over a slow full snapshot', async () => {
    const slowReconciliation = deferred<ProHomeSessionItem[]>();
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockResolvedValueOnce([row('queued', 150)])
      .mockReturnValueOnce(slowReconciliation.promise);
    const sources: FakeEventSource[] = [];
    const updates: (readonly ProHomeSessionItem[])[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: (sessions) => updates.push(sessions),
      onState: vi.fn(),
    });

    client.start();
    await flushPromises();
    client.requestFullFetch();
    sources[0]!.emit('session_status', {
      id: '90071992547409931',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_status',
      status: 'succeeded',
      attempt: 4,
    });
    slowReconciliation.resolve([row('running', 200)]);
    await flushPromises();

    expect.soft(updates.at(-1)?.[0]?.status).toBe('succeeded');
    expect.soft(updates.at(-1)?.[0]?.updatedAt).toBe(500);
    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('discards an old in-flight snapshot after owner movement advances the epoch', async () => {
    const oldOwnerFetch = deferred<ProHomeSessionItem[]>();
    const newOwnerFetch = deferred<ProHomeSessionItem[]>();
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockReturnValueOnce(oldOwnerFetch.promise)
      .mockReturnValueOnce(newOwnerFetch.promise);
    const sources: FakeEventSource[] = [];
    const updates: (readonly ProHomeSessionItem[])[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: (sessions) => updates.push(sessions),
      onState: vi.fn(),
    });

    client.start();
    sources[0]!.emit('owner_moved', {
      type: 'owner_moved',
      newOwnerId: 'user:new',
      action: 'reconnect',
    });
    oldOwnerFetch.resolve([row('failed', 300)]);
    await flushPromises();

    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);
    expect.soft(updates).toEqual([]);

    newOwnerFetch.resolve([row('succeeded', 500)]);
    await flushPromises();
    expect.soft(updates).toHaveLength(1);
    expect.soft(updates[0]?.[0]?.status).toBe('succeeded');
    client.stop();
  });

  it('wires an unknown session event to a full fetch', async () => {
    const fetchSessions = vi.fn(async () => [row('running', 200)]);
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });

    client.start();
    await flushPromises();
    sources[0]!.emit('session_status', {
      id: '41',
      sessionId: 'missing-session',
      ts: 400,
      phase: 'live',
      type: 'session_status',
      status: 'running',
      attempt: 1,
    });
    await flushPromises();

    expect(fetchSessions).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('reclaims the event journal after a successful reconciliation', async () => {
    const fetchSessions = vi.fn(async () => [row('running', 200)]);
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });

    client.start();
    await flushPromises();
    sources[0]!.emit('session_status', {
      id: '42',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_status',
      status: 'succeeded',
      attempt: 1,
    });
    client.requestFullFetch();
    await flushPromises();

    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);
    // Behavioural judge: a SECOND reconciliation must not replay the recycled
    // event. Replaying a session_status for a row the snapshot no longer knows
    // would report an unknown id and force a third fetch.
    client.requestFullFetch();
    await flushPromises();
    expect.soft(fetchSessions).toHaveBeenCalledTimes(3);
    // Internal-representation contract, kept as the direct judge of recycling:
    // renaming or restructuring `journal` should force a look at this test.
    const internals = client as unknown as { journal: unknown[] };
    expect.soft(internals.journal).toEqual([]);
    client.stop();
  });

  it('does not replay a journal event already included in the snapshot cursor', async () => {
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockResolvedValueOnce([row('running', 200)])
      .mockResolvedValue([]);
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });

    client.start();
    await flushPromises();
    sources[0]!.emit('session_deleted', {
      id: '43',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_deleted',
    });
    // Push the cursor PAST the event so the snapshot genuinely already contains
    // it; the handler's own `cursor = event.id` would only reach equality, which
    // does not isolate the `id <= snapshotCursor` filter being tested here.
    (client as unknown as { cursor: string }).cursor = '50';
    client.requestFullFetch();
    await flushPromises();

    expect(fetchSessions).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('does not restart a pending fetch when an in-flight fetch settles after stop', async () => {
    const inFlight = deferred<ProHomeSessionItem[]>();
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockReturnValue(inFlight.promise);
    const onSessions = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => new FakeEventSource(),
      onSessions,
      onState: vi.fn(),
    });

    client.start();
    client.requestFullFetch();
    client.stop();
    inFlight.resolve([row('succeeded', 500)]);
    await flushPromises();

    expect.soft(fetchSessions).toHaveBeenCalledTimes(1);
    expect.soft(onSessions).not.toHaveBeenCalled();
  });

  it('advances the cursor so a later snapshot does not replay an included event', async () => {
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockResolvedValueOnce([row('running', 200)])
      .mockResolvedValue([]);
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });

    client.start();
    await flushPromises();
    sources[0]!.emit('session_deleted', {
      id: '44',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_deleted',
    });
    client.requestFullFetch();
    await flushPromises();

    expect(fetchSessions).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('closes the retired stream, opens a cursor-free replacement, and reconciles', async () => {
    const fetchSessions = vi.fn(async () => [row('running', 200)]);
    const urls: string[] = [];
    const connectionHeaders: Record<string, string>[] = [];
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: (url, init?: OwnerEventSourceInit) => {
        urls.push(url);
        connectionHeaders.push(
          Object.fromEntries(
            Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
          ),
        );
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });
    client.start();
    await flushPromises();

    sources[0]!.emit('session_status', {
      id: '44',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_status',
      status: 'succeeded',
      attempt: 1,
    });

    sources[0]!.emit('owner_moved', {
      type: 'owner_moved',
      newOwnerId: 'user:new',
      action: 'reconnect',
    });
    await flushPromises();

    expect.soft(sources[0]!.closed).toBe(true);
    expect.soft(sources).toHaveLength(2);
    expect.soft(urls).toEqual(['/api/agent/owner-events', '/api/agent/owner-events']);
    expect.soft(connectionHeaders[1]?.['last-event-id']).toBeUndefined();
    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('handles resync_required in place by clearing journal, adopting max, and fetching once', async () => {
    const resyncFetch = deferred<ProHomeSessionItem[]>();
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockResolvedValueOnce([row('running', 200)])
      .mockReturnValueOnce(resyncFetch.promise);
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });
    client.start();
    await flushPromises();
    sources[0]!.emit('session_status', {
      id: '45',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_status',
      status: 'succeeded',
      attempt: 1,
    });

    sources[0]!.emit('resync_required', {
      type: 'resync_required',
      reason: 'cursor_ahead',
      fromEventId: '999',
      currentEventId: '40',
    });

    const internals = client as unknown as { cursor: string; journal: unknown[] };
    expect.soft(internals.cursor).toBe('40');
    expect.soft(internals.journal).toEqual([]);
    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);
    expect.soft(sources).toHaveLength(1);
    expect.soft(sources[0]!.closed).toBe(false);
    resyncFetch.resolve([row('running', 600)]);
    await flushPromises();
    client.stop();
  });

  it('does not initialize on degraded catch-up and initializes once on authoritative recovery', async () => {
    const sources: FakeEventSource[] = [];
    const initialized = vi.fn();
    const fetchSessions = vi.fn(async () => [row('running', 200)]);
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
      onInitialized: initialized,
    });
    client.start();
    await flushPromises();

    sources[0]!.emit('caught_up', { type: 'caught_up', degraded: true });
    await flushPromises();
    expect.soft(initialized).not.toHaveBeenCalled();
    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);

    sources[0]!.emit('caught_up', { type: 'caught_up' });
    sources[0]!.emit('caught_up', { type: 'caught_up' });
    expect.soft(initialized).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('reports a stream stuck connecting, and does so on samples rather than wall clock', async () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    const onState = vi.fn();
    const onStreamHealth = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions: vi.fn(async () => [row('running', 200)]),
      createEventSource: () => source,
      onSessions: vi.fn(),
      onState,
      onStreamHealth,
    });
    client.start();
    await flushPromises();
    onState.mockClear();

    // Only periodic sampling here -- `onerror` deliberately samples once
    // immediately, so calling it would shift the count by one and make this
    // judge about the arithmetic instead of the threshold.
    source.readyState = 0;
    // One sample short of the limit: still no report.
    await vi.advanceTimersByTimeAsync(
      STREAM_HEALTH_SAMPLE_MS * (STREAM_CONNECTING_SAMPLE_LIMIT - 1),
    );
    expect(onStreamHealth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STREAM_HEALTH_SAMPLE_MS);
    expect(onStreamHealth).toHaveBeenLastCalledWith(false);
    // Liveness is NOT a list error: the rail only renders its error state on an
    // empty list, where that plus an inert retry button is worse than nothing.
    expect(onState).not.toHaveBeenCalledWith('error');

    source.readyState = 1;
    await vi.advanceTimersByTimeAsync(STREAM_HEALTH_SAMPLE_MS);
    expect(onStreamHealth).toHaveBeenLastCalledWith(true);
    client.stop();
  });

  it('does not report a dead stream after a long gap with no samples', async () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    const onStreamHealth = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions: vi.fn(async () => [row('running', 200)]),
      createEventSource: () => source,
      onSessions: vi.fn(),
      onState: vi.fn(),
      onStreamHealth,
    });
    client.start();
    await flushPromises();

    // A suspended tab freezes the interval but not the clock. Simulate the wake
    // by advancing far past the wall-clock grace with only ONE sample firing:
    // a wall-clock threshold would report a dead stream here, a sample count
    // must not.
    source.readyState = 0;
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(STREAM_HEALTH_SAMPLE_MS);
    expect(onStreamHealth).not.toHaveBeenCalled();
    client.stop();
  });

  it('returns the list to ready on a successful fetch even while the stream is degraded', async () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    const onState = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions: vi.fn(async () => [row('running', 200)]),
      createEventSource: () => source,
      onSessions: vi.fn(),
      onState,
      onStreamHealth: vi.fn(),
    });
    client.start();
    await flushPromises();

    source.readyState = 0;
    await vi.advanceTimersByTimeAsync(STREAM_HEALTH_SAMPLE_MS * STREAM_CONNECTING_SAMPLE_LIMIT);
    onState.mockClear();
    // A full read of the list is authoritative regardless of push health, so
    // the retry path must be able to clear an error rather than stick forever.
    client.requestFullFetch();
    await flushPromises();
    expect(onState).toHaveBeenLastCalledWith('ready');
    client.stop();
  });

  it('retries a failed full fetch when authoritative catch-up arrives', async () => {
    const sources: FakeEventSource[] = [];
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([row('succeeded', 500)]);
    const onState = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState,
    });
    client.start();
    await flushPromises();
    expect.soft(fetchSessions).toHaveBeenCalledTimes(1);
    expect.soft(onState).toHaveBeenLastCalledWith('error');

    sources[0]!.emit('caught_up', { type: 'caught_up' });
    await flushPromises();
    expect.soft(fetchSessions).toHaveBeenCalledTimes(2);
    expect.soft(onState).toHaveBeenLastCalledWith('ready');
    client.stop();
  });

  it('bounds the journal and converges through a forced authoritative fetch', async () => {
    const slowFetch = deferred<ProHomeSessionItem[]>();
    const fetchSessions = vi
      .fn<() => Promise<ProHomeSessionItem[]>>()
      .mockResolvedValueOnce([row('running', 200)])
      .mockReturnValueOnce(slowFetch.promise)
      .mockResolvedValueOnce([row('succeeded', 10_000)]);
    const sources: FakeEventSource[] = [];
    const updates: (readonly ProHomeSessionItem[])[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: (sessions) => updates.push(sessions),
      onState: vi.fn(),
    });
    client.start();
    await flushPromises();
    client.requestFullFetch();

    for (let index = 0; index <= OWNER_SESSION_JOURNAL_LIMIT; index += 1) {
      sources[0]!.emit('session_status', {
        id: String(index + 1),
        sessionId: 'session-1',
        ts: 1_000 + index,
        phase: 'live',
        type: 'session_status',
        status: index === OWNER_SESSION_JOURNAL_LIMIT ? 'failed' : 'running',
        attempt: 1,
      });
    }
    const internals = client as unknown as { journal: unknown[] };
    expect.soft(internals.journal).toHaveLength(OWNER_SESSION_JOURNAL_LIMIT);

    slowFetch.resolve([row('running', 300)]);
    await flushPromises();
    expect.soft(fetchSessions).toHaveBeenCalledTimes(3);
    expect.soft(updates.at(-1)?.[0]?.status).toBe('succeeded');
    client.stop();
  });

  it('forces one reconciliation after five consecutive malformed events', async () => {
    const fetchSessions = vi.fn(async () => [row('running', 200)]);
    const sources: FakeEventSource[] = [];
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onSessions: vi.fn(),
      onState: vi.fn(),
    });
    client.start();
    await flushPromises();

    for (let index = 0; index < MALFORMED_EVENT_RECONCILE_THRESHOLD - 1; index += 1) {
      sources[0]!.emit('session_status', { id: '007', type: 'session_status' });
    }
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    sources[0]!.emit('session_status', { id: '007', type: 'session_status' });
    await flushPromises();
    expect(fetchSessions).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('resets cursor and journal when stopped', async () => {
    const source = new FakeEventSource();
    const client = new OwnerSessionClient({
      fetchSessions: vi.fn(async () => [row('running', 200)]),
      createEventSource: () => source,
      onSessions: vi.fn(),
      onState: vi.fn(),
    });
    client.start();
    await flushPromises();
    source.emit('session_status', {
      id: '45',
      sessionId: 'session-1',
      ts: 500,
      phase: 'live',
      type: 'session_status',
      status: 'succeeded',
      attempt: 1,
    });
    const internals = client as unknown as { cursor: string; journal: unknown[] };
    expect.soft(internals.cursor).toBe('45');
    expect.soft(internals.journal).toHaveLength(1);

    client.stop();
    expect.soft(internals.cursor).toBe('0');
    expect.soft(internals.journal).toEqual([]);
  });

  it('makes one steady-state full request per minute with per-tab jitter', async () => {
    vi.useFakeTimers();
    const fetchSessions = vi.fn(async () => [row('running', 200)]);
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => new FakeEventSource(),
      onSessions: vi.fn(),
      onState: vi.fn(),
      random: () => 0.5,
    });
    client.start();
    await flushPromises();
    expect(fetchSessions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(67_499);
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSessions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 67_500);
    expect(fetchSessions).toHaveBeenCalledTimes(4);
    client.stop();
  });
});
