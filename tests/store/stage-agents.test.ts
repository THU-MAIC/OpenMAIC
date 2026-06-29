import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// IndexedDB / stage-storage modules are imported dynamically inside the
// store's save/load actions. Mock them so the debounced save doesn't try
// to talk to a real (or jsdom) IndexedDB in the test environment.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: vi.fn(), get: vi.fn() } },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  saveGeneratedAgents: vi.fn().mockResolvedValue([]),
}));

import { useStageStore } from '@/lib/store/stage';
import { saveStageData } from '@/lib/utils/stage-storage';
import { saveGeneratedAgents } from '@/lib/orchestration/registry/store';
import type { Stage } from '@/lib/types/stage';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

function makeStage(): Stage {
  return {
    id: 'stage-1',
    name: 'Test stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeAgentConfig(id: string): GeneratedAgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    role: 'teacher',
    persona: 'A helpful teacher',
    avatar: 'avatar-url',
    color: '#000000',
    priority: 1,
  };
}

beforeEach(() => {
  useStageStore.setState({
    stage: makeStage(),
    scenes: [],
    currentSceneId: null,
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
});

describe('viewMode', () => {
  it('defaults to slides', () => {
    useStageStore.getState().clearStore();
    expect(useStageStore.getState().viewMode).toBe('slides');
  });

  it('setViewMode updates to agents', () => {
    useStageStore.getState().setViewMode('agents');
    expect(useStageStore.getState().viewMode).toBe('agents');
  });

  it('setViewMode back to slides', () => {
    useStageStore.getState().setViewMode('agents');
    useStageStore.getState().setViewMode('slides');
    expect(useStageStore.getState().viewMode).toBe('slides');
  });

  it('clearStore resets viewMode to slides', () => {
    useStageStore.getState().setViewMode('agents');
    useStageStore.getState().clearStore();
    expect(useStageStore.getState().viewMode).toBe('slides');
  });
});

describe('setStageAgents', () => {
  it('writes generatedAgentConfigs to stage', () => {
    const configs = [makeAgentConfig('a1'), makeAgentConfig('a2')];
    useStageStore.getState().setStageAgents(configs);
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual(configs);
  });

  it('is a no-op when stage is null', () => {
    useStageStore.setState({ stage: null });
    expect(() => {
      useStageStore.getState().setStageAgents([makeAgentConfig('x')]);
    }).not.toThrow();
    expect(useStageStore.getState().stage).toBeNull();
  });

  it('replaces existing generatedAgentConfigs', () => {
    const stageWithAgents: Stage = {
      ...makeStage(),
      generatedAgentConfigs: [makeAgentConfig('old')],
    };
    useStageStore.setState({ stage: stageWithAgents });
    const newConfigs = [makeAgentConfig('new1'), makeAgentConfig('new2')];
    useStageStore.getState().setStageAgents(newConfigs);
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual(newConfigs);
  });

  it('preserves other stage fields when patching generatedAgentConfigs', () => {
    useStageStore.getState().setStageAgents([makeAgentConfig('a1')]);
    const stage = useStageStore.getState().stage;
    expect(stage?.id).toBe('stage-1');
    expect(stage?.name).toBe('Test stage');
  });
});

describe('setStageAgents persistence (debounced save)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(saveStageData).mockClear();
    vi.mocked(saveGeneratedAgents).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes generatedAgentConfigs in saveStageData after debounce', async () => {
    const configs = [makeAgentConfig('x1'), makeAgentConfig('x2')];
    useStageStore.getState().setStageAgents(configs);

    // Flush the 500 ms debounce
    await vi.runAllTimersAsync();

    expect(saveStageData).toHaveBeenCalledOnce();
    const [, storeData] = vi.mocked(saveStageData).mock.calls[0];
    expect(storeData.stage.generatedAgentConfigs).toEqual(configs);
  });

  it('calls saveGeneratedAgents with the new configs after debounce', async () => {
    const configs = [makeAgentConfig('y1')];
    useStageStore.getState().setStageAgents(configs);

    await vi.runAllTimersAsync();

    expect(saveGeneratedAgents).toHaveBeenCalledOnce();
    const [stageId, savedConfigs] = vi.mocked(saveGeneratedAgents).mock.calls[0];
    expect(stageId).toBe('stage-1');
    expect(savedConfigs).toEqual(configs);
  });

  it('calls saveGeneratedAgents with empty array when roster cleared', async () => {
    const stageWithAgents: Stage = {
      ...makeStage(),
      generatedAgentConfigs: [makeAgentConfig('old')],
    };
    useStageStore.setState({ stage: stageWithAgents });
    useStageStore.getState().setStageAgents([]);

    await vi.runAllTimersAsync();

    // setStageAgents([]) → generatedAgentConfigs is [], saveGeneratedAgents not called
    // (guarded by `if (stage.generatedAgentConfigs)` which is truthy for [])
    expect(saveGeneratedAgents).toHaveBeenCalledOnce();
    const [, savedConfigs] = vi.mocked(saveGeneratedAgents).mock.calls[0];
    expect(savedConfigs).toEqual([]);
  });
});
