import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The direct write the stage store makes while the page unloads: no read of
 * the document before writing, keepalive requests, and a body budget that
 * defers what does not fit.
 */
const { accessDocument, loadDocument, mutateDocument, putScene, putStage, saveCurrentScene } =
  vi.hoisted(() => {
    const store = {
      putScene: vi.fn(),
      putStage: vi.fn(),
      saveDocument: vi.fn().mockResolvedValue(undefined),
    };
    const loadDocument = vi.fn();
    return {
      loadDocument,
      accessDocument: vi.fn(async () => ({ document: loadDocument(), readOnlyLegacy: false })),
      mutateDocument: vi.fn(
        async (
          _stageId: string,
          callback: (document: unknown, documentStore: typeof store) => Promise<void>,
        ) => callback(loadDocument(), store),
      ),
      putScene: store.putScene,
      putStage: store.putStage,
      saveCurrentScene: vi.fn().mockResolvedValue(undefined),
    };
  });

vi.mock('@/lib/document-store', () => ({
  accessDocument,
  mutateDocument,
  saveCurrentScene,
  loadCurrentScene: vi.fn().mockResolvedValue(null),
  getDocumentStore: () => ({ putScene, putStage, loadDocument }),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: async (_stageId: string, scenes: unknown[]) => scenes,
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: (callback: () => unknown) => callback(),
  withRuntimeStorageExclusiveLockUntilSettled: (callback: () => unknown) => callback(),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn().mockResolvedValue(undefined),
  loadChatSessions: vi.fn().mockResolvedValue([]),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));

import {
  UNLOAD_KEEPALIVE_BUDGET_BYTES,
  loadStageData,
  resetUnloadWriteStateForTests,
  saveStageDataIncremental,
  writeStageChangesForUnload,
  type StageStoreData,
} from '@/lib/utils/stage-storage';
import { markStageDeleted, stageDeletionEpoch } from '@/lib/utils/deleted-stages';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1 };

function slide(id: string, text = ''): Scene {
  return {
    id,
    stageId: 'stage-1',
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
        elements: text
          ? [
              {
                id: `text-${id}`,
                type: 'text',
                left: 0,
                top: 0,
                width: 100,
                height: 100,
                rotate: 0,
                content: text,
                defaultFontName: 'Inter',
                defaultColor: '#000',
              },
            ]
          : [],
      },
    },
  } as Scene;
}

function data(scenes: Scene[]): StageStoreData {
  return { stage, scenes, currentSceneId: scenes[0]?.id ?? null, chats: [] };
}

/** This page loaded the course, so it knows the document is on the server. */
async function loadCourse(scenes: Scene[]): Promise<void> {
  loadDocument.mockReturnValue({ stage, scenes, outline: undefined });
  await loadStageData('stage-1');
  loadDocument.mockClear();
  accessDocument.mockClear();
}

beforeEach(() => {
  resetUnloadWriteStateForTests();
  loadDocument.mockReset();
  mutateDocument.mockClear();
  putScene.mockReset().mockResolvedValue(undefined);
  putStage.mockReset().mockResolvedValue(undefined);
  saveCurrentScene.mockReset().mockResolvedValue(undefined);
});

describe('writeStageChangesForUnload', () => {
  it('writes the changed scene and stage with keepalive and without reading the document', async () => {
    const scenes = [slide('scene-1'), slide('scene-2')];
    await loadCourse(scenes);

    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-2' }, { kind: 'stage' }, { kind: 'currentScene' }],
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );

    // The requests start synchronously: an unload handler gets no later turn.
    expect(putScene).toHaveBeenCalledOnce();
    expect(putScene.mock.calls[0]).toEqual([
      'stage-1',
      expect.objectContaining({ id: 'scene-2', stageId: 'stage-1' }),
      { keepalive: true },
    ]);
    expect(putStage).toHaveBeenCalledWith('stage-1', expect.objectContaining({ id: 'stage-1' }), {
      keepalive: true,
    });
    expect(saveCurrentScene).toHaveBeenCalledWith('stage-1', 'scene-1');
    expect(loadDocument).not.toHaveBeenCalled();
    expect(mutateDocument).not.toHaveBeenCalled();
    expect(result.deferred).toEqual([]);
    expect(result.sent).toHaveLength(3);
    await expect(result.settled).resolves.toBe(true);
  });

  it('also knows the document after this page saved it', async () => {
    const scenes = [slide('scene-1')];
    loadDocument.mockReturnValue({ stage, scenes, outline: undefined });
    await saveStageDataIncremental(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-1' }],
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );
    putScene.mockClear();

    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-1' }],
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );
    expect(result.deferred).toEqual([]);
    expect(putScene).toHaveBeenCalledWith('stage-1', expect.anything(), { keepalive: true });
  });

  it('defers a document this page has not seen on the server', () => {
    const scenes = [slide('scene-1')];
    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-1' }, { kind: 'stage' }],
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );
    expect(putScene).not.toHaveBeenCalled();
    expect(putStage).not.toHaveBeenCalled();
    expect(result.deferred).toEqual([{ kind: 'scene', sceneId: 'scene-1' }, { kind: 'stage' }]);
  });

  it('defers structural and outline changes, which need the whole document', async () => {
    const scenes = [slide('scene-1')];
    await loadCourse(scenes);
    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'structure' }, { kind: 'outline' }, { kind: 'chats' }],
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );
    expect(result.deferred).toEqual([{ kind: 'structure' }, { kind: 'outline' }]);
    // Chats are learner runtime, left to the regular save; nothing is sent.
    expect(result.sent).toEqual([]);
  });

  it('holds back every document change of the course when one needs the whole document', async () => {
    const scenes = [slide('scene-1'), slide('scene-2')];
    await loadCourse(scenes);
    const result = writeStageChangesForUnload(
      'stage-1',
      [
        { kind: 'structure' },
        { kind: 'scene', sceneId: 'scene-1' },
        { kind: 'stage' },
        { kind: 'currentScene' },
      ],
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );
    expect(putScene).not.toHaveBeenCalled();
    expect(putStage).not.toHaveBeenCalled();
    expect(result.deferred).toEqual([
      { kind: 'structure' },
      { kind: 'scene', sceneId: 'scene-1' },
      { kind: 'stage' },
    ]);
    // The device-local reading position is not part of the document.
    expect(result.sent).toEqual([{ kind: 'currentScene' }]);
  });

  it('defers a project scene, whose learner state must sync before the write', async () => {
    const project = { ...slide('scene-pbl'), content: { type: 'pbl' } } as unknown as Scene;
    await loadCourse([project]);
    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-pbl' }],
      data([project]),
      stageDeletionEpoch('stage-1'),
    );
    expect(putScene).not.toHaveBeenCalled();
    expect(result.deferred).toEqual([{ kind: 'scene', sceneId: 'scene-pbl' }]);
  });

  it('sends what fits the keepalive budget and defers the rest', async () => {
    const third = Math.floor(UNLOAD_KEEPALIVE_BUDGET_BYTES / 3);
    const scenes = [
      slide('scene-1', 'a'.repeat(third)),
      slide('scene-2', 'b'.repeat(third)),
      slide('scene-3', 'c'.repeat(third)),
    ];
    await loadCourse(scenes);

    const result = writeStageChangesForUnload(
      'stage-1',
      scenes.map((scene) => ({ kind: 'scene', sceneId: scene.id })),
      data(scenes),
      stageDeletionEpoch('stage-1'),
    );

    expect(putScene).toHaveBeenCalledTimes(2);
    expect(result.sent).toEqual([
      { kind: 'scene', sceneId: 'scene-1' },
      { kind: 'scene', sceneId: 'scene-2' },
    ]);
    expect(result.deferred).toEqual([{ kind: 'scene', sceneId: 'scene-3' }]);
  });

  it('counts requests still in flight against the budget, and frees it once they settle', async () => {
    const big = slide('scene-1', 'x'.repeat(Math.floor(UNLOAD_KEEPALIVE_BUDGET_BYTES * 0.6)));
    await loadCourse([big]);
    let finish!: () => void;
    putScene.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const change = [{ kind: 'scene', sceneId: 'scene-1' }] as const;

    const first = writeStageChangesForUnload('stage-1', change, data([big]), 0);
    const second = writeStageChangesForUnload('stage-1', change, data([big]), 0);
    expect(first.deferred).toEqual([]);
    expect(second.deferred).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);

    finish();
    await first.settled;
    const third = writeStageChangesForUnload('stage-1', change, data([big]), 0);
    expect(third.deferred).toEqual([]);
  });

  it('reports a failed request as unsettled', async () => {
    const scenes = [slide('scene-1')];
    await loadCourse(scenes);
    putScene.mockRejectedValueOnce(new Error('offline'));
    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-1' }],
      data(scenes),
      0,
    );
    await expect(result.settled).resolves.toBe(false);
  });

  it('writes nothing for a deleted course', async () => {
    const scenes = [slide('scene-1')];
    await loadCourse(scenes);
    const epoch = stageDeletionEpoch('stage-1');
    markStageDeleted('stage-1');
    const result = writeStageChangesForUnload(
      'stage-1',
      [{ kind: 'scene', sceneId: 'scene-1' }],
      data(scenes),
      epoch,
    );
    expect(putScene).not.toHaveBeenCalled();
    expect(result.sent).toEqual([]);
  });
});
