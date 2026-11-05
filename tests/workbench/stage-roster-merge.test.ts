// @vitest-environment jsdom

/**
 * The roster three-way merge of the freshness sync, against the REAL stage
 * store and its save queue: what the classroom shows, and what the next
 * flush would write, when the agent changes the roster while this browser
 * has stage edits of its own pending.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manifest: { rev: 1, scenes: [{ id: 'scene-1', order: 0, rev: 1 }] },
  roster: null as Record<string, unknown> | null,
  rosterFetchCount: 0,
  settingsState: {
    agentMode: 'auto' as 'preset' | 'auto',
    selectedAgentIds: [] as string[],
    agentSelectionIsUserSet: false,
    setSelectedAgentIds: vi.fn(),
    setAgentSelectionIsUserSet: vi.fn(),
  },
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
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  applyGeneratedAgentsToRegistry: vi.fn((_stageId: string, configs: { id: string }[]) =>
    configs.map((config) => config.id),
  ),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => mocks.settingsState },
}));

import {
  hasUnsavedStageEdit,
  markStagePersistenceDirty,
  serverRosterBaseOf,
  useStageStore,
} from '@/lib/store/stage';
import type { GeneratedAgentConfig, Stage } from '@/lib/types/stage';
import { saveStageDataIncremental } from '@/lib/utils/stage-storage';
import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';

function agent(id: string, name: string): GeneratedAgentConfig {
  return {
    id,
    name,
    role: 'teacher',
    persona: '',
    avatar: `/avatars/${id}.png`,
    color: '#000000',
    priority: 10,
  };
}

const LOADED = { agentIds: ['t0'], generatedAgentConfigs: [agent('t0', 'Default teacher')] };
const AGENT_WRITTEN = { agentIds: ['t1'], generatedAgentConfigs: [agent('t1', 'Teacher Chen')] };

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
  emitFreshness() {
    for (const fn of this.listeners.get('stage_freshness') ?? []) {
      fn({
        data: JSON.stringify({ type: 'stage_freshness', stageId: 'stage-a', rev: 0 }),
      });
    }
  }
}

function Harness() {
  useStageFreshnessSync('stage-a', { bootstrapDocument: false });
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;

/** The classroom load filled the store; the sync then takes its baseline. */
async function openCourse() {
  useStageStore.setState({
    stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1, ...LOADED } as Stage,
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-a',
        order: 0,
        title: 'One',
        type: 'slide',
        content: { type: 'slide', canvas: { elements: [] } },
      } as never,
    ],
    currentSceneId: 'scene-1',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Harness)));
  // The first pass after the baseline verifies scenes and roster once.
  mocks.roster = LOADED;
  await act(async () => MockEventSource.instances[0]!.emitFreshness());
  expect(serverRosterBaseOf('stage-a')).toEqual(LOADED);
  return MockEventSource.instances[0]!;
}

/** The agent's `set_roster`: the server's stage (and its rev) changes. */
function agentSetsRoster() {
  mocks.roster = AGENT_WRITTEN;
  mocks.manifest = { ...mocks.manifest, rev: mocks.manifest.rev + 1 };
}

/** The `stage` the next flush hands to storage. */
async function flushedStage(): Promise<Stage> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  const calls = vi.mocked(saveStageDataIncremental).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls.at(-1)![2] as { stage: Stage }).stage;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveStageDataIncremental).mockClear();
  mocks.manifest = { rev: 1, scenes: [{ id: 'scene-1', order: 0, rev: 1 }] };
  mocks.roster = null;
  mocks.rosterFetchCount = 0;
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/manifest')) return { ok: true, json: async () => mocks.manifest };
      if (url.includes('/roster')) {
        mocks.rosterFetchCount += 1;
        if (!mocks.roster) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => mocks.roster };
      }
      if (url.includes('/scenes?')) {
        return {
          ok: true,
          json: async () => ({ scenes: useStageStore.getState().scenes }),
        };
      }
      return { ok: false, status: 404 };
    }),
  );
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useStageStore.getState().clearStore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('roster merge with stage edits pending', () => {
  it('an unrelated pending stage edit takes the agent roster, and its flush writes it', async () => {
    const source = await openCourse();

    // A local stage edit unrelated to the roster (a rename), not yet saved.
    useStageStore.setState((state) => ({ stage: { ...state.stage!, name: 'Renamed' } }));
    markStagePersistenceDirty([{ kind: 'stage' }]);
    expect(hasUnsavedStageEdit('stage-a')).toBe(true);

    agentSetsRoster();
    await act(async () => source.emitFreshness());

    // The classroom shows the agent's roster, the local edit is still there
    // and still queued, and the apply itself queued nothing.
    const shown = useStageStore.getState().stage!;
    expect(shown.generatedAgentConfigs).toEqual(AGENT_WRITTEN.generatedAgentConfigs);
    expect(shown.agentIds).toEqual(AGENT_WRITTEN.agentIds);
    expect(shown.name).toBe('Renamed');
    expect(hasUnsavedStageEdit('stage-a')).toBe(true);
    expect(serverRosterBaseOf('stage-a')).toEqual(AGENT_WRITTEN);

    // The pending flush writes the new roster with the edit, not the old one.
    const saved = await flushedStage();
    expect(saved.name).toBe('Renamed');
    expect(saved.generatedAgentConfigs).toEqual(AGENT_WRITTEN.generatedAgentConfigs);
    expect(saved.agentIds).toEqual(AGENT_WRITTEN.agentIds);
    expect(vi.mocked(saveStageDataIncremental)).toHaveBeenCalledTimes(1);
  });

  it('a roster edit of this browser’s own is kept against a concurrent agent change', async () => {
    const source = await openCourse();

    const mine = [agent('t2', 'My teacher')];
    useStageStore.getState().setStageAgents(mine);

    agentSetsRoster();
    await act(async () => source.emitFreshness());

    expect(useStageStore.getState().stage!.generatedAgentConfigs).toEqual(mine);
    expect(serverRosterBaseOf('stage-a')).toEqual(LOADED);

    // Its save writes it (the last save wins), and then becomes the base.
    const saved = await flushedStage();
    expect(saved.generatedAgentConfigs).toEqual(mine);
    expect(serverRosterBaseOf('stage-a')).toMatchObject({ generatedAgentConfigs: mine });
  });

  it('with no stage edit pending, the agent roster is applied without any save', async () => {
    const source = await openCourse();
    agentSetsRoster();
    await act(async () => source.emitFreshness());
    expect(useStageStore.getState().stage!.generatedAgentConfigs).toEqual(
      AGENT_WRITTEN.generatedAgentConfigs,
    );
    expect(hasUnsavedStageEdit('stage-a')).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(vi.mocked(saveStageDataIncremental)).not.toHaveBeenCalled();
  });
});
