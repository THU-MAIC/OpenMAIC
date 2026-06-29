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

import { useStageStore } from '@/lib/store/stage';
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
