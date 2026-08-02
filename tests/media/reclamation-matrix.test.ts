import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageAssetDocument } from '@/lib/media/collect-stage-asset-refs';

const mocks = vi.hoisted(() => ({
  removeAsset: vi.fn(),
  mediaRows: [] as Array<{ id: string; stageId: string }>,
  audioRows: [] as Array<{ id: string; stageId?: string }>,
}));

vi.mock('@/lib/media/asset-pool', () => ({
  removeAsset: mocks.removeAsset,
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

import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
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
    mocks.removeAsset.mockReset().mockResolvedValue(undefined);
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
      /(?:reclaim-stage-assets|removeAsset|\.audioFiles\.(?:delete|bulkDelete))/,
    );
  });
});
