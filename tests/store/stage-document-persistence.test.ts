import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prepareScenesMock, saveStageDataMock } = vi.hoisted(() => ({
  prepareScenesMock: vi.fn(),
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: (...args: unknown[]) => prepareScenesMock(...args),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => saveStageDataMock(...args),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { flushStageSave, useStageStore } from '@/lib/store/stage';
import { saveStageDataIncremental } from '@/lib/utils/stage-storage';
import { makeScene, type Scene, type Stage } from '@/lib/types/stage';
import type { ChatSession } from '@/lib/types/chat';

function makeStage(): Stage {
  return {
    id: 'stage-1',
    name: 'Test stage',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeSlideScene(id: string): Scene {
  return makeScene(
    {
      id,
      stageId: 'stage-1',
      title: id,
      order: 0,
    },
    {
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
  );
}

beforeEach(() => {
  prepareScenesMock.mockReset();
  saveStageDataMock.mockReset();
  saveStageDataMock.mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
  useStageStore.setState({ stage: makeStage(), scenes: [], currentSceneId: null, chats: [] });
});

describe('stage document persistence', () => {
  it('prepares runtime-backed scenes before saving the document snapshot', async () => {
    const inMemoryScene = makeSlideScene('in-memory');
    const persistedScene = makeSlideScene('persisted');
    useStageStore.setState({ scenes: [inMemoryScene] });
    prepareScenesMock.mockResolvedValueOnce([persistedScene]);

    const saved = await useStageStore.getState().saveToStorage();

    expect(saved).toBe(true);
    expect(prepareScenesMock).toHaveBeenCalledWith('stage-1', [inMemoryScene]);
    expect(prepareScenesMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveStageDataMock.mock.invocationCallOrder[0]!,
    );
    expect(saveStageDataMock).toHaveBeenCalledWith(
      'stage-1',
      expect.objectContaining({ scenes: [persistedScene] }),
      expect.any(Number),
    );
    expect(useStageStore.getState().scenes).toEqual([inMemoryScene]);
  });

  it('does not save a stripped document when runtime synchronization fails', async () => {
    const inMemoryScene = makeSlideScene('in-memory');
    useStageStore.setState({ scenes: [inMemoryScene] });
    prepareScenesMock.mockRejectedValueOnce(new Error('runtime unavailable'));

    const saved = await useStageStore.getState().saveToStorage();

    expect(saved).toBe(false);
    expect(saveStageDataMock).not.toHaveBeenCalled();
  });

  it('treats a fence-dropped save as not durable: false, no chatSnapshot rebind, pending kept', async () => {
    // An epoch-stale drop is indistinguishable from success only if the
    // storage layer hides it; with the explicit 'stale-dropped' status the
    // store must skip every piece of success bookkeeping.
    const scene = makeSlideScene('in-memory');
    const chat: ChatSession = {
      id: 'chat-1',
      type: 'qa',
      title: 'Chat',
      status: 'completed',
      messages: [],
      config: { agentIds: [] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    useStageStore.setState({ scenes: [scene], chats: [chat] });
    // A queued edit a successful save would have cleared.
    useStageStore.getState().setCurrentSceneId(scene.id);
    const snapshotBefore = useStageStore.getState().chatSnapshot;
    prepareScenesMock.mockResolvedValueOnce([scene]);
    saveStageDataMock.mockResolvedValueOnce('stale-dropped');

    const saved = await useStageStore.getState().saveToStorage();

    expect(saved).toBe(false);
    // The chatSnapshot must not rebind to a snapshot that never landed…
    expect(useStageStore.getState().chatSnapshot).toBe(snapshotBefore);
    // …and the queued dirt must survive: the next flush still carries it.
    await flushStageSave();
    expect(saveStageDataIncremental).toHaveBeenCalledWith(
      'stage-1',
      expect.arrayContaining([{ kind: 'currentScene' }]),
      expect.anything(),
      expect.any(Number),
    );
  });
});
