import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  mediaGet: vi.fn(),
  poolResolve: vi.fn(),
  poolRelease: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { get: mocks.mediaGet } },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: mocks.poolResolve, release: mocks.poolRelease }),
}));

import {
  assertPptxMediaReferenceParity,
  buildPptxBlob,
  derivePptxMediaReferenceSet,
  isPptxManifestForeignRef,
} from '@/lib/export/use-export-pptx';
import { lookupMediaTask } from '@/lib/media/media-task-resolution';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));

function baseSlide(element: Record<string, unknown>): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [element],
  } as unknown as Slide;
}

function sceneFor(slide: Slide): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: { type: 'slide', canvas: slide },
  } as Scene;
}

async function pptxMediaBytes(blob: Blob): Promise<Uint8Array[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return Promise.all(
    Object.values(zip.files)
      .filter((entry) => !entry.dir && entry.name.startsWith('ppt/media/'))
      .map((entry) => entry.async('uint8array')),
  );
}

describe('PPTX media fallback chains', () => {
  beforeEach(() => {
    mocks.mediaGet.mockReset().mockResolvedValue(undefined);
    mocks.poolResolve.mockReset().mockResolvedValue(null);
    mocks.poolRelease.mockReset().mockResolvedValue(undefined);
    useMediaGenerationStore.setState({ tasks: {} });
    vi.stubGlobal(
      'FileReader',
      class TestFileReader {
        result: string | null = null;
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL(blob: Blob) {
          void blob.arrayBuffer().then(
            (bytes) => {
              this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`;
              this.onloadend?.();
            },
            () => this.onerror?.(),
          );
        }
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('derives the complete layout media set from the manifest with exact walker parity', () => {
    const slide = {
      ...baseSlide({}),
      background: { type: 'image', image: { src: 'background' } },
      elements: [
        { id: 'image', type: 'image', src: 'image' },
        {
          id: 'video',
          type: 'video',
          src: 'video-src',
          mediaRef: 'video-ref',
          poster: 'poster',
        },
        { id: 'audio', type: 'audio', src: 'audio' },
      ],
    } as unknown as Slide;

    const manifestRefs = derivePptxMediaReferenceSet([slide]);

    expect([...manifestRefs]).toEqual([
      'background',
      'image',
      'video-src',
      'video-ref',
      'poster',
      'audio',
    ]);
    expect(() => assertPptxMediaReferenceParity([slide], manifestRefs)).not.toThrow();
    expect(() =>
      assertPptxMediaReferenceParity([slide], new Set([...manifestRefs, 'manifest-only'])),
    ).toThrow(/manifest-only/);
  });

  it.each(['__proto__', 'constructor'])(
    'uses only an own task for the adversarial media ref %s',
    (ref) => {
      expect(lookupMediaTask({}, ref)).toBeUndefined();
      const task = {
        elementId: ref,
        type: 'image',
        status: 'done',
        prompt: ref,
        params: {},
        retryCount: 0,
        stageId: 'stage-1',
      } as const;
      useMediaGenerationStore.setState({ tasks: Object.fromEntries([[ref, task]]) });

      expect(lookupMediaTask(useMediaGenerationStore.getState().tasks, ref, 'stage-1')).toBe(task);
    },
  );

  it.each(['__proto__', 'constructor'])(
    'embeds task URL bytes for a re-keyed adversarial placeholder ref %s',
    async (ref) => {
      const taskUrl = `https://task.test/${encodeURIComponent(ref)}.png`;
      const fetchSpy = vi.fn(async (url: string) =>
        url === taskUrl
          ? new Response(new Blob([PNG_BYTES], { type: 'image/png' }))
          : new Response(null, { status: 404 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      useMediaGenerationStore.setState({
        tasks: {
          [`ast_rekeyed_${ref}`]: {
            elementId: `ast_rekeyed_${ref}`,
            placeholderRef: ref,
            objectUrl: taskUrl,
            type: 'image',
            status: 'done',
            prompt: ref,
            params: {},
            retryCount: 0,
            stageId: 'stage-1',
          },
        },
      });
      const slide = baseSlide({
        id: 'image-1',
        type: 'image',
        src: ref,
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        fixedRatio: true,
      });

      const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
      const media = await pptxMediaBytes(blob);

      expect(mocks.poolResolve).toHaveBeenCalledWith(ref);
      expect(mocks.mediaGet).toHaveBeenCalledWith(`stage-1:${ref}`);
      expect(fetchSpy).toHaveBeenCalledWith(taskUrl);
      expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(PNG_BYTES)))).toBe(true);
    },
  );

  it('embeds a concrete video src when its opaque mediaRef cannot be resolved', async () => {
    const videoBytes = new TextEncoder().encode('direct-video-bytes');
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === 'https://cdn.example/video.mp4') {
        return new Response(new Blob([videoBytes], { type: 'video/mp4' }));
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const slide = baseSlide({
      id: 'video-1',
      type: 'video',
      src: 'https://cdn.example/video.mp4',
      mediaRef: 'ast_missing',
      left: 0,
      top: 0,
      width: 640,
      height: 360,
      rotate: 0,
    });

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const media = await pptxMediaBytes(blob);

    expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example/video.mp4');
    expect(mocks.mediaGet).not.toHaveBeenCalledWith('stage-1:ast_missing');
    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(videoBytes)))).toBe(true);
  });

  it('embeds an allocated generated poster from its own Dexie row', async () => {
    mocks.mediaGet.mockImplementation(async (key: string) => {
      if (key === 'stage-1:ast_video') {
        return {
          id: key,
          stageId: 'stage-1',
          type: 'video',
          blob: new Blob(['video-bytes'], { type: 'video/mp4' }),
          mimeType: 'video/mp4',
          size: 11,
          prompt: 'Clip',
          params: '{}',
          createdAt: 1,
        };
      }
      if (key === 'stage-1:ast_poster') {
        return {
          id: key,
          stageId: 'stage-1',
          type: 'image',
          blob: new Blob([PNG_BYTES], { type: 'image/png' }),
          mimeType: 'image/png',
          size: PNG_BYTES.byteLength,
          prompt: 'Poster',
          params: '{}',
          createdAt: 1,
        };
      }
      return undefined;
    });
    const slide = baseSlide({
      id: 'video-1',
      type: 'video',
      src: 'ast_video',
      mediaRef: 'ast_video',
      poster: 'ast_poster',
      left: 0,
      top: 0,
      width: 640,
      height: 360,
      rotate: 0,
    });

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const media = await pptxMediaBytes(blob);

    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(PNG_BYTES)))).toBe(true);
    expect(mocks.mediaGet).toHaveBeenCalledWith('stage-1:ast_poster');
  });

  it('embeds a task-provided poster when the video element has no explicit poster', async () => {
    const videoUrl = 'https://cdn.example/task-video.mp4';
    const posterUrl = 'https://cdn.example/task-poster.jpg';
    const videoBytes = new TextEncoder().encode('task-video-bytes');
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.startsWith('data:')) {
        const [meta, b64] = url.slice(5).split(',');
        return new Response(new Blob([Buffer.from(b64, 'base64')], { type: meta.split(';')[0] }));
      }
      if (url === videoUrl) return new Response(new Blob([videoBytes], { type: 'video/mp4' }));
      if (url === posterUrl) return new Response(new Blob([PNG_BYTES], { type: 'image/jpeg' }));
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    useMediaGenerationStore.setState({
      tasks: {
        ast_video_task: {
          elementId: 'ast_video_task',
          placeholderRef: 'gen_vid_1',
          objectUrl: videoUrl,
          poster: posterUrl,
          type: 'video',
          status: 'done',
          prompt: 'Clip',
          params: {},
          retryCount: 0,
          stageId: 'stage-1',
        },
      },
    });
    const slide = baseSlide({
      id: 'video-1',
      type: 'video',
      src: 'gen_vid_1',
      mediaRef: 'gen_vid_1',
      left: 0,
      top: 0,
      width: 640,
      height: 360,
      rotate: 0,
    });

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const media = await pptxMediaBytes(blob);

    // The runtime poster fallback reaches the export: the task-owned poster URL
    // is fetched (not rejected by the manifest guard) and embedded as the cover.
    expect(fetchSpy).toHaveBeenCalledWith(posterUrl);
    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(videoBytes)))).toBe(true);
    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(PNG_BYTES)))).toBe(true);
  });

  it('still rejects a genuinely unrelated poster URL that no task owns', () => {
    // The guard's task-ownership exemption is narrow: it admits exactly the
    // URL the bound task owns. A genuinely foreign URL — neither a document
    // ref nor the task's own objectUrl — must still be rejected, so the fix
    // cannot grow into a blanket runtime-URL bypass.
    const slide = baseSlide({
      id: 'video-1',
      type: 'video',
      src: 'gen_vid_1',
      mediaRef: 'gen_vid_1',
      left: 0,
      top: 0,
      width: 640,
      height: 360,
      rotate: 0,
    });
    const manifestRefs = derivePptxMediaReferenceSet([slide]);
    const unrelatedPoster = 'https://unrelated.example/poster.jpg';
    const videoUrl = 'https://cdn.example/task-video.mp4';

    // Rejected: not a document ref, and the task owns only the video URL.
    expect(isPptxManifestForeignRef(unrelatedPoster, manifestRefs, undefined)).toBe(true);
    expect(
      isPptxManifestForeignRef(unrelatedPoster, manifestRefs, {
        status: 'done',
        objectUrl: videoUrl,
        retryCount: 0,
      }),
    ).toBe(true);

    // Admitted: the task-owned poster URL (the fix's exemption) and document refs.
    expect(
      isPptxManifestForeignRef(unrelatedPoster, manifestRefs, {
        status: 'done',
        objectUrl: unrelatedPoster,
        retryCount: 0,
      }),
    ).toBe(false);
    expect(isPptxManifestForeignRef('gen_vid_1', manifestRefs, undefined)).toBe(false);
  });

  it('embeds an allocated slide background from its Dexie row', async () => {
    mocks.mediaGet.mockImplementation(async (key: string) =>
      key === 'stage-1:ast_background'
        ? {
            id: key,
            stageId: 'stage-1',
            type: 'image',
            blob: new Blob([PNG_BYTES], { type: 'image/png' }),
            mimeType: 'image/png',
            size: PNG_BYTES.byteLength,
            prompt: 'Background',
            params: '{}',
            createdAt: 1,
          }
        : undefined,
    );
    const slide = {
      ...baseSlide({}),
      background: { type: 'image', image: { src: 'ast_background', size: 'cover' } },
      elements: [],
    } as Slide;

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const media = await pptxMediaBytes(blob);

    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(PNG_BYTES)))).toBe(true);
    expect(mocks.mediaGet).toHaveBeenCalledWith('stage-1:ast_background');
  });

  it('prefers replaced pool bytes over a stale compatibility row', async () => {
    const staleBytes = new TextEncoder().encode('dexie-old');
    mocks.mediaGet.mockResolvedValue({
      id: 'stage-1:ast_retried_background',
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob([staleBytes], { type: 'image/png' }),
      mimeType: 'image/png',
      size: staleBytes.byteLength,
      prompt: 'Background',
      params: '{}',
      createdAt: 1,
    });
    mocks.poolResolve.mockResolvedValue('https://pool.test/retried-background');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([PNG_BYTES], { type: 'image/png' }))),
    );
    useMediaGenerationStore.setState({
      tasks: {
        ast_retried_background: {
          elementId: 'ast_retried_background',
          type: 'image',
          status: 'failed',
          prompt: 'Background',
          params: {},
          error: 'Compatibility write failed',
          errorCode: 'MEDIA_COMPATIBILITY_STORE_LAGGED',
          retryCount: 1,
          stageId: 'stage-1',
        },
      },
    });
    const slide = {
      ...baseSlide({}),
      background: {
        type: 'image',
        image: { src: 'ast_retried_background', size: 'cover' },
      },
      elements: [],
    } as Slide;

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const media = await pptxMediaBytes(blob);

    expect(mocks.poolResolve).toHaveBeenCalledWith('ast_retried_background');
    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(PNG_BYTES)))).toBe(true);
    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(staleBytes)))).toBe(false);
  });

  it('falls back to the original image fetch when task, Dexie, and pool all miss', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === 'logo.png') {
        return new Response(new Blob([PNG_BYTES], { type: 'image/png' }));
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const slide = baseSlide({
      id: 'image-1',
      type: 'image',
      src: 'logo.png',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
    });

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const media = await pptxMediaBytes(blob);

    expect(fetchSpy).toHaveBeenCalledWith('logo.png');
    expect(media.some((bytes) => Buffer.from(bytes).equals(Buffer.from(PNG_BYTES)))).toBe(true);
  });
});
