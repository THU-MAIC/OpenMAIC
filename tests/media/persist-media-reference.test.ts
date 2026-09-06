/**
 * The write-back funnel: one rewrite, applied to whatever the document holds
 * now, through the document store the rest of the app writes through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateDocument: vi.fn(),
  stageState: vi.fn(),
  stageSetState: vi.fn(),
  markDirty: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({
  mutateDocument: mocks.mutateDocument,
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.stageState, setState: mocks.stageSetState },
  markStagePersistenceDirty: mocks.markDirty,
}));

import {
  MediaReferenceWriteBackError,
  persistGeneratedMediaReference,
} from '@/lib/media/persist-media-reference';
import type { Scene } from '@/lib/types/stage';

const stageId = 'stage-1';

function sceneWithImage(order: number, src: string): Scene {
  return {
    id: `scene-${order}`,
    stageId,
    title: 'Scene',
    order,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: `slide-${order}`,
        elements: [{ type: 'image', id: 'image-1', left: 0, top: 0, width: 10, height: 10, src }],
      },
    },
  } as unknown as Scene;
}

function imageSrcOf(scene: Scene): string {
  return (scene as unknown as { content: { canvas: { elements: Array<{ src: string }> } } }).content
    .canvas.elements[0].src;
}

interface DocumentStoreDouble {
  putScene: ReturnType<typeof vi.fn>;
  putStage: ReturnType<typeof vi.fn>;
}

function documentUnderMutation(document: unknown): DocumentStoreDouble {
  const store: DocumentStoreDouble = { putScene: vi.fn(), putStage: vi.fn() };
  mocks.mutateDocument.mockImplementation(
    async (_stageId: string, work: (doc: unknown, store: DocumentStoreDouble) => Promise<void>) =>
      work(document, store),
  );
  return store;
}

describe('generated media reference write-back', () => {
  beforeEach(() => {
    mocks.mutateDocument.mockReset();
    mocks.stageSetState.mockReset();
    mocks.markDirty.mockReset();
    mocks.stageState.mockReset().mockReturnValue({ stage: null, scenes: [] });
  });

  it('rewrites the persisted scene the document holds now and saves only that scene', async () => {
    const document = {
      stage: { id: stageId, whiteboard: [] },
      scenes: [sceneWithImage(1, 'gen_img_1'), sceneWithImage(2, 'ast_other')],
    };
    const store = documentUnderMutation(document);

    await expect(
      persistGeneratedMediaReference(stageId, {
        placeholderRef: 'gen_img_1',
        assetId: 'ast_new',
      }),
    ).resolves.toBe('written');

    expect(store.putScene).toHaveBeenCalledTimes(1);
    const [savedStageId, savedScene] = store.putScene.mock.calls[0] as [string, Scene];
    expect(savedStageId).toBe(stageId);
    expect(savedScene.id).toBe('scene-1');
    expect(imageSrcOf(savedScene)).toBe('ast_new');
    expect(store.putStage).not.toHaveBeenCalled();
  });

  it('saves the stage when only its whiteboard carried the placeholder', async () => {
    const document = {
      stage: {
        id: stageId,
        whiteboard: [
          {
            id: 'wb-1',
            elements: [
              {
                type: 'image',
                id: 'image-1',
                left: 0,
                top: 0,
                width: 10,
                height: 10,
                src: 'gen_img_wb',
              },
            ],
          },
        ],
      },
      scenes: [],
    };
    const store = documentUnderMutation(document);

    await expect(
      persistGeneratedMediaReference(stageId, {
        placeholderRef: 'gen_img_wb',
        assetId: 'ast_wb',
      }),
    ).resolves.toBe('written');

    expect(store.putScene).not.toHaveBeenCalled();
    expect(store.putStage).toHaveBeenCalledTimes(1);
  });

  it('propagates a document store failure so the caller keeps the placeholder', async () => {
    const document = {
      stage: { id: stageId, whiteboard: [] },
      scenes: [sceneWithImage(1, 'gen_img_1')],
    };
    const store = documentUnderMutation(document);
    store.putScene.mockRejectedValue(new Error('document write rejected'));

    await expect(
      persistGeneratedMediaReference(stageId, { placeholderRef: 'gen_img_1', assetId: 'ast_new' }),
    ).rejects.toThrow('document write rejected');
    expect(mocks.stageSetState).not.toHaveBeenCalled();
  });

  it('reports whether any part of a failed write-back reached the document', async () => {
    const document = {
      stage: { id: stageId, whiteboard: [] },
      scenes: [sceneWithImage(1, 'gen_img_1'), sceneWithImage(2, 'gen_img_1')],
    };
    document.scenes[1].id = 'scene-2';
    const store = documentUnderMutation(document);
    store.putScene
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second scene rejected'));

    const failure = await persistGeneratedMediaReference(stageId, {
      placeholderRef: 'gen_img_1',
      assetId: 'ast_new',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MediaReferenceWriteBackError);
    // One scene already names the id, so reclaiming its bytes would leave the
    // document pointing at nothing.
    expect((failure as MediaReferenceWriteBackError).documentWritten).toBe(true);
  });

  it('reports unmatched when no surface of the course references the placeholder', async () => {
    documentUnderMutation({
      stage: { id: stageId, whiteboard: [] },
      scenes: [sceneWithImage(1, 'ast_other')],
    });

    await expect(
      persistGeneratedMediaReference(stageId, { placeholderRef: 'gen_img_1', assetId: 'ast_new' }),
    ).resolves.toBe('unmatched');
    expect(mocks.stageSetState).not.toHaveBeenCalled();
    expect(mocks.markDirty).not.toHaveBeenCalled();
  });

  it('carries the rewrite into the open course and queues a corrective save', async () => {
    documentUnderMutation({ stage: { id: stageId, whiteboard: [] }, scenes: [] });
    const liveScene = sceneWithImage(1, 'gen_img_1');
    mocks.stageState.mockReturnValue({ stage: { id: stageId }, scenes: [liveScene] });

    await expect(
      persistGeneratedMediaReference(stageId, { placeholderRef: 'gen_img_1', assetId: 'ast_new' }),
    ).resolves.toBe('written');

    expect(mocks.stageSetState).toHaveBeenCalledTimes(1);
    const next = mocks.stageSetState.mock.calls[0]![0] as { scenes: Scene[] };
    expect(imageSrcOf(next.scenes[0])).toBe('ast_new');
    // The store's own object is replaced, never mutated in place.
    expect(next.scenes[0]).not.toBe(liveScene);
    expect(imageSrcOf(liveScene)).toBe('gen_img_1');
    // Dirty, so an autosave round that captured the placeholder is followed by
    // a corrective one. Marked after the state update, or the corrective round
    // would capture the old scene again.
    expect(mocks.markDirty).toHaveBeenCalledWith([{ kind: 'scene', sceneId: 'scene-1' }]);
    expect(mocks.markDirty.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.stageSetState.mock.invocationCallOrder[0],
    );
  });

  it('leaves a different open course alone', async () => {
    documentUnderMutation({ stage: { id: stageId, whiteboard: [] }, scenes: [] });
    mocks.stageState.mockReturnValue({
      stage: { id: 'another-stage' },
      scenes: [sceneWithImage(1, 'gen_img_1')],
    });

    await expect(
      persistGeneratedMediaReference(stageId, { placeholderRef: 'gen_img_1', assetId: 'ast_new' }),
    ).resolves.toBe('unmatched');
    expect(mocks.stageSetState).not.toHaveBeenCalled();
  });
});
