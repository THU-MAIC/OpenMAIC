import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentVersionError } from '@openmaic/storage';

const {
  loadDocument,
  mutateDocument,
  prepareScenes,
  putScene,
  putStage,
  saveCurrentScene,
  saveChatSessions,
  saveDocument,
} = vi.hoisted(() => {
  const store = {
    putScene: vi.fn().mockResolvedValue(undefined),
    putStage: vi.fn().mockResolvedValue(undefined),
    saveDocument: vi.fn().mockResolvedValue(undefined),
  };
  return {
    loadDocument: vi.fn(),
    mutateDocument: vi.fn(
      async (
        _stageId: string,
        callback: (document: unknown, documentStore: typeof store) => Promise<void>,
      ) => callback(loadDocument(), store),
    ),
    prepareScenes: vi.fn(async (_stageId: string, scenes: unknown[]) => scenes),
    putScene: store.putScene,
    putStage: store.putStage,
    saveCurrentScene: vi.fn().mockResolvedValue(undefined),
    saveChatSessions: vi.fn().mockResolvedValue(undefined),
    saveDocument: store.saveDocument,
  };
});

vi.mock('@/lib/document-store', () => ({
  mutateDocument,
  saveCurrentScene,
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: prepareScenes,
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: (callback: () => unknown) => callback(),
  withRuntimeStorageExclusiveLockUntilSettled: (callback: () => unknown) => callback(),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions,
  loadChatSessions: vi.fn().mockResolvedValue([]),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));

import {
  saveStageData,
  saveStageDataIncremental,
  type StageStoreData,
} from '@/lib/utils/stage-storage';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 };
const scenes: Scene[] = [
  {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'One',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
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
  },
  {
    id: 'scene-2',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Two',
    order: 2,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-2',
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
  },
];

const data: StageStoreData = {
  stage,
  scenes,
  currentSceneId: 'scene-1',
  chats: [],
  outline: { outlines: [], createdAt: 1, updatedAt: 1 },
};

beforeEach(() => {
  loadDocument.mockReset().mockReturnValue({
    stage,
    scenes,
    outline: data.outline,
    dslVersion: 'current',
  });
  mutateDocument.mockClear();
  prepareScenes.mockClear();
  putScene.mockReset().mockResolvedValue(undefined);
  putStage.mockReset().mockResolvedValue(undefined);
  saveDocument.mockReset().mockResolvedValue(undefined);
  saveCurrentScene.mockReset().mockResolvedValue(undefined);
  saveChatSessions.mockReset().mockResolvedValue(undefined);
});

describe('saveStageDataIncremental', () => {
  it('prepares and writes exactly one dirty scene', async () => {
    await saveStageDataIncremental('stage-1', [{ kind: 'scene', sceneId: 'scene-2' }], data);

    expect(prepareScenes).toHaveBeenCalledWith('stage-1', [scenes[1]]);
    expect(putScene).toHaveBeenCalledOnce();
    expect(putScene.mock.calls[0]![1]).toEqual(expect.objectContaining({ id: 'scene-2' }));
    expect(saveDocument).not.toHaveBeenCalled();
    expect(putStage).not.toHaveBeenCalled();
  });

  it('normalizes an undefined scene order to its document index', async () => {
    const unorderedScenes = [scenes[0], { ...scenes[1], order: undefined }] as Scene[];
    await saveStageDataIncremental('stage-1', [{ kind: 'scene', sceneId: 'scene-2' }], {
      ...data,
      scenes: unorderedScenes,
    });

    expect(putScene.mock.calls[0]![1]).toEqual(expect.objectContaining({ order: 1 }));
  });

  it('uses the aggregate save for structural changes', async () => {
    await saveStageDataIncremental('stage-1', [{ kind: 'structure' }], data);
    expect(prepareScenes).toHaveBeenCalledWith('stage-1', scenes);
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(putScene).not.toHaveBeenCalled();
  });

  it('does not enter the document store for current-scene-only changes', async () => {
    await saveStageDataIncremental('stage-1', [{ kind: 'currentScene' }], data);
    expect(mutateDocument).not.toHaveBeenCalled();
    expect(saveCurrentScene).toHaveBeenCalledWith('stage-1', 'scene-1');
  });

  it('falls back to a full save when an incremental destination is not current', async () => {
    putScene.mockRejectedValueOnce(
      new DocumentVersionError('stage-1', 'not-current', undefined, 'legacy'),
    );
    await saveStageDataIncremental('stage-1', [{ kind: 'scene', sceneId: 'scene-1' }], data);
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(prepareScenes).toHaveBeenLastCalledWith('stage-1', scenes);
  });

  it('uses one aggregate write for a mixed scene-and-stage batch', async () => {
    await saveStageDataIncremental(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-1' }, { kind: 'stage' }],
      data,
    );

    expect(saveDocument).toHaveBeenCalledOnce();
    expect(putScene).not.toHaveBeenCalled();
    expect(putStage).not.toHaveBeenCalled();
  });

  it('reports an isolated chat failure without failing the document flush', async () => {
    saveChatSessions.mockRejectedValueOnce(new Error('runtime unavailable'));

    await expect(saveStageDataIncremental('stage-1', [{ kind: 'chats' }], data)).resolves.toEqual({
      failedChanges: [{ kind: 'chats' }],
    });
  });
});

describe('saveStageData', () => {
  it('reports a split chat failure after the document save succeeds', async () => {
    saveChatSessions.mockRejectedValueOnce(new Error('runtime unavailable'));

    await expect(saveStageData('stage-1', data)).resolves.toEqual({
      failedChanges: [{ kind: 'chats' }],
    });
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(saveCurrentScene).toHaveBeenCalledWith('stage-1', 'scene-1');
  });
});
