import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  StageAssetDocument,
  StageAudioRow,
  StageMediaRow,
} from '@/lib/media/collect-stage-asset-refs';

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

vi.mock('@/lib/utils/database', () => ({
  db: {
    mediaFiles: indexedRows(mocks.mediaRows),
    audioFiles: indexedRows(mocks.audioRows),
  },
}));

import {
  collectPersistedDocumentAssetRefs,
  collectStageAssetRefs,
} from '@/lib/media/collect-stage-asset-refs';
import {
  buildStageAssetReclamationPlan,
  executeStageAssetReclamation,
  loadStageAssetInventory,
} from '@/lib/media/reclaim-stage-assets';

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

function documentWithSpeechAudio(id: string, audioId: string): StageAssetDocument {
  return {
    stage: { id, name: id, createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: `${id}-scene`,
        stageId: id,
        type: 'slide',
        title: id,
        order: 1,
        content: { type: 'slide', canvas: slide(`${id}-slide`, []) },
        actions: [{ id: `${id}-speech`, type: 'speech', text: 'Shared', audioId }],
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

function documentWithSlideAudio(id: string, ref: string): StageAssetDocument {
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
          canvas: slide(`${id}-slide`, [{ id: `${id}-audio`, type: 'audio', src: ref }]),
        },
      },
    ],
  } as unknown as StageAssetDocument;
}

function documentWithManifestRef(id: string, ref: string): StageAssetDocument {
  return {
    stage: {
      id,
      name: id,
      createdAt: 1,
      updatedAt: 1,
      videoManifest: { [ref]: { type: 'video', prompt: 'Finishing before insertion' } },
    },
    scenes: [],
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

describe('stage asset reference and reclamation matrix', () => {
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
    const refs = collectStageAssetRefs(matrixDocument(), { mediaRows: [], audioRows: [] });

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

  it('builds a whole-stage plan from honestly stage-filtered rows', async () => {
    const inventory = await loadStageAssetInventory(matrixDocument());
    const plan = buildStageAssetReclamationPlan(
      stageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );

    expect(new Set(plan.poolRefs)).toEqual(
      new Set([...mediaRefs, 'audio-exclusive', 'audio-orphan']),
    );
    expect(new Set(plan.mediaRowIds)).toEqual(new Set(mediaRefs.map((ref) => `${stageId}:${ref}`)));
    expect(new Set(plan.audioRowIds)).toEqual(new Set(['audio-exclusive', 'audio-orphan']));
    expect(plan.poolRefs).not.toContain('foreign-course-ref');
    expect(plan.poolRefs).not.toContain('tts_s1_action_1');
  });

  it('filters unscoped and foreign legacy rows inside both pure functions', () => {
    const mediaRows = [
      { id: `${stageId}:image-exclusive-ref`, stageId },
      { id: 'other-stage:foreign-course-ref', stageId: 'other-stage' },
      { id: 'foreign-course-ref' } as unknown as StageMediaRow,
    ];
    const audioRows: StageAudioRow[] = [
      { id: 'audio-exclusive', stageId },
      { id: 'tts_s1_action_1' },
      { id: 'audio-exclusive', stageId: 'other-stage' },
    ];

    const refs = collectStageAssetRefs(matrixDocument(), { mediaRows, audioRows });
    expect(refs.mediaRow).toEqual(new Set(['image-exclusive-ref']));
    expect(refs.audioRow).toEqual(new Set(['audio-exclusive']));
    expect(refs.poolOwned).not.toContain('foreign-course-ref');
    expect(refs.poolOwned).not.toContain('tts_s1_action_1');

    const plan = buildStageAssetReclamationPlan(stageId, refs, mediaRows, audioRows);
    expect(plan.mediaRowIds).toEqual([`${stageId}:image-exclusive-ref`]);
    expect(plan.audioRowIds).toEqual(['audio-exclusive']);
  });

  it('stage deletion reclaims matched rows while stage-less legacy rows survive', async () => {
    const inventory = await loadStageAssetInventory(matrixDocument());
    const plan = buildStageAssetReclamationPlan(
      stageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).toHaveBeenCalledTimes(plan.poolRefs.length);
    expect(mocks.mediaRows).toEqual([
      { id: 'other-stage:foreign-course-ref', stageId: 'other-stage' },
    ]);
    expect(mocks.audioRows).toEqual([
      { id: 'tts_s1_action_1' },
      { id: 'other-audio', stageId: 'other-stage' },
    ]);
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
    const inventory = await loadStageAssetInventory(deletedDocument);
    const plan = buildStageAssetReclamationPlan(
      deletedStageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    mocks.documents.delete(deletedStageId);

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).not.toHaveBeenCalledWith(sharedRef);
    expect(mocks.mediaRows).toEqual([]);
    expect(await resolveImageBytes(survivingDocument)).toBe('shared-surviving-bytes');
  });

  it('preserves a shared ref referenced by a surviving slide-audio element', async () => {
    const sharedRef = 'ast_cross_role_alias';
    const deletedStageId = 'stage-deleted';
    const deletedDocument = documentWithImage(deletedStageId, sharedRef);
    const survivingDocument = documentWithSlideAudio('stage-surviving', sharedRef);
    mocks.mediaRows.splice(0, mocks.mediaRows.length, {
      id: `${deletedStageId}:${sharedRef}`,
      stageId: deletedStageId,
    });
    mocks.audioRows.splice(0, mocks.audioRows.length);
    mocks.poolBytes.set(sharedRef, new Blob(['shared-surviving-bytes']));
    mocks.documents.set(deletedDocument.stage.id, deletedDocument);
    mocks.documents.set(survivingDocument.stage.id, survivingDocument);
    const inventory = await loadStageAssetInventory(deletedDocument);
    const plan = buildStageAssetReclamationPlan(
      deletedStageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    mocks.documents.delete(deletedStageId);

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).not.toHaveBeenCalledWith(sharedRef);
  });

  it('preserves the compatibility row of an audio ref a surviving document shares', async () => {
    const sharedAudioId = 'ast_shared_audio_alias';
    const deletedStageId = 'stage-deleted';
    const deletedDocument = documentWithSpeechAudio(deletedStageId, sharedAudioId);
    const survivingDocument = documentWithSpeechAudio('stage-surviving', sharedAudioId);
    mocks.mediaRows.splice(0, mocks.mediaRows.length);
    // The row is keyed globally by audioId and only the deleted stage carries it.
    mocks.audioRows.splice(0, mocks.audioRows.length, {
      id: sharedAudioId,
      stageId: deletedStageId,
    });
    mocks.poolBytes.set(sharedAudioId, new Blob(['shared-audio-bytes']));
    mocks.documents.set(deletedDocument.stage.id, deletedDocument);
    mocks.documents.set(survivingDocument.stage.id, survivingDocument);
    const inventory = await loadStageAssetInventory(deletedDocument);
    const plan = buildStageAssetReclamationPlan(
      deletedStageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    expect(plan.audioRowIds).toContain(sharedAudioId);
    mocks.documents.delete(deletedStageId);

    await executeStageAssetReclamation(plan, null);

    // Playback, classroom export and video export read this table directly, so
    // the survivor keeps both the pool entry and its compatibility row.
    expect(mocks.removeAsset).not.toHaveBeenCalledWith(sharedAudioId);
    expect(mocks.audioRows.map((row) => row.id)).toContain(sharedAudioId);
  });

  it('keeps a shared audio row when surviving-document enumeration fails', async () => {
    const sharedAudioId = 'ast_shared_audio_unknown_liveness';
    const deletedStageId = 'stage-deleted';
    const deletedDocument = documentWithSpeechAudio(deletedStageId, sharedAudioId);
    const survivingDocument = documentWithSpeechAudio('stage-surviving', sharedAudioId);
    mocks.mediaRows.splice(0, mocks.mediaRows.length);
    mocks.audioRows.splice(0, mocks.audioRows.length, {
      id: sharedAudioId,
      stageId: deletedStageId,
    });
    mocks.poolBytes.set(sharedAudioId, new Blob(['shared-audio-bytes']));
    mocks.documents.set(deletedDocument.stage.id, deletedDocument);
    mocks.documents.set(survivingDocument.stage.id, survivingDocument);
    const inventory = await loadStageAssetInventory(deletedDocument);
    const plan = buildStageAssetReclamationPlan(
      deletedStageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    mocks.documents.delete(deletedStageId);
    mocks.listDocuments.mockRejectedValue(new Error('document repository unavailable'));

    await executeStageAssetReclamation(plan, null);

    // The pool entry survives, and so must the row the survivor plays from.
    expect(mocks.removeAsset).not.toHaveBeenCalled();
    expect(mocks.audioRows.map((row) => row.id)).toContain(sharedAudioId);
  });

  it('removes audio compatibility rows no surviving document references', async () => {
    const exclusiveAudioId = 'ast_exclusive_audio';
    const legacyAudioId = 'tts_s1_legacy';
    const deletedStageId = 'stage-deleted';
    const deletedDocument = documentWithSpeechAudio(deletedStageId, exclusiveAudioId);
    mocks.mediaRows.splice(0, mocks.mediaRows.length);
    mocks.audioRows.splice(
      0,
      mocks.audioRows.length,
      { id: exclusiveAudioId, stageId: deletedStageId },
      // Legacy rows never had a pool entry; they are still removable.
      { id: legacyAudioId, stageId: deletedStageId },
    );
    mocks.poolBytes.set(exclusiveAudioId, new Blob(['exclusive-audio']));
    mocks.documents.set(deletedDocument.stage.id, deletedDocument);
    const inventory = await loadStageAssetInventory(deletedDocument);
    const plan = buildStageAssetReclamationPlan(
      deletedStageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    mocks.documents.delete(deletedStageId);

    await executeStageAssetReclamation(plan, null);

    expect(mocks.audioRows).toEqual([]);
  });

  it('preserves a ref owned by a surviving document only through its video manifest', async () => {
    const sharedRef = 'ast_manifest_before_scene_insert';
    const deletedDocument = documentWithImage('stage-deleted', sharedRef);
    const survivingDocument = documentWithManifestRef('stage-surviving', sharedRef);
    mocks.mediaRows.splice(0, mocks.mediaRows.length, {
      id: `stage-deleted:${sharedRef}`,
      stageId: 'stage-deleted',
    });
    mocks.audioRows.splice(0, mocks.audioRows.length);
    mocks.documents.set(survivingDocument.stage.id, survivingDocument);
    const inventory = await loadStageAssetInventory(deletedDocument);
    const plan = buildStageAssetReclamationPlan(
      deletedDocument.stage.id,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).not.toHaveBeenCalledWith(sharedRef);
    expect(mocks.mediaRows).toEqual([]);
  });

  it('enumerates surviving documents once for every ref in a reclamation plan', async () => {
    mocks.documents.set('stage-one', documentWithImage('stage-one', 'unrelated-one'));
    mocks.documents.set('stage-two', documentWithManifestRef('stage-two', 'unrelated-two'));
    const inventory = await loadStageAssetInventory(matrixDocument());
    const plan = buildStageAssetReclamationPlan(
      stageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    expect(plan.poolRefs.length).toBeGreaterThan(3);

    await executeStageAssetReclamation(plan, null);

    expect(mocks.listDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.loadDocument).toHaveBeenCalledTimes(2);
  });

  it('fails closed when surviving document enumeration fails', async () => {
    const exclusiveRef = 'image-exclusive-ref';
    const inventory = await loadStageAssetInventory(matrixDocument());
    const plan = buildStageAssetReclamationPlan(
      stageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    mocks.listDocuments.mockRejectedValue(new Error('document repository unavailable'));

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).not.toHaveBeenCalled();
    expect(await mocks.poolBytes.get(exclusiveRef)?.text()).toBe(`${exclusiveRef}-bytes`);
    expect(mocks.mediaRows.every((row) => row.stageId !== stageId)).toBe(true);
    // Audio rows are globally keyed, so losing one is as irreversible for
    // playback and the export paths as removing the pool entry: unknown
    // liveness keeps them and leaves bounded garbage behind.
    expect(mocks.audioRows.map((row) => row.id)).toEqual(
      expect.arrayContaining([...plan.audioRowIds]),
    );
  });

  it('continues row cleanup after one pool removal fails', async () => {
    const inventory = await loadStageAssetInventory(matrixDocument());
    const plan = buildStageAssetReclamationPlan(
      stageId,
      inventory.refs,
      inventory.mediaRows,
      inventory.audioRows,
    );
    mocks.removeAsset.mockRejectedValueOnce(new Error('broken entry'));

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).toHaveBeenCalledTimes(plan.poolRefs.length);
    expect(mocks.mediaRows.every((row) => row.stageId !== stageId)).toBe(true);
    expect(mocks.audioRows.every((row) => row.stageId !== stageId)).toBe(true);
  });

  it.each([
    ['canvas element deletion', 'lib/hooks/use-canvas-operations.ts'],
    ['slide-surface element deletion', 'components/edit/surfaces/slide/use-slide-surface.ts'],
    ['speech-cue deletion and audio supersession', 'components/edit/ActionsBar/ActionsBar.tsx'],
    ['scene deletion and undo', 'components/edit/SlideNavRail/SlideNavRail.tsx'],
  ])('%s cannot remove pool or Dexie assets', (_entryPoint, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(
      /(?:reclaim-stage-assets|removeAsset|\.(?:audioFiles|mediaFiles)\.(?:delete|bulkDelete))/,
    );
  });
});
