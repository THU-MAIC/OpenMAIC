import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageAssetDocument } from '@/lib/media/collect-stage-asset-refs';

const mocks = vi.hoisted(() => ({
  removeAsset: vi.fn(),
  mediaBulkDelete: vi.fn(),
  audioBulkDelete: vi.fn(),
}));

vi.mock('@/lib/media/asset-pool', () => ({
  removeAsset: mocks.removeAsset,
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    mediaFiles: { bulkDelete: mocks.mediaBulkDelete },
    audioFiles: { bulkDelete: mocks.audioBulkDelete },
  },
}));

import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import {
  buildStageAssetReclamationPlan,
  executeStageAssetReclamation,
} from '@/lib/media/reclaim-stage-assets';
import { expectDocumentAssetOwnership } from './assert-stage-asset-ownership';

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
            {
              id: 'video-shared',
              type: 'video',
              src: 'ast_shared_ref',
              mediaRef: 'ast_shared_ref',
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
          { id: 'speech-legacy', type: 'speech', text: 'Legacy', audioId: 'legacy-audio' },
        ],
      },
      {
        id: 'scene-shared',
        stageId,
        type: 'slide',
        title: 'Shared',
        order: 2,
        content: {
          type: 'slide',
          canvas: slide('slide-shared', [
            { id: 'image-shared', type: 'image', src: 'ast_shared_ref' },
          ]),
        },
      },
    ],
  } as unknown as StageAssetDocument;
}

const mediaRefs = [
  'stage-whiteboard-ref',
  'scene-whiteboard-ref',
  'image-exclusive-ref',
  'video-src-exclusive',
  'video-media-exclusive',
  'poster-exclusive',
  'ast_shared_ref',
  'manifest-only',
  'media-orphan',
  'background-exclusive-ref',
];
const mediaRows = mediaRefs.map((ref) => ({ id: `${stageId}:${ref}`, stageId }));
const audioRows = [
  { id: 'audio-exclusive', stageId },
  { id: 'audio-orphan', stageId },
];

function refsFor(document: StageAssetDocument) {
  return collectStageAssetRefs(document, { mediaRows, audioRows });
}

function withoutExclusiveScene(document: StageAssetDocument): StageAssetDocument {
  return { ...document, scenes: document.scenes.filter((scene) => scene.id !== 'scene-exclusive') };
}

function withoutSpeechCues(document: StageAssetDocument): StageAssetDocument {
  return {
    ...document,
    scenes: document.scenes.map((scene) =>
      scene.id === 'scene-exclusive' ? { ...scene, actions: [] } : scene,
    ),
  };
}

describe('stage asset reference and reclamation matrix', () => {
  beforeEach(() => {
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
    mocks.mediaBulkDelete.mockReset().mockResolvedValue(undefined);
    mocks.audioBulkDelete.mockReset().mockResolvedValue(undefined);
  });

  it('enumerates every reference category, including both whiteboard locations and orphans', () => {
    const refs = refsFor(matrixDocument());

    expect(refs.imageSrc).toEqual(
      new Set([
        'stage-whiteboard-ref',
        'image-exclusive-ref',
        'foreign-course-ref',
        'scene-whiteboard-ref',
        'ast_shared_ref',
      ]),
    );
    expect(refs.videoSrc).toEqual(new Set(['video-src-exclusive', 'ast_shared_ref']));
    expect(refs.videoMediaRef).toEqual(new Set(['video-media-exclusive', 'ast_shared_ref']));
    expect(refs.poster).toEqual(new Set(['poster-exclusive']));
    expect(refs.backgroundImage).toEqual(new Set(['background-exclusive-ref']));
    expect(refs.stageWhiteboard).toEqual(new Set(['stage-whiteboard-ref']));
    expect(refs.sceneWhiteboard).toEqual(new Set(['scene-whiteboard-ref']));
    expect(refs.speechAudioId).toEqual(new Set(['audio-exclusive', 'legacy-audio']));
    expect(refs.videoManifestKey).toEqual(new Set(['video-media-exclusive', 'manifest-only']));
    expect(refs.mediaOrphans).toEqual(new Set(['media-orphan']));
    expect(refs.audioOrphans).toEqual(new Set(['audio-orphan']));
    expect(refs.referenceCounts.get('ast_shared_ref')).toBe(2);
  });

  it.each([
    ['deleteStageData', null],
    ['deleteStageWithRelatedData', null],
    ['deleteScene', withoutExclusiveScene(matrixDocument())],
    ['deleteSpeechCue', withoutSpeechCues(matrixDocument())],
  ] as const)('builds the pool and Dexie reclamation plan for %s', (entryPoint, afterDocument) => {
    const document = matrixDocument();
    const before = refsFor(document);
    const after = afterDocument ? refsFor(afterDocument) : null;
    const plan = buildStageAssetReclamationPlan(stageId, before, after, mediaRows, audioRows);

    if (entryPoint === 'deleteStageData' || entryPoint === 'deleteStageWithRelatedData') {
      expect(new Set(plan.poolRefs)).toEqual(
        new Set([...mediaRefs, 'audio-exclusive', 'audio-orphan']),
      );
      expect(new Set(plan.mediaRowIds)).toEqual(new Set(mediaRows.map((row) => row.id)));
      expect(new Set(plan.audioRowIds)).toEqual(new Set(['audio-exclusive', 'audio-orphan']));
      expect(plan.poolRefs).not.toContain('foreign-course-ref');
      expect(plan.poolRefs).not.toContain('legacy-audio');
      return;
    }

    if (entryPoint === 'deleteScene') {
      expect(new Set(plan.poolRefs)).toEqual(
        new Set([
          'image-exclusive-ref',
          'video-src-exclusive',
          'video-media-exclusive',
          'poster-exclusive',
          'scene-whiteboard-ref',
          'audio-exclusive',
          'background-exclusive-ref',
        ]),
      );
      expect(plan.poolRefs).not.toContain('ast_shared_ref');
      expect(plan.poolRefs).not.toContain('stage-whiteboard-ref');
      expect(plan.poolRefs).not.toContain('media-orphan');
      return;
    }

    expect(plan.poolRefs).toEqual(['audio-exclusive']);
    expect(plan.mediaRowIds).toEqual([]);
    expect(plan.audioRowIds).toEqual(['audio-exclusive']);
  });

  it('continues after one pool removal fails and still deletes every compatibility row', async () => {
    const before = refsFor(matrixDocument());
    const plan = buildStageAssetReclamationPlan(stageId, before, null, mediaRows, audioRows);
    mocks.removeAsset.mockRejectedValueOnce(new Error('broken entry'));

    await executeStageAssetReclamation(plan, null);

    expect(mocks.removeAsset).toHaveBeenCalledTimes(plan.poolRefs.length);
    expect(mocks.mediaBulkDelete).toHaveBeenCalledExactlyOnceWith([...plan.mediaRowIds]);
    expect(mocks.audioBulkDelete).toHaveBeenCalledExactlyOnceWith([...plan.audioRowIds]);
  });

  it('drops restored refs from a stale plan at execution time', async () => {
    const before = refsFor(matrixDocument());
    const afterDelete = refsFor(withoutExclusiveScene(matrixDocument()));
    const plan = buildStageAssetReclamationPlan(stageId, before, afterDelete, mediaRows, audioRows);

    const executed = await executeStageAssetReclamation(plan, matrixDocument());

    expect(executed).toEqual({ stageId, poolRefs: [], mediaRowIds: [], audioRowIds: [] });
    expect(mocks.removeAsset).not.toHaveBeenCalled();
    expect(mocks.mediaBulkDelete).not.toHaveBeenCalled();
    expect(mocks.audioBulkDelete).not.toHaveBeenCalled();
  });

  it('reconciles the surviving document against both stores after reclamation', async () => {
    const document = matrixDocument();
    const afterDocument = withoutExclusiveScene(document);
    const poolEntries = new Set([...mediaRefs, 'audio-exclusive', 'audio-orphan']);
    const mediaRowIds = new Set(mediaRows.map((row) => row.id));
    const audioRowIds = new Set(audioRows.map((row) => row.id));
    mocks.removeAsset.mockImplementation(async (ref: string) => {
      poolEntries.delete(ref);
    });
    mocks.mediaBulkDelete.mockImplementation(async (ids: string[]) => {
      for (const id of ids) mediaRowIds.delete(id);
    });
    mocks.audioBulkDelete.mockImplementation(async (ids: string[]) => {
      for (const id of ids) audioRowIds.delete(id);
    });
    const plan = buildStageAssetReclamationPlan(
      stageId,
      refsFor(document),
      refsFor(afterDocument),
      mediaRows,
      audioRows,
    );

    await executeStageAssetReclamation(plan, afterDocument);

    await expectDocumentAssetOwnership({
      document: afterDocument,
      mediaRowIds,
      audioRowIds,
      poolHas: async (ref) => poolEntries.has(ref),
    });
  });
});
