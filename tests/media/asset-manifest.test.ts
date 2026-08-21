import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * buildStageAssetManifest layers compatibility-row metadata onto the pure dsl
 * enumeration. These tests pin the join semantics: metadata attaches by ref,
 * rows nothing references never appear (orphan exclusion at the metadata
 * layer), and refs without rows stay metadata-free rather than missing.
 */
const mocks = vi.hoisted(() => ({
  mediaRows: new Map<string, Record<string, unknown>>(),
  audioRows: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: { get: async (id: string) => mocks.mediaRows.get(id) },
    audioFiles: { get: async (id: string) => mocks.audioRows.get(id) },
  },
}));

import { buildStageAssetManifest } from '@/lib/media/asset-manifest';
import type { Scene, Stage } from '@/lib/types/stage';

const STAGE_ID = 'stage-1';

function sceneWithImage(ref: string): Scene {
  return {
    id: 'scene-1',
    stageId: STAGE_ID,
    title: 'Scene',
    order: 0,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: { id: 'slide-1', elements: [{ id: 'img-1', type: 'image', src: ref }] },
    },
    actions: [{ id: 'a1', type: 'speech', text: 'hi', audioId: 'ast_narration' }],
  } as unknown as Scene;
}

const stage = { id: STAGE_ID } as Stage;

afterEach(() => {
  mocks.mediaRows.clear();
  mocks.audioRows.clear();
});

describe('buildStageAssetManifest', () => {
  it('attaches row metadata to the enumerated refs', async () => {
    mocks.mediaRows.set(`${STAGE_ID}:ast_image`, {
      id: `${STAGE_ID}:ast_image`,
      stageId: STAGE_ID,
      type: 'image',
      blob: new Blob(['x']),
      mimeType: 'image/png',
      size: 2048,
      prompt: 'a diagram',
    });
    mocks.audioRows.set('ast_narration', {
      id: 'ast_narration',
      blob: new Blob(['aa'], { type: 'audio/mpeg' }),
      format: 'mp3',
      duration: 2.5,
      voice: 'alloy',
    });

    const manifest = await buildStageAssetManifest(stage, [sceneWithImage('ast_image')], STAGE_ID);

    expect(manifest.entries).toEqual([
      {
        ref: 'ast_image',
        kind: 'image',
        byteSize: 2048,
        mimeType: 'image/png',
        prompt: 'a diagram',
      },
      {
        ref: 'ast_narration',
        kind: 'audio',
        byteSize: 2,
        mimeType: 'audio/mpeg',
        durationSeconds: 2.5,
        voice: 'alloy',
      },
    ]);
    expect(manifest.referenceCounts.get('ast_image')).toBe(1);
    expect(manifest.referenceCounts.get('ast_narration')).toBe(1);
  });

  it('excludes orphan rows and keeps row-less refs metadata-free', async () => {
    // Rows exist for refs the document does not name; the manifest must not
    // surface them. The referenced asset has no row and keeps only ref+kind.
    mocks.mediaRows.set(`${STAGE_ID}:ast_orphan`, {
      id: `${STAGE_ID}:ast_orphan`,
      stageId: STAGE_ID,
      mimeType: 'image/png',
      size: 10,
    });

    const manifest = await buildStageAssetManifest(
      stage,
      [sceneWithImage('ast_rowless')],
      STAGE_ID,
    );

    expect(manifest.entries.map((entry) => entry.ref)).toEqual(['ast_rowless', 'ast_narration']);
    expect(manifest.entries[0]).toEqual({ ref: 'ast_rowless', kind: 'image' });
  });
});
