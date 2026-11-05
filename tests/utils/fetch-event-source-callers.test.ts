// @vitest-environment jsdom
/**
 * The product's stream callers on the real `FetchEventSource`: every other suite
 * for these callers drives a fake, which proves nothing about how the two fit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunFollower } from '@/lib/generation-run-client/follower';
import { OwnerRunsWatcher } from '@/lib/generation-run-client/owner-runs';
import type { RunSnapshot } from '@/lib/generation-run-client/types';
import { FetchEventSource } from '@/lib/utils/fetch-event-source';
import { OwnerSessionClient } from '@/lib/workbench/owner-session-client';

const sse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const refusedRedirect = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ type: 'opaqueredirect', body: null });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => new Response('x', { status: 429 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const movingRun = { id: 'r', seq: 1, state: 'generating', media: {}, outline: null, stageId: null };
const follower = () =>
  new RunFollower('r', {
    fetchSnapshot: async () => movingRun as unknown as RunSnapshot,
    openEvents: (url) => new FetchEventSource(url),
    onChange() {},
    random: () => 0.5,
    retryBaseMs: 1_000,
  });

describe('OwnerSessionClient', () => {
  it('owner_moved in one chunk closes the instance and starts over with no Last-Event-ID', async () => {
    const init: RequestInit[] = [];
    fetchMock.mockImplementation(async (_url: string, request: RequestInit) => {
      init.push(request);
      return init.length === 1
        ? sse(
            'id: 7\nevent: session_status\ndata: {}\n\nevent: owner_moved\ndata: {"type":"owner_moved","action":"reconnect"}\n\nevent: session_status\ndata: {}\n\n',
          )
        : sse('event: caught_up\ndata: {"type":"caught_up"}\n\n');
    });
    const client = new OwnerSessionClient({
      fetchSessions: async () => [],
      createEventSource: (url) => new FetchEventSource(url),
      onSessions() {},
      onState() {},
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(init).toHaveLength(2);
    expect(init[0]!.signal!.aborted).toBe(true);
    expect(init[1]!.headers).not.toHaveProperty('last-event-id');
    client.stop();
  });
});

describe('RunFollower', () => {
  it('backs off and retries when the stream is refused', async () => {
    const run = follower();
    await run.start();
    await vi.advanceTimersByTimeAsync(0);
    const refused = fetchMock.mock.calls.length;
    expect(refused).toBe(1);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(refused);
    run.close();
  });

  it('treats a redirect the browser refused as refused, not as a dropped connection', async () => {
    refusedRedirect(fetchMock);
    const warnings: string[] = [];
    const run = new RunFollower('r', {
      fetchSnapshot: async () => movingRun as unknown as RunSnapshot,
      openEvents: (url) => new FetchEventSource(url),
      onChange() {},
      onWarn: (message) => warnings.push(message),
      random: () => 0.5,
      retryBaseMs: 1_000,
    });
    await run.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warnings).toEqual(['The run event stream closed']);
    run.close();
  });
});

describe('OwnerRunsWatcher', () => {
  it('reads the list again when the stream is refused', async () => {
    const running = { id: 'r', state: 'generating' } as unknown as RunSnapshot;
    const listActive = vi.fn(async () => ({ runs: [running] }));
    const warnings: string[] = [];
    const watcher = new OwnerRunsWatcher({
      listActive: listActive as never,
      openStream: () => new FetchEventSource('/api/generation-runs/events'),
      onChange() {},
      onCourseChanged() {},
      onWarn: (message) => warnings.push(message),
      random: () => 0.5,
      retryBaseMs: 1_000,
    });
    await watcher.poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(warnings).toEqual(['The run list stream closed']);
    const reads = listActive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_250);
    expect(listActive.mock.calls.length).toBeGreaterThan(reads);
    watcher.close();
  });
});
