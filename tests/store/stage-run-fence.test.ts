import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadStageData } = vi.hoisted(() => ({ loadStageData: vi.fn() }));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData,
}));
vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({
  hydratePBLScenesFromRuntime: async (_stageId: string, scenes: unknown[]) => scenes,
}));

import {
  isServerGeneratingStage,
  setServerGeneratingStage,
  useStageStore,
} from '@/lib/store/stage';
import { isRunRef, runIdOfCourse } from '@/lib/generation-run-client/run-id';

function course(stageId: string, outline: Record<string, unknown>) {
  return {
    stage: { id: stageId, name: stageId, createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    chats: [],
    outline: { outlines: [], createdAt: 1, updatedAt: 1, ...outline },
  };
}

beforeEach(() => {
  setServerGeneratingStage(null);
  useStageStore.getState().clearStore();
});

describe('the load-time fence of a run course', () => {
  it('fences a course whose run is followable and not complete', async () => {
    loadStageData.mockResolvedValueOnce(
      course('stage-a', { producer: 'server-job', producerRef: 'run-AAAAAAAAAAAAAAAA' }),
    );
    await useStageStore.getState().loadFromStorage('stage-a');
    expect(isServerGeneratingStage('stage-a')).toBe(true);
  });

  it('does not fence a server-job course whose ref is not a run id, or a complete one', async () => {
    loadStageData.mockResolvedValueOnce(
      course('stage-b', { producer: 'server-job', producerRef: 'run-legacy' }),
    );
    await useStageStore.getState().loadFromStorage('stage-b');
    expect(isServerGeneratingStage('stage-b')).toBe(false);

    loadStageData.mockResolvedValueOnce(
      course('stage-c', {
        producer: 'server-job',
        producerRef: 'run-AAAAAAAAAAAAAAAA',
        generationComplete: true,
      }),
    );
    await useStageStore.getState().loadFromStorage('stage-c');
    expect(isServerGeneratingStage('stage-c')).toBe(false);
  });

  it('lifts a stale fence when the course loads without a run to follow', async () => {
    setServerGeneratingStage('stage-d');
    loadStageData.mockResolvedValueOnce(
      course('stage-d', { producer: 'server-job', producerRef: 'session-1' }),
    );
    await useStageStore.getState().loadFromStorage('stage-d');
    expect(isServerGeneratingStage('stage-d')).toBe(false);
  });

  it('shares one run ref check with the follower', () => {
    expect(isRunRef('run-AAAAAAAAAAAAAAAA')).toBe(true);
    expect(isRunRef('run-short')).toBe(false);
    expect(runIdOfCourse('server-job', 'run-AAAAAAAAAAAAAAAA')).toBe('run-AAAAAAAAAAAAAAAA');
    expect(runIdOfCourse('client', 'run-AAAAAAAAAAAAAAAA')).toBeNull();
  });
});
