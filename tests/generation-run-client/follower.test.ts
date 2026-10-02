import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mergeSnapshotView,
  RunFollower,
  type RunEventSource,
  type RunFollowerState,
} from '@/lib/generation-run-client/follower';
import { viewFromSnapshot } from '@/lib/generation-run-client/reducer';
import type { RunSnapshot } from '@/lib/generation-run-client/types';

import { outline, snapshot } from './fixtures';

class FakeSource implements RunEventSource {
  listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();
  closed = false;
  readyState = 1;
  constructor(readonly url: string) {}
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
  frame(seq: number, type: string, data: Record<string, unknown> = {}) {
    this.emit(type, { runId: 'run-AAAAAAAAAAAAAAAA', seq, ts: 0, type, data, phase: 'live' });
  }
  /** The browser gave up on the stream (a refusal: the stream cap, a 404, a 5xx). */
  refuse() {
    this.readyState = 2;
    for (const listener of this.listeners.get('error') ?? []) {
      listener({ data: '' } as MessageEvent<string>);
    }
  }
}

type SnapshotReply = RunSnapshot | null | Error;

function setup(replies: SnapshotReply[]) {
  const sources: FakeSource[] = [];
  const states: RunFollowerState[] = [];
  const fetchSnapshot = vi.fn(async () => {
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const follower = new RunFollower('run-AAAAAAAAAAAAAAAA', {
    fetchSnapshot,
    openEvents: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    onChange: (state) => states.push(state),
    pollIntervalMs: 1_000,
    quietPollIntervalMs: 5_000,
    retryBaseMs: 100,
    random: () => 0.5,
  });
  const live = () => sources.filter((source) => !source.closed);
  return { follower, sources, states, fetchSnapshot, live };
}

const ready = {
  outlines: [outline(1), outline(2)],
  languageDirective: 'en',
  taskEngineMode: false,
  revision: 1,
};
const generating = (patch: Partial<RunSnapshot> = {}) =>
  snapshot({
    state: 'generating',
    seq: 20,
    outline: ready,
    progress: { scenesTotal: 2, scenesCompleted: 0 },
    ...patch,
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RunFollower', () => {
  it('rebuilds the view from the snapshot and the events after its seq', async () => {
    const { follower, sources } = setup([generating()]);
    await follower.start();
    expect(sources[0]!.url).toBe('/api/generation-runs/run-AAAAAAAAAAAAAAAA/events?after=20');
    sources[0]!.frame(21, 'course_created', { stageId: 'stage-1' });
    sources[0]!.frame(22, 'scene_ready', { index: 0, sceneId: 's1', order: 1 });
    sources[0]!.emit('caught_up', { type: 'caught_up', seq: 22 });
    expect(follower.current.caughtUp).toBe(true);
    expect(follower.current.view?.stageId).toBe('stage-1');
    expect(follower.current.view?.progress.scenesCompleted).toBe(1);
  });

  it('replays a run that has not reached its outline from its first event', async () => {
    const { follower, sources } = setup([snapshot({ state: 'outlining', seq: 6 })]);
    await follower.start();
    expect(sources[0]!.url).toMatch(/after=0$/);
    sources[0]!.frame(5, 'outline_item', { index: 0, outline: outline(1) });
    sources[0]!.frame(6, 'outline_item', { index: 1, outline: outline(2) });
    expect(follower.current.view?.streamingOutlines).toHaveLength(2);
  });

  it('answers resync with the snapshot and folds frames that arrive meanwhile after it', async () => {
    let release!: (value: RunSnapshot) => void;
    const later = new Promise<RunSnapshot>((resolve) => (release = resolve));
    const sources: FakeSource[] = [];
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(generating({ seq: 10 }))
      .mockReturnValueOnce(later);
    const follower = new RunFollower('run-AAAAAAAAAAAAAAAA', {
      fetchSnapshot,
      openEvents: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      onChange: () => {},
    });
    await follower.start();
    sources[0]!.emit('resync', { type: 'resync', reason: 'compacted', from: 10, oldestSeq: 30 });
    sources[0]!.frame(31, 'media', {
      elementId: 'gen_img_1',
      mediaType: 'image',
      status: 'done',
      assetId: 'asset-1',
    });
    release(generating({ state: 'completed', seq: 30, stageId: 'stage-1' }));
    await follower.resync();
    const view = follower.current.view!;
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(view.state).toBe('completed');
    expect(view.media.gen_img_1).toMatchObject({ status: 'done', assetId: 'asset-1' });
    expect(view.seq).toBe(31);
    follower.close();
  });

  it('reads the snapshot for an edited outline once it is confirmed on the stream', async () => {
    const edited = { ...ready, outlines: [outline(1, 'Edited')], revision: 2 };
    const { follower, sources, fetchSnapshot } = setup([
      snapshot({ state: 'outlining', seq: 3 }),
      generating({ seq: 10, outline: edited }),
    ]);
    await follower.start();
    sources[0]!.frame(7, 'outline_ready', { revision: 1, outline: ready });
    sources[0]!.frame(8, 'state', { state: 'awaiting_outline_confirmation', step: null });
    sources[0]!.frame(9, 'outline_confirmed', { revision: 2, edited: true });
    sources[0]!.frame(10, 'state', { state: 'generating', step: null });
    await follower.resync();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(follower.current.view?.outline?.outlines.map((o) => o.title)).toEqual(['Edited']);
    follower.close();
  });

  it('holds no stream for a run waiting on its owner, reads it now and then, and follows it when it moves', async () => {
    const { follower, sources, fetchSnapshot, live } = setup([
      snapshot({ state: 'awaiting_outline_confirmation', seq: 8, outline: ready }),
      snapshot({ state: 'awaiting_outline_confirmation', seq: 8, outline: ready }),
      generating({ seq: 10 }),
    ]);
    await follower.start();
    expect(sources).toHaveLength(0);
    expect(follower.current.caughtUp).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(0);
    // Confirmed in another tab: the next read finds it generating.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.url).toMatch(/after=10$/);
    // Paused: the stream goes, the run is read now and then again.
    live()[0]!.frame(11, 'step_failed', { step: 'scene:0:content', message: 'x' });
    live()[0]!.frame(12, 'state', { state: 'paused', step: 'scene:0:content' });
    live()[0]!.emit('caught_up', { type: 'caught_up', seq: 12 });
    expect(live()).toHaveLength(0);
    follower.close();
  });

  it('reopens a stream the server refused, reading the snapshot meanwhile', async () => {
    const { follower, sources, fetchSnapshot, live } = setup([generating({ seq: 20 })]);
    await follower.start();
    sources[0]!.frame(21, 'scene_ready', { index: 0, sceneId: 's1', order: 1 });
    sources[0]!.refuse();
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);
    // From what the view holds, not from the start.
    expect(live()[0]!.url).toMatch(/after=21$/);
    // Refused again: the next try waits longer.
    live()[0]!.refuse();
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toHaveLength(1);
    follower.close();
  });

  it('keeps trying a run it cannot read, reporting it as unreadable rather than missing', async () => {
    const { follower, states, live } = setup([new Error('503'), new Error('503'), generating()]);
    await follower.start();
    expect(follower.current.status).toBe('error');
    await vi.advanceTimersByTimeAsync(100);
    expect(follower.current.status).toBe('error');
    await vi.advanceTimersByTimeAsync(200);
    expect(follower.current.status).toBe('live');
    expect(live()).toHaveLength(1);
    expect(states.some((state) => state.status === 'missing')).toBe(false);
    follower.close();
  });

  it('closes the stream of a settled finished run and follows it again for a media Retry', async () => {
    const { follower, sources, live } = setup([
      generating({ state: 'completed', seq: 30, stageId: 'stage-1' }),
      generating({
        state: 'completed',
        seq: 31,
        stageId: 'stage-1',
        media: { gen_img_1: { mediaType: 'image', status: 'pending' } },
      }),
    ]);
    await follower.start();
    expect(sources).toHaveLength(0);
    await follower.wake();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.url).toMatch(/after=31$/);
    live()[0]!.frame(32, 'media', {
      elementId: 'gen_img_1',
      mediaType: 'image',
      status: 'done',
      assetId: 'a',
    });
    live()[0]!.emit('caught_up', { type: 'caught_up', seq: 32 });
    expect(live()).toHaveLength(0);
    expect(follower.current.view?.media.gen_img_1).toMatchObject({ status: 'done' });
    follower.close();
  });

  it('reports a run the owner does not have, and stops on close', async () => {
    const missing = setup([null]);
    await missing.follower.start();
    expect(missing.follower.current.status).toBe('missing');
    expect(missing.sources).toHaveLength(0);

    const live = setup([generating({ seq: 1 })]);
    await live.follower.start();
    live.follower.close();
    expect(live.sources[0]!.closed).toBe(true);
    const before = live.states.length;
    live.sources[0]!.frame(2, 'state', { state: 'paused', step: 'agents' });
    expect(live.states.length).toBe(before);
  });
});

describe('failure identities', () => {
  it('are the seq of the event that reported the failure, from the snapshot or the log', () => {
    const paused = generating({
      state: 'paused',
      seq: 40,
      error: { step: 'scene:1:content', message: 'x', failureSeq: 33 },
      media: {
        gen_img_1: { mediaType: 'image', status: 'failed', retryable: true, failureSeq: 37 },
      },
    });
    const view = viewFromSnapshot(paused);
    expect(view.failedSeq).toBe(33);
    expect(view.media.gen_img_1!.seq).toBe(37);
    // A second failure of the same step is a new identity (a new Retry command).
    const again = mergeSnapshotView(
      view,
      generating({
        state: 'paused',
        seq: 60,
        error: { step: 'scene:1:content', message: 'y', failureSeq: 58 },
        media: {
          gen_img_1: { mediaType: 'image', status: 'failed', retryable: true, failureSeq: 55 },
        },
      }),
    );
    expect(again.failedSeq).toBe(58);
    expect(again.media.gen_img_1!.seq).toBe(55);
  });
});

describe('RunFollower reads', () => {
  it('replays the outline items logged while its stream was down, from its own cursor', async () => {
    const { follower, sources, live } = setup([
      snapshot({ state: 'outlining', seq: 3 }),
      // Read on reconnect: still outlining, so the items are in the log only.
      snapshot({ state: 'outlining', seq: 9 }),
    ]);
    await follower.start();
    sources[0]!.frame(4, 'outline_item', { index: 0, outline: outline(1) });
    sources[0]!.refuse();
    await vi.advanceTimersByTimeAsync(100);
    // Followed again from seq 4, not from the snapshot's 9.
    expect(live()[0]!.url).toMatch(/after=4$/);
    live()[0]!.frame(5, 'outline_reset');
    live()[0]!.frame(6, 'outline_item', { index: 0, outline: outline(1, 'Again') });
    live()[0]!.frame(7, 'outline_item', { index: 1, outline: outline(2) });
    expect(follower.current.view?.streamingOutlines.map((o) => o.title)).toEqual([
      'Again',
      'Scene 2',
    ]);
    follower.close();
  });

  it('ignores a snapshot older than what the view holds', async () => {
    let releaseOld!: (value: RunSnapshot) => void;
    const old = new Promise<RunSnapshot>((resolve) => (releaseOld = resolve));
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(generating({ seq: 20 }))
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(generating({ state: 'paused', seq: 40 }));
    const follower = new RunFollower('run-AAAAAAAAAAAAAAAA', {
      fetchSnapshot,
      openEvents: (url) => new FakeSource(url),
      onChange: () => {},
      random: () => 0.5,
    });
    await follower.start();
    const first = follower.resync();
    // A newer frame lands while the slow read is in flight.
    releaseOld(generating({ state: 'generating', seq: 10 }));
    await first;
    expect(follower.current.view?.seq).toBe(20);
    await follower.wake();
    expect(follower.current.view?.state).toBe('paused');
    follower.close();
  });

  it('keeps its backoff when the page is shown again', async () => {
    const { follower, fetchSnapshot } = setup([new Error('503'), new Error('503'), generating()]);
    await follower.start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await follower.wake('visible');
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    follower.close();
  });
});
