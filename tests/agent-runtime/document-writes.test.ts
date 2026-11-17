import { describe, expect, it, vi } from 'vitest';
import { DocumentVersionError, type DocumentStore } from '@openmaic/storage';

import type { Scene, Stage } from '@/lib/types/stage';
import {
  putSceneBringingCurrent,
  putSceneReversioning,
} from '@/lib/server/agent-runtime/document-writes';
import { reversionStamp } from '@/lib/server/agent-runtime/document-writes';

const stage: Stage = {
  id: 'stage-1',
  name: 'Course',
  createdAt: 1_000,
  updatedAt: 2_000,
};

const scene = (id: string, order: number): Scene =>
  ({
    id,
    stageId: stage.id,
    type: 'quiz',
    title: `Scene ${id}`,
    order,
    content: { type: 'quiz', questions: [] },
  }) as unknown as Scene;

const lineScene = scene('scene-line', 1);

const staleError = () =>
  new DocumentVersionError(
    stage.id,
    'not-current',
    '0.2.0',
    'cannot putScene into a stale document',
  );

function makeStore(overrides: {
  putScene?: DocumentStore<Scene, Stage>['putScene'];
  putStage?: DocumentStore<Scene, Stage>['putStage'];
  loadDocument?: DocumentStore<Scene, Stage>['loadDocument'];
  saveDocument?: DocumentStore<Scene, Stage>['saveDocument'];
}) {
  return overrides as unknown as DocumentStore<Scene, Stage>;
}

describe('putSceneBringingCurrent', () => {
  it('uses the incremental write when the document is current', async () => {
    const putScene = vi.fn(async () => {});
    const store = makeStore({ putScene });

    await putSceneBringingCurrent(store, stage.id, lineScene);

    expect(putScene).toHaveBeenCalledExactlyOnceWith(stage.id, lineScene);
  });

  it('falls back to an aggregate save with the scene spliced in on not-current', async () => {
    const otherA = scene('scene-a', 0);
    const otherB = scene('scene-b', 2);
    const doc = { stage, scenes: [otherA, otherB] };
    const putScene = vi.fn(async () => {
      throw staleError();
    });
    const loadDocument = vi.fn(async () => doc);
    const saveDocument = vi.fn(async (_doc: { stage: Stage; scenes: Scene[] }) => {});
    const store = makeStore({ putScene, loadDocument, saveDocument });

    await putSceneBringingCurrent(store, stage.id, lineScene);

    expect(loadDocument).toHaveBeenCalledExactlyOnceWith(stage.id);
    expect(saveDocument).toHaveBeenCalledTimes(1);
    const saved = saveDocument.mock.calls[0]![0]!;
    // the written scene replaced nothing (new id) but landed in order,
    // and the untouched scenes are shared by reference
    expect(saved.scenes.map((item) => item.id)).toEqual(['scene-a', 'scene-line', 'scene-b']);
    expect(saved.scenes[0]).toBe(otherA);
    expect(saved.scenes[2]).toBe(otherB);
    expect(saved.stage).toBe(stage);
  });

  it('replaces an existing scene by id in the fallback save', async () => {
    const existing = scene('scene-line', 1);
    const doc = { stage, scenes: [existing] };
    const putScene = vi.fn(async () => {
      throw staleError();
    });
    const loadDocument = vi.fn(async () => doc);
    const saveDocument = vi.fn(async (_doc: { stage: Stage; scenes: Scene[] }) => {});
    const store = makeStore({ putScene, loadDocument, saveDocument });

    await putSceneBringingCurrent(store, stage.id, lineScene);

    const saved = saveDocument.mock.calls[0]![0]!;
    expect(saved.scenes).toEqual([lineScene]);
    expect(saved.scenes[0]).toBe(lineScene);
  });

  it('rethrows the original error when the document vanished before the reload', async () => {
    const putScene = vi.fn(async () => {
      throw staleError();
    });
    const loadDocument = vi.fn(async () => null);
    const saveDocument = vi.fn(async (_doc: { stage: Stage; scenes: Scene[] }) => {});
    const store = makeStore({ putScene, loadDocument, saveDocument });

    await expect(putSceneBringingCurrent(store, stage.id, lineScene)).rejects.toThrow(
      DocumentVersionError,
    );
    expect(saveDocument).not.toHaveBeenCalled();
  });

  it('rethrows unrelated putScene failures without touching the aggregate', async () => {
    const putScene = vi.fn(async () => {
      throw new DocumentVersionError(stage.id, 'future', '9.0.0', 'document is newer');
    });
    const loadDocument = vi.fn(async () => ({ stage, scenes: [] }));
    const saveDocument = vi.fn(async (_doc: { stage: Stage; scenes: Scene[] }) => {});
    const store = makeStore({ putScene, loadDocument, saveDocument });

    await expect(putSceneBringingCurrent(store, stage.id, lineScene)).rejects.toThrow(
      'document is newer',
    );
    expect(loadDocument).not.toHaveBeenCalled();
    expect(saveDocument).not.toHaveBeenCalled();
  });
});

describe('putSceneReversioning', () => {
  it('writes the scene, then re-versions the stage row', async () => {
    const before = Date.now();
    const putScene = vi.fn(async () => {});
    const putStage = vi.fn(async (_stageId: string, _stage: Stage) => {});
    const store = makeStore({ putScene, putStage });

    await putSceneReversioning(store, stage.id, lineScene, stage);

    expect(putScene).toHaveBeenCalledExactlyOnceWith(stage.id, lineScene);
    expect(putStage).toHaveBeenCalledExactlyOnceWith(stage.id, {
      ...stage,
      updatedAt: expect.any(Number),
    });
    const stamped = putStage.mock.calls[0]![1] as Stage;
    expect(stamped.updatedAt).toBeGreaterThanOrEqual(before);
    // Only the version moved; the row is otherwise the caller's stage.
    expect({ ...stamped, updatedAt: stage.updatedAt }).toEqual(stage);
  });

  it('advances the version even when the clock has not moved', () => {
    // Two edits inside one millisecond: the stamp must still be strictly
    // greater than the loaded row, or the cache reads the second as the first.
    const now = vi.spyOn(Date, 'now').mockReturnValue(stage.updatedAt);
    try {
      expect(reversionStamp(stage)).toBe(stage.updatedAt + 1);
      expect(reversionStamp({ updatedAt: stage.updatedAt + 5 })).toBe(stage.updatedAt + 6);
    } finally {
      now.mockRestore();
    }
    // Normally now is far ahead of the loaded row and simply wins.
    expect(reversionStamp({ updatedAt: 1 })).toBeGreaterThanOrEqual(Date.now());
  });

  it('re-versions after the not-current fallback too', async () => {
    const putScene = vi.fn(async () => {
      throw staleError();
    });
    const loadDocument = vi.fn(async () => ({ stage, scenes: [] }));
    const saveDocument = vi.fn(async (_doc: { stage: Stage; scenes: Scene[] }) => {});
    const putStage = vi.fn(async (_stageId: string, _stage: Stage) => {});
    const store = makeStore({ putScene, loadDocument, saveDocument, putStage });

    await putSceneReversioning(store, stage.id, lineScene, stage);

    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(putStage).toHaveBeenCalledExactlyOnceWith(stage.id, {
      ...stage,
      updatedAt: expect.any(Number),
    });
  });
});
