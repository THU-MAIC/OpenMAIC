import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunEventSource } from '@/lib/generation-run-client/follower';
import { OwnerRunsWatcher } from '@/lib/generation-run-client/owner-runs';
import { startDefinitelyRefused, wouldExceedRunLimits } from '@/lib/generation-run-client/start';
import { RunApiError } from '@/lib/generation-run-client/api';
import type { RunSnapshot } from '@/lib/generation-run-client/types';

import { snapshot } from './fixtures';

class FakeStream implements RunEventSource {
  listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();
  closed = false;
  readyState = 1;
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
  refuse() {
    this.readyState = 2;
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ data: '' } as MessageEvent<string>);
    }
  }
}

function setup(lists: RunSnapshot[][]) {
  const streams: FakeStream[] = [];
  const changed: string[] = [];
  const listActive = vi.fn(async () => ({
    runs: lists.length > 1 ? lists.shift()! : lists[0]!,
    limits: { maxActive: 2, maxWaiting: 10 },
  }));
  const watcher = new OwnerRunsWatcher({
    listActive,
    openStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
    onChange: () => {},
    onCourseChanged: (run) => changed.push(run.id),
    idlePollMs: 30_000,
    retryBaseMs: 100,
    random: () => 0.5,
  });
  const live = () => streams.filter((stream) => !stream.closed);
  return { watcher, streams, changed, listActive, live };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the owner run list', () => {
  it('holds the stream only while a run is in progress', async () => {
    const waiting = snapshot({ id: 'run-w', state: 'awaiting_outline_confirmation' });
    const { watcher, listActive, live } = setup([
      [waiting],
      [waiting, snapshot({ id: 'run-g', state: 'generating' })],
    ]);
    await watcher.poll();
    expect(watcher.current.runs).toHaveLength(1);
    // Only a waiting run: no stream, the list is read again later.
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listActive).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);
    // The generating run finishes: its course is in the library, and the stream goes.
    live()[0]!.emit('run', {
      type: 'run',
      run: snapshot({ id: 'run-g', state: 'completed', seq: 9, stageId: 'stage-g' }),
    });
    expect(watcher.current.runs.map((run) => run.id)).toEqual(['run-w']);
    expect(live()).toHaveLength(0);
    watcher.close();
  });

  it('backs off over consecutive refusals; a list read does not reset it, a stream frame does', async () => {
    const generating = snapshot({ id: 'run-g', state: 'generating' });
    const { watcher, listActive, live } = setup([[generating]]);
    await watcher.poll();
    live()[0]!.refuse();
    await vi.advanceTimersByTimeAsync(100);
    live()[0]!.refuse();
    // The second wait is twice the first, though the list read in between succeeded.
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toHaveLength(1);
    live()[0]!.refuse();
    await vi.advanceTimersByTimeAsync(300);
    expect(live()).toHaveLength(0);
    // Shown again while it waits: the backoff stands.
    await watcher.poll('visible');
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toHaveLength(1);
    // The stream attached: the next refusal waits the base delay again.
    live()[0]!.emit('runs', { type: 'runs', runs: [generating] });
    live()[0]!.refuse();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toHaveLength(1);
    expect(listActive.mock.calls.length).toBeGreaterThan(3);
    watcher.close();
  });

  it('reads the list again, with a backoff, when the stream is refused', async () => {
    const generating = snapshot({ id: 'run-g', state: 'generating' });
    const { watcher, listActive, live, streams } = setup([[generating]]);
    await watcher.poll();
    expect(live()).toHaveLength(1);
    streams[0]!.refuse();
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(listActive).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);
    watcher.close();
  });

  it('says when a run gains its course or leaves the list', async () => {
    const { watcher, changed, live } = setup([[snapshot({ id: 'run-g', state: 'generating' })]]);
    await watcher.poll();
    live()[0]!.emit('run', {
      type: 'run',
      run: snapshot({ id: 'run-g', state: 'generating', seq: 5, stageId: 'stage-g' }),
    });
    expect(changed).toEqual(['run-g']);
    watcher.close();
  });

  it('tells a start the limits would refuse before anything is uploaded', () => {
    const limits = { maxActive: 2, maxWaiting: 1 };
    expect(wouldExceedRunLimits([snapshot({ state: 'generating' })], limits)).toBe(false);
    expect(
      wouldExceedRunLimits(
        [snapshot({ state: 'generating' }), snapshot({ state: 'outlining' })],
        limits,
      ),
    ).toBe(true);
    // A paused run does not count; a waiting one counts against the waiting limit.
    expect(
      wouldExceedRunLimits([snapshot({ state: 'paused' }), snapshot({ state: 'paused' })], limits),
    ).toBe(false);
    expect(
      wouldExceedRunLimits([snapshot({ state: 'awaiting_outline_confirmation' })], limits),
    ).toBe(true);
  });

  it('releases the uploads of a start only when the server refused it', () => {
    const refused = (status: number) => new RunApiError(status, undefined, undefined, 'x');
    expect(startDefinitelyRefused(refused(429))).toBe(true);
    expect(startDefinitelyRefused(refused(400))).toBe(true);
    // A lost answer may hide a run that was created: its materials are kept.
    expect(startDefinitelyRefused(refused(502))).toBe(false);
    expect(startDefinitelyRefused(new TypeError('Failed to fetch'))).toBe(false);
    expect(startDefinitelyRefused(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});
