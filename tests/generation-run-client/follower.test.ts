import { describe, expect, it, vi } from 'vitest';

import {
  RunFollower,
  type RunEventSource,
  type RunFollowerState,
} from '@/lib/generation-run-client/follower';
import type { RunSnapshot } from '@/lib/generation-run-client/types';

import { outline, snapshot } from './fixtures';

class FakeSource implements RunEventSource {
  listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
  frame(seq: number, type: string, data: Record<string, unknown> = {}) {
    this.emit(type, { runId: 'run-AAAAAAAAAAAAAAAA', seq, ts: 0, type, data, phase: 'live' });
  }
}

function setup(snapshots: Array<RunSnapshot | null>) {
  const sources: FakeSource[] = [];
  const states: RunFollowerState[] = [];
  const fetchSnapshot = vi.fn(async () => {
    const next = snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!;
    return next;
  });
  const follower = new RunFollower('run-AAAAAAAAAAAAAAAA', {
    fetchSnapshot,
    openEvents: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    onChange: (state) => states.push(state),
  });
  return { follower, sources, states, fetchSnapshot };
}

const ready = {
  outlines: [outline(1), outline(2)],
  languageDirective: 'en',
  taskEngineMode: false,
  revision: 1,
};

describe('RunFollower', () => {
  it('rebuilds the view from the snapshot and the events after its seq', async () => {
    const { follower, sources } = setup([
      snapshot({
        state: 'generating',
        seq: 20,
        outline: ready,
        progress: { scenesTotal: 2, scenesCompleted: 0 },
      }),
    ]);
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
    const first = snapshot({
      state: 'generating',
      seq: 10,
      outline: ready,
      progress: { scenesTotal: 2, scenesCompleted: 0 },
    });
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(later);
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
    // A kept event arrives while the snapshot is read.
    sources[0]!.frame(31, 'media', {
      elementId: 'gen_img_1',
      mediaType: 'image',
      status: 'done',
      assetId: 'asset-1',
    });
    release(
      snapshot({
        state: 'completed',
        seq: 30,
        outline: ready,
        stageId: 'stage-1',
        progress: { scenesTotal: 2, scenesCompleted: 2 },
      }),
    );
    await follower.resync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const view = follower.current.view!;
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(view.state).toBe('completed');
    expect(view.progress.scenesCompleted).toBe(2);
    expect(view.media.gen_img_1).toMatchObject({ status: 'done', assetId: 'asset-1' });
    expect(view.seq).toBe(31);
  });

  it('reads the snapshot for an edited outline once it is confirmed', async () => {
    const edited = { ...ready, outlines: [outline(1, 'Edited')], revision: 2 };
    const { follower, sources, fetchSnapshot } = setup([
      snapshot({ state: 'awaiting_outline_confirmation', seq: 8, outline: ready }),
      snapshot({ state: 'generating', seq: 10, outline: edited }),
    ]);
    await follower.start();
    sources[0]!.frame(9, 'outline_confirmed', { revision: 2, edited: true });
    sources[0]!.frame(10, 'state', { state: 'generating', step: null });
    await follower.resync();
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(follower.current.view?.outline?.outlines.map((o) => o.title)).toEqual(['Edited']);
    expect(follower.current.view?.state).toBe('generating');
  });

  it('reports a run the owner does not have, and stops on close', async () => {
    const missing = setup([null]);
    await missing.follower.start();
    expect(missing.follower.current.status).toBe('missing');
    expect(missing.sources).toHaveLength(0);

    const live = setup([snapshot({ state: 'generating', seq: 1, outline: ready })]);
    await live.follower.start();
    live.follower.close();
    expect(live.sources[0]!.closed).toBe(true);
    const before = live.states.length;
    live.sources[0]!.frame(2, 'state', { state: 'paused', step: 'agents' });
    expect(live.states.length).toBe(before);
  });
});
