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
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';

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
    const localRecord = [...mocks.mediaPut.mock.calls, ...mocks.audioPut.mock.calls]
      .map(([record]) => record as { id?: string; blob?: Blob })
      .find((record) => record.id === ref || record.id?.endsWith(`:${ref}`));
    if (localRecord?.blob) return localRecord.blob.text();
    const url = await pool.resolve(ref);
    if (!url) return null;
    try {
      return (await objectUrls.get(url)?.text()) ?? null;
    } finally {
      await pool.release(ref);
    }
  }

  it('round-trips adversarial refs through safe media and audio archive paths', async () => {
    const refs = ['../evil', 'a/b', 'a/../collision', 'collision'];
    const mediaPaths = refs.map((_, index) => `media/asset-${index + 1}.png`);
    const audioPaths = refs.map((_, index) => `audio/audio-${index + 1}.mp3`);
    const zip = new JSZip();
    for (const [index, path] of mediaPaths.entries()) zip.file(path, `media-${refs[index]}`);
    for (const [index, path] of audioPaths.entries()) zip.file(path, `audio-${refs[index]}`);

    const slide = {
      id: 'adversarial-slide',
      background: { type: 'image', image: { src: refs[3] } },
      elements: [
        { id: 'image', type: 'image', src: refs[0] },
        { id: 'video', type: 'video', src: refs[1], mediaRef: refs[1], poster: refs[2] },
        ...refs.map((ref, index) => ({ id: `audio-${index}`, type: 'audio', src: ref })),
      ],
    } as unknown as Slide;
    const manifest = {
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [
        {
          type: 'slide',
          title: 'Adversarial refs',
          order: 0,
          content: { type: 'slide', canvas: slide },
          actions: refs.map((_, index) => ({
            id: `speech-${index}`,
            type: 'speech' as const,
            text: `Speech ${index}`,
            audioRef: audioPaths[index],
          })),
        },
      ],
      mediaIndex: Object.fromEntries([
        ...mediaPaths.map((path, index) => [
          path,
          {
            type: 'generated' as const,
            sourceRef: refs[index],
            mimeType: index === 1 ? 'video/mp4' : 'image/png',
          },
        ]),
        ...audioPaths.map((path, index) => [
          path,
          { type: 'audio' as const, sourceRef: refs[index], format: 'mp3' },
        ]),
      ]),
    } satisfies ClassroomManifest;

    const mediaMappings = await materializeImportedMedia(zip, manifest, 'safe-stage', 2);
    const audioMappings = await materializeImportedAudio(zip, manifest, 'safe-stage', 2);
    const rewritten = rewriteImportedSlideMediaRefs(
      slide,
      mediaMappings,
      audioMappings.sourceRefToId,
    );
    const rewrittenActions = rewriteAudioRefsToIds(
      manifest.scenes[0].actions ?? [],
      audioMappings.pathToId,
    );
    const mediaIds = refs.map((ref) => mediaMappings.refToNewId.get(ref));
    const audioIds = refs.map((ref) => audioMappings.sourceRefToId.get(ref));

    expect(new Set(mediaIds).size).toBe(refs.length);
    expect(new Set(audioIds).size).toBe(refs.length);
    expect(rewritten.background).toMatchObject({ image: { src: mediaIds[3] } });
    expect(rewritten.elements[0]).toMatchObject({ src: mediaIds[0] });
    expect(rewritten.elements[1]).toMatchObject({
      src: mediaIds[1],
      mediaRef: mediaIds[1],
      poster: mediaIds[2],
    });
    refs.forEach((_, index) => {
      expect(rewritten.elements[index + 2]).toMatchObject({ src: audioIds[index] });
      expect(rewrittenActions[index]).toMatchObject({ audioId: audioIds[index] });
    });
    await Promise.all(
      refs.map(async (ref, index) => {
        expect(await poolText(mediaIds[index]!)).toBe(`media-${ref}`);
        expect(await poolText(audioIds[index]!)).toBe(`audio-${ref}`);
      }),
    );
  });

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
    const newVideoId = mappings.refToNewId.get(sourceVideoId)!;
    const newPosterId = mappings.refToNewId.get(sourcePosterId)!;

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

  it.each(['__proto__', 'constructor'])(
    'round-trips the adversarial media ref %s through every generated-media alias map',
    async (adversarialRef) => {
      const zip = new JSZip();
      const videoRef = adversarialRef;
      const indexedPosterRef = `${adversarialRef}-indexed-poster`;
      const videoPath = `media/${videoRef}.mp4`;
      const indexedPosterPath = `media/${indexedPosterRef}.jpg`;
      zip.file(videoPath, `video-${adversarialRef}`);
      zip.file(videoPath.replace(/\.mp4$/, '.poster.jpg'), `sibling-${adversarialRef}`);
      zip.file(indexedPosterPath, `poster-${adversarialRef}`);

      const slide = {
        id: `slide-${adversarialRef}`,
        elements: [
          {
            id: `video-${adversarialRef}`,
            type: 'video',
            src: videoRef,
            mediaRef: videoRef,
            poster: indexedPosterRef,
          },
        ],
      } as unknown as Slide;
      const manifest = {
        formatVersion: 1,
        exportedAt: new Date(0).toISOString(),
        appVersion: 'test',
        stage: {
          name: 'Imported',
          createdAt: 1,
          updatedAt: 1,
          videoManifest: Object.fromEntries([
            [videoRef, { type: 'video', prompt: adversarialRef }],
          ]),
        },
        agents: [],
        scenes: [
          {
            type: 'slide',
            title: 'Scene',
            order: 0,
            content: { type: 'slide', canvas: slide },
          },
        ],
        mediaIndex: Object.fromEntries([
          [videoPath, { type: 'generated', mimeType: 'video/mp4' }],
          [indexedPosterPath, { type: 'generated', mimeType: 'image/jpeg' }],
        ]),
      } satisfies ClassroomManifest;

      const mappings = await materializeImportedMedia(zip, manifest, 'imported-stage', 2);
      const rewrittenSlide = rewriteImportedSlideMediaRefs(slide, mappings);
      const rewrittenManifest = rewriteImportedVideoManifest(
        manifest.stage.videoManifest,
        mappings,
      );
      const rewrittenVideo = rewrittenSlide.elements[0] as {
        src: unknown;
        mediaRef?: unknown;
        poster?: unknown;
      };

      expect(typeof rewrittenVideo.src).toBe('string');
      const rewrittenSrc = rewrittenVideo.src as string;
      expect(rewrittenSrc).toBe(mappings.refToNewId.get(videoRef));
      expect(rewrittenVideo.mediaRef).toBe(mappings.refToNewId.get(videoRef));
      expect(rewrittenVideo.poster).toBe(mappings.posterRefToNewId.get(indexedPosterRef));
      expect(mappings.posterByMediaRef.get(videoRef)).toBe(rewrittenVideo.poster);
      expect(Object.keys(rewrittenManifest ?? {})).toEqual([rewrittenSrc]);
      expect(await poolText(rewrittenSrc)).toBe(`video-${adversarialRef}`);
      expect(await poolText(rewrittenVideo.poster as string)).toBe(`poster-${adversarialRef}`);

      const posterZip = new JSZip();
      const safeVideoRef = `safe-video-${adversarialRef}`;
      const safeVideoPath = `media/${safeVideoRef}.mp4`;
      const adversarialPosterPath = `media/${adversarialRef}.jpg`;
      posterZip.file(safeVideoPath, `safe-video-${adversarialRef}`);
      posterZip.file(safeVideoPath.replace(/\.mp4$/, '.poster.jpg'), `sibling-${adversarialRef}`);
      posterZip.file(adversarialPosterPath, `adversarial-poster-${adversarialRef}`);
      const posterSlide = {
        id: `poster-slide-${adversarialRef}`,
        elements: [
          {
            id: `poster-video-${adversarialRef}`,
            type: 'video',
            src: safeVideoRef,
            mediaRef: safeVideoRef,
            poster: adversarialRef,
          },
        ],
      } as unknown as Slide;
      const posterManifest = {
        ...manifest,
        stage: { ...manifest.stage, videoManifest: undefined },
        scenes: [
          {
            type: 'slide',
            title: 'Poster scene',
            order: 0,
            content: { type: 'slide', canvas: posterSlide },
          },
        ],
        mediaIndex: Object.fromEntries([
          [safeVideoPath, { type: 'generated', mimeType: 'video/mp4' }],
          [adversarialPosterPath, { type: 'generated', mimeType: 'image/jpeg' }],
        ]),
      } satisfies ClassroomManifest;
      const posterMappings = await materializeImportedMedia(
        posterZip,
        posterManifest,
        'poster-stage',
        3,
      );
      const rewrittenPosterVideo = rewriteImportedSlideMediaRefs(posterSlide, posterMappings)
        .elements[0] as { poster?: unknown };

      expect(rewrittenPosterVideo.poster).toBe(posterMappings.refToNewId.get(adversarialRef));
      expect(rewrittenPosterVideo.poster).toBe(posterMappings.posterRefToNewId.get(adversarialRef));
      expect(typeof rewrittenPosterVideo.poster).toBe('string');
      expect(await poolText(rewrittenPosterVideo.poster as string)).toBe(
        `adversarial-poster-${adversarialRef}`,
      );
    },
  );

  it('rejects non-string alias values before they reach imported media slots', () => {
    const invalidMappings = {
      refToNewId: new Map<string, unknown>([['source-image', { polluted: true }]]),
      posterRefToNewId: new Map<string, unknown>(),
      posterByMediaRef: new Map<string, unknown>(),
    } as unknown as Parameters<typeof rewriteImportedSlideMediaRefs>[1];

    const rewritten = rewriteImportedSlideMediaRefs(
      {
        id: 'invalid-alias',
        elements: [{ id: 'image', type: 'image', src: 'source-image' }],
      } as unknown as Slide,
      invalidMappings,
    );

    expect(rewritten.elements[0]).toMatchObject({ src: '' });
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
        refToNewId: new Map([['source-image', 'ast_new_image']]),
        posterRefToNewId: new Map(),
        posterByMediaRef: new Map(),
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
          refToNewId: new Map(),
          posterRefToNewId: new Map(),
          posterByMediaRef: new Map(),
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
        { refToNewId: new Map(), posterRefToNewId: new Map(), posterByMediaRef: new Map() },
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
        refToNewId: new Map([
          ['source-video', 'ast_new_video'],
          ['source-poster', 'ast_new_poster'],
        ]),
        posterRefToNewId: new Map(),
        posterByMediaRef: new Map(),
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
          refToNewId: new Map(Object.entries(mapping)),
          posterRefToNewId: new Map(),
          posterByMediaRef: new Map(),
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

    expect(mappings.pathToId.get(missingPath)).toBeUndefined();
    expect(mappings.pathToId.get(presentPath)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(put).not.toHaveBeenCalled();
    expect(allocations).toEqual([mappings.pathToId.get(presentPath)]);
    expect(mocks.audioPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mappings.pathToId.get(presentPath),
        stageId: 'imported-stage',
      }),
    );
  });

  it.each([
    ['short ref first', ['audio/foo.mp3', 'audio/audio/foo.mp3.mp3']],
    ['nested ref first', ['audio/audio/foo.mp3.mp3', 'audio/foo.mp3']],
  ])('keeps ZIP paths and source refs in separate audio namespaces: %s', async (_case, paths) => {
    const zip = new JSZip();
    zip.file('audio/foo.mp3', 'short-ref-bytes');
    zip.file('audio/audio/foo.mp3.mp3', 'nested-ref-bytes');
    const mediaIndex = Object.fromEntries(
      paths.map((path) => [
        path,
        {
          type: 'audio' as const,
          format: 'mp3',
          sourceRef: path === 'audio/foo.mp3' ? 'foo' : 'audio/foo.mp3',
        },
      ]),
    );
    const manifest = {
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [],
      mediaIndex,
    } as unknown as ClassroomManifest;

    const mappings = await materializeImportedAudio(zip, manifest, 'imported-stage', 2);

    expect(await poolText(mappings.pathToId.get('audio/foo.mp3')!)).toBe('short-ref-bytes');
    expect(await poolText(mappings.pathToId.get('audio/audio/foo.mp3.mp3')!)).toBe(
      'nested-ref-bytes',
    );
    expect(mappings.sourceRefToId.get('foo')).toBe(mappings.pathToId.get('audio/foo.mp3'));
    expect(mappings.sourceRefToId.get('audio/foo.mp3')).toBe(
      mappings.pathToId.get('audio/audio/foo.mp3.mp3'),
    );
  });

  it.each([
    ['lexical path first', ['audio/a.mp3', 'audio/z.mp3']],
    ['lexical path last', ['audio/z.mp3', 'audio/a.mp3']],
  ])(
    'resolves duplicate audio source refs by ZIP path deterministically: %s',
    async (_case, paths) => {
      const zip = new JSZip();
      zip.file('audio/a.mp3', 'lexical-winner');
      zip.file('audio/z.mp3', 'later-path');
      const manifest = {
        formatVersion: 1,
        exportedAt: new Date(0).toISOString(),
        appVersion: 'test',
        stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
        agents: [],
        scenes: [],
        mediaIndex: Object.fromEntries(
          paths.map((path) => [path, { type: 'audio', format: 'mp3', sourceRef: 'duplicate' }]),
        ),
      } as unknown as ClassroomManifest;

      const mappings = await materializeImportedAudio(zip, manifest, 'imported-stage', 2);

      expect(mappings.sourceRefToId.get('duplicate')).toBe(mappings.pathToId.get('audio/a.mp3'));
      expect(await poolText(mappings.sourceRefToId.get('duplicate')!)).toBe('lexical-winner');
    },
  );

  it('maps prototype-named aliases as strings without crossing path and source namespaces', async () => {
    const zip = new JSZip();
    const cases = [
      ['audio/proto.mp3', '__proto__', 'proto-bytes'],
      ['audio/ctor.mp3', 'constructor', 'constructor-bytes'],
      ['audio/collision.mp3', 'audio/proto.mp3', 'collision-bytes'],
    ] as const;
    for (const [path, , bytes] of cases) zip.file(path, bytes);
    const manifest = {
      formatVersion: 1,
      exportedAt: new Date(0).toISOString(),
      appVersion: 'test',
      stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
      agents: [],
      scenes: [],
      mediaIndex: Object.fromEntries(
        cases.map(([path, sourceRef]) => [path, { type: 'audio', format: 'mp3', sourceRef }]),
      ),
    } as unknown as ClassroomManifest;

    const mappings = await materializeImportedAudio(zip, manifest, 'imported-stage', 2);

    for (const [path, sourceRef, bytes] of cases) {
      const pathId = mappings.pathToId.get(path);
      const sourceId = mappings.sourceRefToId.get(sourceRef);
      expect(typeof pathId).toBe('string');
      expect(typeof sourceId).toBe('string');
      expect(sourceId).toBe(pathId);
      expect(await poolText(sourceId!)).toBe(bytes);
    }
    expect(mappings.sourceRefToId.get('audio/proto.mp3')).not.toBe(
      mappings.pathToId.get('audio/proto.mp3'),
    );
  });

  it.each([
    ['forward', ['audio/z.mp3', 'audio/ä.mp3', 'audio/Ω.mp3']],
    ['reverse', ['audio/Ω.mp3', 'audio/ä.mp3', 'audio/z.mp3']],
  ])(
    'uses locale-independent code-unit order for a three-way source alias: %s',
    async (_case, paths) => {
      const zip = new JSZip();
      zip.file('audio/z.mp3', 'code-unit-winner');
      zip.file('audio/ä.mp3', 'latin-diacritic');
      zip.file('audio/Ω.mp3', 'greek');
      const manifest = {
        formatVersion: 1,
        exportedAt: new Date(0).toISOString(),
        appVersion: 'test',
        stage: { name: 'Imported', createdAt: 1, updatedAt: 1 },
        agents: [],
        scenes: [],
        mediaIndex: Object.fromEntries(
          paths.map((path) => [path, { type: 'audio', format: 'mp3', sourceRef: 'duplicate' }]),
        ),
      } as unknown as ClassroomManifest;

      const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
        throw new Error('host locale must not participate in alias ordering');
      });
      const mappings = await materializeImportedAudio(zip, manifest, 'imported-stage', 2).finally(
        () => localeCompare.mockRestore(),
      );
      const winner = mappings.sourceRefToId.get('duplicate');

      expect(winner).toBe(mappings.pathToId.get('audio/z.mp3'));
      expect(await poolText(winner!)).toBe('code-unit-winner');
    },
  );

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
