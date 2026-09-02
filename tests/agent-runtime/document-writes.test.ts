import { describe, expect, it, vi } from 'vitest';
import { DocumentVersionError, type DocumentStore } from '@openmaic/storage';

import type { Scene, Stage } from '@/lib/types/stage';
import { putSceneBringingCurrent } from '@/lib/server/agent-runtime/document-writes';

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
