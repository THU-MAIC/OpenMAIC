import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { flushStageSave, useStageStore } from '@/lib/store/stage';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';

const stage = (id = 'stage-1'): Stage => ({
  id,
  name: id,
  createdAt: 1,
  updatedAt: 1,
});

const scene = (id: string, stageId = 'stage-1'): Scene => ({
  id,
  stageId,
  type: 'slide',
  title: id,
  order: 1,
  content: {
    type: 'slide',
    canvas: {
      id: `canvas-${id}`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: ['#000'],
        fontColor: '#000',
        fontName: 'Inter',
      },
      elements: [],
    },
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stage(),
    scenes: [scene('scene-1'), scene('scene-2')],
    currentSceneId: 'scene-1',
    chats: [],
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('incremental stage flush', () => {
  it('marks only the updated scene and drains the pending debounce', async () => {
    useStageStore.getState().updateScene('scene-2', { title: 'changed' });

    await flushStageSave();
    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(incrementalSave.mock.calls[0]![0]).toBe('stage-1');
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);

    await vi.advanceTimersByTimeAsync(500);
    expect(incrementalSave).toHaveBeenCalledOnce();
  });

  it('marks scene membership/order changes as structural', async () => {
    useStageStore.getState().addScene(scene('scene-3'));
    await flushStageSave();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'structure' }]);
  });

  it('marks cursor dirt when a structural mutation changes the selection', async () => {
    useStageStore.setState({ currentSceneId: null });
    useStageStore.getState().setScenes([scene('scene-1'), scene('scene-2')]);
    await flushStageSave();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([
      { kind: 'structure' },
      { kind: 'currentScene' },
    ]);

    useStageStore.getState().deleteScene('scene-1');
    await flushStageSave();
    expect(incrementalSave.mock.calls[1]![1]).toEqual([
      { kind: 'structure' },
      { kind: 'currentScene' },
    ]);
  });

  it('persists current-scene state without marking document data', async () => {
    useStageStore.getState().setCurrentSceneId('scene-2');
    await flushStageSave();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'currentScene' }]);
  });

  it('retains failed dirt for an explicit retry', async () => {
    incrementalSave.mockRejectedValueOnce(new Error('disk full'));
    useStageStore.getState().updateScene('scene-1', { title: 'retry me' });

    await expect(flushStageSave()).rejects.toThrow('disk full');
    incrementalSave.mockResolvedValueOnce(undefined);
    await flushStageSave();

    expect(incrementalSave).toHaveBeenCalledTimes(2);
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);
  });

  it('drains a mutation that lands between concurrent flush calls', async () => {
    let releaseFirst!: () => void;
    incrementalSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });

    const first = flushStageSave();
    await vi.waitFor(() => expect(incrementalSave).toHaveBeenCalledOnce());
    useStageStore.getState().updateScene('scene-2', { title: 'landed during write' });
    const second = flushStageSave();
    releaseFirst();
    await Promise.all([first, second]);
    expect(incrementalSave).toHaveBeenCalledTimes(2);
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);
  });

  it('flushes old-document dirt when setStage switches documents', async () => {
    useStageStore.getState().updateScene('scene-1', { title: 'stale' });
    useStageStore.getState().setStage(stage('stage-2'));

    await flushStageSave();
    await vi.waitFor(() => expect(incrementalSave).toHaveBeenCalledTimes(2));
    expect(incrementalSave.mock.calls[0]![0]).toBe('stage-1');
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);
    expect(incrementalSave.mock.calls[1]![0]).toBe('stage-2');
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'structure' }, { kind: 'stage' }]);
  });

  it('retains chat dirt when chat persistence reports an isolated failure', async () => {
    incrementalSave
      .mockResolvedValueOnce({ failedChanges: [{ kind: 'chats' }] })
      .mockResolvedValueOnce({ failedChanges: [] });
    useStageStore.getState().setChats([
      {
        id: 'chat-1',
        type: 'qa',
        title: 'Chat',
        status: 'idle',
        messages: [],
        config: { agentIds: [] },
        toolCalls: [],
        pendingToolCalls: [],
        createdAt: 1,
        updatedAt: 1,
      } satisfies ChatSession,
    ]);

    await flushStageSave();
    await vi.advanceTimersByTimeAsync(500);
    expect(incrementalSave).toHaveBeenCalledTimes(2);
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'chats' }]);
  });
});
