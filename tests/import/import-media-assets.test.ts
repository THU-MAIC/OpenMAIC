import { BrowserAssetStore } from '@openmaic/storage';
import { IDBFactory } from 'fake-indexeddb';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { expectDocumentAssetOwnership } from '../media/assert-stage-asset-ownership';

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  mediaPut: vi.fn(),
  audioPut: vi.fn(),
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => mocks.getPool(),
  putAsset: (...args: unknown[]) => mocks.getPool().put(...args),
  removeAsset: (...args: unknown[]) => mocks.getPool().remove(...args),
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: { put: mocks.mediaPut },
    audioFiles: { put: mocks.audioPut },
  },
}));

import {
  materializeImportedAudio,
  materializeImportedMedia,
  mediaRefFromZipPath,
  rewriteImportedSlideMediaRefs,
  rewriteImportedVideoManifest,
} from '@/lib/import/use-import-classroom';

describe('classroom import media allocation', () => {
  let pool: BrowserAssetStore;
  let objectUrls: Map<string, Blob>;

  beforeEach(() => {
    pool = new BrowserAssetStore({
      indexedDB: new IDBFactory(),
      dbName: `import-media-${crypto.randomUUID()}`,
    });
    mocks.getPool.mockReset().mockReturnValue(pool);
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    objectUrls = new Map();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:import-${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(async () => {
    await pool.close();
    vi.unstubAllGlobals();
  });

  async function poolText(ref: string): Promise<string | null> {
    const url = await pool.resolve(ref);
    if (!url) return null;
    try {
      return (await objectUrls.get(url)?.text()) ?? null;
    } finally {
      await pool.release(ref);
    }
  }

  it('re-mints colliding video and poster refs without changing the source assets', async () => {
    const sourceVideoId = await pool.put(new Blob(['source-video'], { type: 'video/mp4' }));
    const sourcePosterId = await pool.put(new Blob(['source-poster'], { type: 'image/jpeg' }));
    const sourceVideoBefore = await poolText(sourceVideoId);
    const sourcePosterBefore = await poolText(sourcePosterId);

    const videoPath = `media/${sourceVideoId}.mp4`;
    const posterPath = `media/${sourcePosterId}.jpg`;
    const zip = new JSZip();
    zip.file(videoPath, 'imported-video');
    zip.file(videoPath.replace(/\.\w+$/, '.poster.jpg'), 'imported-poster');
    zip.file(posterPath, 'imported-poster');

    const slide = {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        fontName: 'Arial',
        fontColor: '#111111',
        backgroundColor: '#ffffff',
        themeColors: ['#111111'],
      },
      elements: [
        {
          id: 'video-1',
          type: 'video',
          src: sourceVideoId,
          mediaRef: sourceVideoId,
          poster: sourcePosterId,
          left: 0,
          top: 0,
          width: 100,
          height: 56,
          rotate: 0,
          autoplay: false,
        },
      ],
    } as Slide;
    const manifest = {
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: {
        name: 'Imported',
        createdAt: 1,
        updatedAt: 1,
        videoManifest: { [sourceVideoId]: { type: 'video', prompt: 'Clip' } },
      },
      agents: [],
      scenes: [
        {
          type: 'slide',
          title: 'Scene',
          order: 1,
          content: { type: 'slide', canvas: slide },
        },
      ],
      mediaIndex: {
        [videoPath]: { type: 'generated', mimeType: 'video/mp4', size: 14, prompt: 'Clip' },
        [posterPath]: {
          type: 'generated',
          mimeType: 'image/jpeg',
          size: 15,
          prompt: 'Poster',
        },
      },
    } satisfies ClassroomManifest;

    const allocatedIds: string[] = [];
    const mappings = await materializeImportedMedia(
      zip,
      manifest,
      'imported-stage',
      2,
      allocatedIds,
    );
    const importedSlide = rewriteImportedSlideMediaRefs(slide, mappings);
    const importedManifest = rewriteImportedVideoManifest(manifest.stage.videoManifest, mappings);
    const newVideoId = mappings.refToNewId[sourceVideoId];
    const newPosterId = mappings.refToNewId[sourcePosterId];

    expect(newVideoId).not.toBe(sourceVideoId);
    expect(newPosterId).not.toBe(sourcePosterId);
    expect(allocatedIds).toEqual([newVideoId, newPosterId]);
    expect(importedSlide.elements[0]).toMatchObject({
      src: newVideoId,
      mediaRef: newVideoId,
      poster: newPosterId,
    });
    expect(importedManifest).toEqual({
      [newVideoId]: { type: 'video', prompt: 'Clip' },
    });
    expect(await poolText(newVideoId)).toBe('imported-video');
    expect(await poolText(newPosterId)).toBe('imported-poster');

    // Byte-compare the colliding source-course entries before and after import.
    expect(await poolText(sourceVideoId)).toBe(sourceVideoBefore);
    expect(await poolText(sourcePosterId)).toBe(sourcePosterBefore);
    expect(mocks.mediaPut).toHaveBeenCalledTimes(2);
    expect(new Set(mocks.mediaPut.mock.calls.map(([row]) => row.id))).toEqual(
      new Set([`imported-stage:${newVideoId}`, `imported-stage:${newPosterId}`]),
    );
    await expectDocumentAssetOwnership({
      document: {
        stage: {
          id: 'imported-stage',
          name: 'Imported',
          createdAt: 1,
          updatedAt: 2,
          videoManifest: importedManifest,
        },
        scenes: [
          {
            id: 'scene-1',
            stageId: 'imported-stage',
            title: 'Scene',
            order: 1,
            type: 'slide',
            content: { type: 'slide', canvas: importedSlide },
          },
        ],
      } as Parameters<typeof expectDocumentAssetOwnership>[0]['document'],
      mediaRowIds: new Set(mocks.mediaPut.mock.calls.map(([row]) => row.id)),
      audioRowIds: new Set(),
      poolHas: async (ref) => {
        const url = await pool.resolve(ref);
        if (!url) return false;
        await pool.release(ref);
        return true;
      },
    });
  });

  it('clears opaque unmapped refs while preserving mapped, generated, and concrete refs', () => {
    const rewritten = rewriteImportedSlideMediaRefs(
      {
        id: 'slide-refs',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          fontName: 'Arial',
          fontColor: '#111111',
          backgroundColor: '#ffffff',
          themeColors: ['#111111'],
        },
        elements: [
          { id: 'mapped', type: 'image', src: 'source-image' },
          { id: 'foreign', type: 'image', src: 'foreign-course-id' },
          { id: 'placeholder', type: 'image', src: 'gen_img_waiting' },
          { id: 'data-image', type: 'image', src: 'data:image/png;base64,AAAA' },
          { id: 'remote-image', type: 'image', src: 'https://example.test/image.png' },
          { id: 'relative-image', type: 'image', src: 'media/user-image.png' },
          {
            id: 'video',
            type: 'video',
            src: 'foreign-video',
            mediaRef: 'foreign-video-ref',
            poster: 'foreign-poster',
          },
          {
            id: 'concrete-video',
            type: 'video',
            src: 'https://example.test/video.mp4',
            mediaRef: 'videos/user-video.mp4',
            poster: 'data:image/jpeg;base64,BBBB',
          },
        ],
      } as unknown as Slide,
      {
        refToNewId: { 'source-image': 'ast_new_image' },
        posterRefToNewId: {},
        posterByMediaRef: {},
      },
    );

    expect(rewritten.elements[0]).toMatchObject({ src: 'ast_new_image' });
    expect(rewritten.elements[1]).toMatchObject({ src: '' });
    expect(rewritten.elements[2]).toMatchObject({ src: 'gen_img_waiting' });
    expect(rewritten.elements[3]).toMatchObject({ src: 'data:image/png;base64,AAAA' });
    expect(rewritten.elements[4]).toMatchObject({ src: 'https://example.test/image.png' });
    expect(rewritten.elements[5]).toMatchObject({ src: 'media/user-image.png' });
    expect(rewritten.elements[6]).toMatchObject({ src: '' });
    expect(rewritten.elements[6]).not.toHaveProperty('mediaRef');
    expect(rewritten.elements[6]).not.toHaveProperty('poster');
    expect(rewritten.elements[7]).toMatchObject({
      src: 'https://example.test/video.mp4',
      mediaRef: 'videos/user-video.mp4',
      poster: 'data:image/jpeg;base64,BBBB',
    });

    expect(
      rewriteImportedVideoManifest(
        {
          foreign: { type: 'video', prompt: 'drop' },
          'https://example.test/video.mp4': { type: 'video', prompt: 'remote' },
          'videos/user-video.mp4': { type: 'video', prompt: 'relative' },
          gen_vid_waiting: { type: 'video', prompt: 'generated' },
        },
        {
          refToNewId: {},
          posterRefToNewId: {},
          posterByMediaRef: {},
        },
      ),
    ).toEqual({
      'https://example.test/video.mp4': { type: 'video', prompt: 'remote' },
      'videos/user-video.mp4': { type: 'video', prompt: 'relative' },
      gen_vid_waiting: { type: 'video', prompt: 'generated' },
    });
  });

  it.each(['media/123', 'api/media?id=1', '/path/to/resource', 'path?query=val'])(
    'preserves the extensionless relative media address %s',
    (address) => {
      const rewritten = rewriteImportedSlideMediaRefs(
        {
          id: 'slide-relative-refs',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          background: { type: 'image', image: { src: address } },
          elements: [
            { id: 'image', type: 'image', src: address },
            {
              id: 'video',
              type: 'video',
              src: address,
              mediaRef: address,
              poster: address,
            },
          ],
        } as unknown as Slide,
        { refToNewId: {}, posterRefToNewId: {}, posterByMediaRef: {} },
      );

      expect(rewritten.background).toMatchObject({ type: 'image', image: { src: address } });
      expect(rewritten.elements[0]).toMatchObject({ src: address });
      expect(rewritten.elements[1]).toMatchObject({
        src: address,
        mediaRef: address,
        poster: address,
      });
    },
  );

  it('falls back to the general ref mapping for an independently indexed poster', () => {
    const rewritten = rewriteImportedSlideMediaRefs(
      {
        id: 'slide-poster',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          fontName: 'Arial',
          fontColor: '#111111',
          backgroundColor: '#ffffff',
          themeColors: ['#111111'],
        },
        elements: [
          {
            id: 'video',
            type: 'video',
            src: 'source-video',
            mediaRef: 'source-video',
            poster: 'source-poster',
          },
        ],
      } as unknown as Slide,
      {
        refToNewId: {
          'source-video': 'ast_new_video',
          'source-poster': 'ast_new_poster',
        },
        posterRefToNewId: {},
        posterByMediaRef: {},
      },
    );

    expect(rewritten.elements[0]).toMatchObject({
      src: 'ast_new_video',
      mediaRef: 'ast_new_video',
      poster: 'ast_new_poster',
    });
  });

  it.each([
    [
      'mapped',
      'source-background',
      { 'source-background': 'ast_new_background' },
      'ast_new_background',
    ],
    ['generated', 'gen_img_background', {}, 'gen_img_background'],
    ['concrete', 'https://example.test/background.png', {}, 'https://example.test/background.png'],
    ['unmapped opaque', 'foreign-background', {}, ''],
  ])(
    'rewrites a %s slide background through the import boundary',
    (_case, src, mapping, expected) => {
      const rewritten = rewriteImportedSlideMediaRefs(
        {
          id: 'slide-background',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          background: { type: 'image', image: { src } },
          elements: [],
        } as unknown as Slide,
        {
          refToNewId: mapping,
          posterRefToNewId: {},
          posterByMediaRef: {},
        },
      );

      expect(rewritten.background).toMatchObject({ type: 'image', image: { src: expected } });
    },
  );

  it('allocates audio only after confirming the ZIP entry and stamps stage ownership', async () => {
    const zip = new JSZip();
    const missingPath = 'audio/missing.mp3';
    const presentPath = 'audio/present.mp3';
    zip.file(presentPath, 'voice-bytes');
    const manifest = {
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [],
      mediaIndex: {
        [missingPath]: { type: 'audio', format: 'mp3' },
        [presentPath]: { type: 'audio', format: 'mp3' },
      },
    } satisfies ClassroomManifest;
    const allocations: string[] = [];
    const put = vi.spyOn(pool, 'put');

    const mappings = await materializeImportedAudio(
      zip,
      manifest,
      'imported-stage',
      2,
      allocations,
    );

    expect(mappings[missingPath]).toBeUndefined();
    expect(mappings[presentPath]).toMatch(/^ast_/);
    expect(put).toHaveBeenCalledTimes(1);
    expect(allocations).toEqual([mappings[presentPath]]);
    expect(mocks.audioPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: mappings[presentPath], stageId: 'imported-stage' }),
    );
  });

  it('re-derives nested refs with parameterized MIME metadata intact', () => {
    expect(mediaRefFromZipPath('media/nested/course/ref.svg', 'image/svg+xml; charset=utf-8')).toBe(
      'nested/course/ref',
    );
    expect(
      mediaRefFromZipPath(
        'media/nested/course/ref.svg+xml;charset=utf-8',
        'image/svg+xml;charset=utf-8',
      ),
    ).toBe('nested/course/ref');
  });
});
