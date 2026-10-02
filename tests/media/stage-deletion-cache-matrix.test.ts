import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageAssetDocument } from '@/lib/media/collect-stage-asset-refs';

const mocks = vi.hoisted(() => ({
  removeAsset: vi.fn(),
  mediaRows: [] as Array<{ id: string; stageId: string }>,
  audioRows: [] as Array<{ id: string; stageId?: string }>,
  documents: new Map<string, StageAssetDocument>(),
  listDocuments: vi.fn(),
  loadDocument: vi.fn(),
  poolBytes: new Map<string, Blob>(),
}));

vi.mock('@/lib/media/asset-pool', () => ({
  removeAsset: mocks.removeAsset,
}));

vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => ({
    listDocuments: mocks.listDocuments,
    loadDocument: mocks.loadDocument,
  }),
}));

function indexedRows<T extends { id: string; stageId?: string }>(rows: T[]) {
  return {
    where: (field: keyof T) => ({
      equals: (value: unknown) => ({
        toArray: async () => rows.filter((row) => row[field] === value),
      }),
    }),
    bulkDelete: async (ids: string[]) => {
      const doomed = new Set(ids);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (doomed.has(rows[index].id)) rows.splice(index, 1);
      }
    },
  };
}

vi.mock('@/lib/device-storage/database', () => ({
  db: {
    mediaFiles: indexedRows(mocks.mediaRows),
    audioFiles: indexedRows(mocks.audioRows),
  },
}));

import {
  collectPersistedDocumentAssetRefs,
  collectStageAssetRefs,
} from '@/lib/media/collect-stage-asset-refs';
import { clearStageMediaCache } from '@/lib/media/clear-stage-media-cache';

const stageId = 'stage-matrix';

function slide(id: string, elements: Array<Record<string, unknown>>) {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background:
      id === 'slide-exclusive'
        ? { type: 'image', image: { src: 'background-exclusive-ref' } }
        : { type: 'solid', color: '#fff' },
    elements,
  };
}

function matrixDocument(): StageAssetDocument {
  return {
    stage: {
      id: stageId,
      name: 'Matrix',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [
        slide('stage-whiteboard', [
          { id: 'stage-whiteboard-image', type: 'image', src: 'stage-whiteboard-ref' },
        ]),
      ],
      videoManifest: {
        'video-media-exclusive': { type: 'video', prompt: 'Clip' },
        'manifest-only': { type: 'video', prompt: 'Detached metadata' },
      },
    },
    scenes: [
      {
        id: 'scene-exclusive',
        stageId,
        type: 'slide',
        title: 'Exclusive',
        order: 1,
        content: {
          type: 'slide',
          canvas: slide('slide-exclusive', [
            { id: 'image-exclusive', type: 'image', src: 'image-exclusive-ref' },
            {
              id: 'video-exclusive',
              type: 'video',
              src: 'video-src-exclusive',
              mediaRef: 'video-media-exclusive',
              poster: 'poster-exclusive',
            },
            { id: 'foreign-image', type: 'image', src: 'foreign-course-ref' },
          ]),
        },
        whiteboards: [
          slide('scene-whiteboard', [
            { id: 'scene-whiteboard-image', type: 'image', src: 'scene-whiteboard-ref' },
          ]),
        ],
        actions: [
          { id: 'speech-owned', type: 'speech', text: 'Owned', audioId: 'audio-exclusive' },
          { id: 'speech-legacy', type: 'speech', text: 'Legacy', audioId: 'tts_s1_action_1' },
        ],
      },
    ],
  } as unknown as StageAssetDocument;
}

function documentWithImage(id: string, ref: string): StageAssetDocument {
  return {
    stage: { id, name: id, createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: `${id}-scene`,
        stageId: id,
        type: 'slide',
        title: id,
        order: 1,
        content: {
          type: 'slide',
          canvas: slide(`${id}-slide`, [{ id: `${id}-image`, type: 'image', src: ref }]),
        },
      },
    ],
  } as unknown as StageAssetDocument;
}

async function resolveImageBytes(document: StageAssetDocument): Promise<string | undefined> {
  const scene = document.scenes[0];
  if (scene?.content.type !== 'slide') return undefined;
  const element = scene.content.canvas.elements[0];
  if (element?.type !== 'image') return undefined;
  return mocks.poolBytes.get(element.src)?.text();
}

const mediaRefs = [
  'stage-whiteboard-ref',
  'scene-whiteboard-ref',
  'image-exclusive-ref',
  'video-src-exclusive',
  'video-media-exclusive',
  'poster-exclusive',
  'manifest-only',
  'media-orphan',
  'background-exclusive-ref',
];

describe('stage deletion: document references and the local media cache', () => {
  beforeEach(() => {
    mocks.documents.clear();
    mocks.poolBytes.clear();
    mocks.removeAsset.mockReset().mockImplementation(async (ref: string) => {
      mocks.poolBytes.delete(ref);
    });
    mocks.listDocuments
      .mockReset()
      .mockImplementation(async () => [...mocks.documents.keys()].map((id) => ({ id })));
    mocks.loadDocument
      .mockReset()
      .mockImplementation(async (id: string) => mocks.documents.get(id) ?? null);
    mocks.mediaRows.splice(
      0,
      mocks.mediaRows.length,
      ...mediaRefs.map((ref) => ({ id: `${stageId}:${ref}`, stageId })),
      { id: 'other-stage:foreign-course-ref', stageId: 'other-stage' },
    );
    mocks.audioRows.splice(
      0,
      mocks.audioRows.length,
      { id: 'audio-exclusive', stageId },
      { id: 'audio-orphan', stageId },
      { id: 'tts_s1_action_1' },
      { id: 'other-audio', stageId: 'other-stage' },
    );
    for (const ref of [...mediaRefs, 'audio-exclusive', 'audio-orphan']) {
      mocks.poolBytes.set(ref, new Blob([`${ref}-bytes`]));
    }
  });

  it('enumerates every document reference category', () => {
    const refs = collectStageAssetRefs(matrixDocument());

    expect(refs.imageSrc).toEqual(
      new Set([
        'stage-whiteboard-ref',
        'image-exclusive-ref',
        'foreign-course-ref',
        'scene-whiteboard-ref',
      ]),
    );
    expect(refs.videoSrc).toEqual(new Set(['video-src-exclusive']));
    expect(refs.videoMediaRef).toEqual(new Set(['video-media-exclusive']));
    expect(refs.poster).toEqual(new Set(['poster-exclusive']));
    expect(refs.backgroundImage).toEqual(new Set(['background-exclusive-ref']));
    expect(refs.stageWhiteboard).toEqual(new Set(['stage-whiteboard-ref']));
    expect(refs.sceneWhiteboard).toEqual(new Set(['scene-whiteboard-ref']));
    expect(refs.speechAudioId).toEqual(new Set(['audio-exclusive', 'tts_s1_action_1']));
    expect(refs.videoManifestKey).toEqual(new Set(['video-media-exclusive', 'manifest-only']));
  });

  it('counts a ref one element names twice as one logical owner', () => {
    const refs = collectStageAssetRefs(matrixDocument());

    // `video-media-exclusive` is the element's mediaRef and a manifest key; the
    // DSL's position-keyed accounting is what stops that from reading as two
    // owners, which is what in-place byte replacement decides on.
    expect(refs.referenceCounts.get('video-media-exclusive')).toBe(1);
    expect(refs.referenceCounts.get('image-exclusive-ref')).toBe(1);
  });

  it('clears every media row of the deleted stage and leaves foreign ones', async () => {
    await clearStageMediaCache(stageId);

    // Media rows are indexed by stage and belong to exactly one, so liveness
    // never enters into it: the other course keeps its row, this one keeps none.
    expect(mocks.mediaRows).toEqual([
      { id: 'other-stage:foreign-course-ref', stageId: 'other-stage' },
    ]);
  });

  it('keeps every audio row, including the deleted stage rows', async () => {
    const before = [...mocks.audioRows];

    await clearStageMediaCache(stageId);

    // Audio rows are keyed globally by audio id, and another course (a copy,
    // or another owner's course opened here) may play from the same id. No
    // browser can enumerate every such course, so the rows stay until the
    // local cache is cleared, and no document listing is attempted.
    expect(mocks.audioRows).toEqual(before);
    expect(mocks.listDocuments).not.toHaveBeenCalled();
  });

  it('never asks the asset pool to delete anything', async () => {
    await clearStageMediaCache(stageId);

    expect(mocks.removeAsset).not.toHaveBeenCalled();
    // The bytes are still there. Releasing the registry entry, and the bytes
    // behind it, is the server's pass, not this browser's.
    expect(await mocks.poolBytes.get('image-exclusive-ref')?.text()).toBe(
      'image-exclusive-ref-bytes',
    );
  });

  it('preserves a globally shared pool ref when one owning stage is deleted', async () => {
    const sharedRef = 'ast_cross_document_alias';
    const deletedStageId = 'stage-deleted';
    const deletedDocument = documentWithImage(deletedStageId, sharedRef);
    const survivingDocument = documentWithImage('stage-surviving', sharedRef);
    mocks.mediaRows.splice(0, mocks.mediaRows.length, {
      id: `${deletedStageId}:${sharedRef}`,
      stageId: deletedStageId,
    });
    mocks.audioRows.splice(0, mocks.audioRows.length);
    mocks.poolBytes.set(sharedRef, new Blob(['shared-surviving-bytes']));
    mocks.documents.set(deletedDocument.stage.id, deletedDocument);
    mocks.documents.set(survivingDocument.stage.id, survivingDocument);
    expect(
      collectPersistedDocumentAssetRefs([...mocks.documents.values()]).referenceCounts.get(
        sharedRef,
      ),
    ).toBe(2);
    mocks.documents.delete(deletedStageId);

    await clearStageMediaCache(deletedStageId);

    expect(mocks.removeAsset).not.toHaveBeenCalledWith(sharedRef);
    expect(mocks.mediaRows).toEqual([]);
    expect(await resolveImageBytes(survivingDocument)).toBe('shared-surviving-bytes');
  });

  it('holds no registry reclamation of its own', () => {
    const source = readFileSync('lib/media/clear-stage-media-cache.ts', 'utf8');

    // The registry half of stage deletion is the server's: deleting the
    // document withdraws its references, and the collector releases an entry
    // nothing claims. A browser that tried would be refused, and must not try.
    expect(source).not.toMatch(/asset-pool|removeAsset/);
  });

  it.each([
    ['canvas element deletion', 'lib/hooks/use-canvas-operations.ts'],
    ['slide-surface element deletion', 'components/edit/surfaces/slide/use-slide-surface.ts'],
    ['speech-cue deletion and audio supersession', 'components/edit/ActionsBar/ActionsBar.tsx'],
    ['scene deletion and undo', 'components/edit/SlideNavRail/SlideNavRail.tsx'],
  ])('%s cannot remove pool or Dexie assets', (_entryPoint, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(
      /(?:clear-stage-media-cache|removeAsset|\.(?:audioFiles|mediaFiles)\.(?:delete|bulkDelete))/,
    );
  });
});
