// @vitest-environment jsdom

/**
 * The standalone classroom page has no workspace around it to run the freshness
 * sync, so a tab left open there holds its copy until a reload. While it is in
 * Edit, where that copy is what gets saved, it follows the server. The real hook,
 * sync and stage store run here; only fetch, EventSource and the storage module's
 * write are faked.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sceneRev: 1,
  stageRev: 1,
  title: 'on the server',
  manifestStatus: 200,
  fetches: [] as string[],
}));

vi.mock('@/lib/live-mode', () => ({ isLiveMode: true }));
vi.mock('@/lib/workbench/session-store', () => ({
  appendCompactedReplayEvent: vi.fn(),
  compactReplayEvents: vi.fn(),
  useWorkbenchStore: { getState: () => ({ panelOpen: true, playbackOn: false }) },
}));
vi.mock('@/lib/document-store/store', () => ({
  getDocumentStore: () => ({ loadDocument: vi.fn() }),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue({ failedChanges: [] }),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      agentMode: 'auto',
      selectedAgentIds: [],
      agentSelectionIsUserSet: false,
      setSelectedAgentIds: vi.fn(),
      setAgentSelectionIsUserSet: vi.fn(),
    }),
  },
}));

import { useEditModeFreshness } from '@/lib/classroom/use-edit-mode-freshness';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockEventSource {
  static instances: MockEventSource[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (() => void)[]>();
  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emitFreshness() {
    for (const fn of this.listeners.get('stage_freshness') ?? []) fn();
  }
}

function scene(title: string): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-a',
    order: 0,
    title,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [] } },
  } as unknown as Scene;
}

function Harness({ variant }: { variant: 'page' | 'pane' }) {
  useEditModeFreshness('stage-a', variant);
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;

async function open(variant: 'page' | 'pane' = 'page') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Harness, { variant })));
}

async function setMode(mode: 'edit' | 'playback') {
  await act(async () => useStageStore.getState().setMode(mode));
}

async function settle(ms = 1_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.sceneRev = 1;
  mocks.stageRev = 1;
  mocks.title = 'on the server';
  mocks.manifestStatus = 200;
  mocks.fetches = [];
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      mocks.fetches.push(url);
      if (url.includes('/manifest')) {
        if (mocks.manifestStatus !== 200) {
          return { ok: false, status: mocks.manifestStatus, json: async () => ({}) };
        }
        const body = {
          rev: mocks.stageRev,
          scenes: [{ id: 'scene-1', order: 0, rev: mocks.sceneRev }],
        };
        return { ok: true, status: 200, json: async () => body };
      }
      if (url.includes('/scenes?')) {
        return { ok: true, status: 200, json: async () => ({ scenes: [scene(mocks.title)] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  useStageStore.setState({
    stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [scene('loaded earlier')],
    currentSceneId: 'scene-1',
    mode: 'playback',
    readOnly: false,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useStageStore.getState().clearStore();
  useStageStore.setState({ serverManifestByStage: {}, mode: 'playback', readOnly: false });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the freshness sync on the standalone classroom page', () => {
  it('stays off during playback', async () => {
    await open();
    await settle(40_000);

    expect(MockEventSource.instances).toEqual([]);
    expect(mocks.fetches).toEqual([]);
  });

  it('in Edit, brings in what changed while the tab was playing', async () => {
    await open();
    await setMode('edit');
    await act(async () => MockEventSource.instances[0]!.onopen?.());
    await settle();

    expect(useStageStore.getState().scenes[0]!.title).toBe('on the server');
  });

  it('in Edit, follows a change made while editing', async () => {
    await open();
    await setMode('edit');
    const source = MockEventSource.instances[0]!;
    await act(async () => source.onopen?.());
    await settle();

    mocks.title = 'an agent changed it';
    mocks.sceneRev += 1;
    mocks.stageRev += 1;
    await act(async () => source.emitFreshness());

    expect(useStageStore.getState().scenes[0]!.title).toBe('an agent changed it');
  });

  it('stops when Edit ends, and starts over the next time', async () => {
    await open();
    await setMode('edit');
    const first = MockEventSource.instances[0]!;
    await settle();

    await setMode('playback');
    expect(first.closed).toBe(true);
    mocks.fetches = [];
    await settle(40_000);
    expect(mocks.fetches).toEqual([]);

    await setMode('edit');
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]!.closed).toBe(false);
  });

  it('re-entering Edit reads nothing that has not changed, and keeps the objects', async () => {
    await open();
    await setMode('edit');
    await act(async () => MockEventSource.instances[0]!.onopen?.());
    await settle();
    await setMode('playback');
    const held = useStageStore.getState().scenes[0];
    mocks.fetches = [];

    await setMode('edit');
    await act(async () => MockEventSource.instances[1]!.onopen?.());
    await settle();

    expect(mocks.fetches.filter((url) => url.includes('/scenes?'))).toEqual([]);
    expect(mocks.fetches.filter((url) => url.includes('/roster'))).toEqual([]);
    expect(useStageStore.getState().scenes[0]).toBe(held);
  });

  it('re-entering Edit reads what changed in between', async () => {
    await open();
    await setMode('edit');
    await act(async () => MockEventSource.instances[0]!.onopen?.());
    await settle();
    await setMode('playback');

    mocks.title = 'changed while playing';
    mocks.sceneRev += 1;
    mocks.stageRev += 1;
    await setMode('edit');
    await act(async () => MockEventSource.instances[1]!.onopen?.());
    await settle();

    expect(useStageStore.getState().scenes[0]!.title).toBe('changed while playing');
  });

  it('re-entering Edit reads a scene a sync that started cold never applied', async () => {
    useStageStore.setState({ scenes: [] });
    await open();
    await setMode('edit');
    await act(async () => MockEventSource.instances[0]!.onopen?.());
    await settle();
    expect(useStageStore.getState().scenes).toEqual([]);

    // The store fills with something else: the manifest's scene never reached it.
    useStageStore.setState({ scenes: [{ ...scene('local'), id: 'local' }] });
    await setMode('playback');
    await setMode('edit');
    await act(async () => MockEventSource.instances[1]!.onopen?.());
    await settle();

    expect(useStageStore.getState().scenes.map((held) => held.id)).toContain('scene-1');
  });

  it('stays off for a read-only viewer, in any mode', async () => {
    useStageStore.setState({ readOnly: true });
    await open();
    await setMode('edit');
    await settle(40_000);

    expect(MockEventSource.instances).toEqual([]);
    expect(mocks.fetches).toEqual([]);
  });

  it('stays off while the store holds another course', async () => {
    useStageStore.setState({
      stage: { id: 'stage-other', name: 'Other', createdAt: 1, updatedAt: 1 } as Stage,
    });
    await open();
    await setMode('edit');
    await settle(40_000);

    expect(MockEventSource.instances).toEqual([]);
    expect(mocks.fetches).toEqual([]);
  });

  it('leaves the workspace pane to the sync its host runs', async () => {
    await open('pane');
    await setMode('edit');
    await settle(40_000);

    expect(MockEventSource.instances).toEqual([]);
  });

  it('does not spin when the server answers 404', async () => {
    mocks.manifestStatus = 404;
    await open();
    await setMode('edit');
    await settle(60_000);

    // The bounded retry budget, then the slow fallback clock.
    const manifestReads = mocks.fetches.filter((url) => url.includes('/manifest')).length;
    expect(manifestReads).toBeLessThanOrEqual(9);
    expect(manifestReads).toBeGreaterThan(0);
  });
});
