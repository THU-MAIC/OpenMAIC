import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the renderer snapshot so the frame path is testable in plain Node (the
 * real `@openmaic/renderer/snapshot` needs a build + DOM). `slideToPng` records
 * the slide it was handed so tests can assert which media the frame captured.
 */
const capturedSlides: Array<{
  elements: Array<Record<string, unknown>>;
  background?: { type: string; image?: { src: string } };
}> = [];
const mediaOwnerMocks = vi.hoisted(() => ({
  withAssetUrl: vi.fn(async (_ref: string, fn: (url: string | null) => Promise<unknown>) =>
    fn(null),
  ),
}));
vi.mock('@openmaic/renderer/snapshot', () => ({
  slideToPng: vi.fn(
    async (slide: {
      elements: Array<Record<string, unknown>>;
      background?: { type: string; image?: { src: string } };
    }) => {
      capturedSlides.push(structuredClone(slide));
      return new Blob(['png'], { type: 'image/png' });
    },
  ),
}));
vi.mock('@/lib/media/use-asset-url', () => ({
  withAssetUrl: mediaOwnerMocks.withAssetUrl,
}));

import { collectVideoAssets } from '@/lib/video-export-app/collect';
import type { VideoTimeline } from '@/lib/video-export';
import type { VideoTimelineRecords } from '@/lib/video-export-app/timeline-deps';
import type { Scene } from '@/lib/types/stage';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';

/** Minimal IR carrying only an asset plan — collectVideoAssets reads `ir.assets.entries`. */
function irWith(entries: VideoTimeline['assets']['entries']): VideoTimeline {
  return { assets: { entries } } as unknown as VideoTimeline;
}

function audioRecord(over: Partial<AudioFileRecord>): AudioFileRecord {
  return {
    id: 'aud-1',
    blob: new Blob([], { type: 'audio/mpeg' }),
    format: 'mp3',
    createdAt: 0,
    ...over,
  };
}

function videoRecord(over: Partial<MediaFileRecord>): MediaFileRecord {
  return {
    id: 'stage:el-1',
    stageId: 'stage',
    type: 'video',
    blob: new Blob([], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    size: 0,
    prompt: '',
    params: '',
    createdAt: 0,
    ...over,
  };
}

function imageRecord(over: Partial<MediaFileRecord>): MediaFileRecord {
  return {
    id: 'stage:img-1',
    stageId: 'stage',
    type: 'image',
    blob: new Blob([], { type: 'image/png' }),
    mimeType: 'image/png',
    size: 0,
    prompt: '',
    params: '',
    createdAt: 0,
    ...over,
  };
}

function records(over: Partial<VideoTimelineRecords> = {}): VideoTimelineRecords {
  return {
    audioById: new Map(),
    mediaByElementId: new Map(),
    videoDurationMsByElementId: new Map(),
    interactiveHtml: { html: () => null, content: () => undefined },
    ...over,
  };
}

/** A slide scene whose single element points at a generated-media placeholder. */
function slideScene(element: Record<string, unknown>): Scene {
  return {
    id: 's1',
    content: { type: 'slide', canvas: { elements: [element] } },
  } as unknown as Scene;
}

let objectUrlSeq = 0;
const revoked: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  capturedSlides.length = 0;
  revoked.length = 0;
  objectUrlSeq = 0;
  mediaOwnerMocks.withAssetUrl.mockReset().mockImplementation(async (_ref, fn) => fn(null));
});

/** Stub URL object-URL lifecycle (absent in Node) so frame tests can run. */
function stubObjectUrls() {
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:mock/${++objectUrlSeq}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  });
}

/**
 * Stub the first-frame decode path (`document.createElement('video'|'canvas')`)
 * used by `decodeFirstFramePosterUrl`. The fake <video> drives its load→seek
 * callbacks on the next microtask; the fake <canvas> yields `dataUrl` from
 * `toDataURL`, or — when `dataUrl` is null — throws to simulate a decode/CORS
 * failure so the caller's null-path is exercised. `URL.createObjectURL` (via
 * stubObjectUrls) then turns a produced data URL into a `blob:mock/*` poster.
 */
function stubFirstFrameDecode(dataUrl: string | null) {
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'video') {
        const v: Record<string, unknown> = {
          preload: '',
          muted: false,
          playsInline: false,
          videoWidth: 640,
          videoHeight: 360,
          readyState: 2,
          currentTime: 0,
          duration: 4,
          onloadeddata: null,
          onseeked: null,
          onerror: null,
          removeAttribute: () => {},
        };
        Object.defineProperty(v, 'src', {
          set() {
            queueMicrotask(() => {
              (v.onloadeddata as (() => void) | null)?.();
              // Setting currentTime (the nudge) triggers a seek in a real video.
              queueMicrotask(() => (v.onseeked as (() => void) | null)?.());
            });
          },
        });
        return v as unknown as HTMLElement;
      }
      // canvas
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => {
          if (dataUrl === null) throw new Error('tainted');
          return dataUrl;
        },
      } as unknown as HTMLElement;
    },
  });
}

describe('collectVideoAssets — ossKey fallback for evicted blobs', () => {
  it('uses the local audio blob when it has bytes (no fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const rec = audioRecord({ blob: new Blob(['x'], { type: 'audio/mpeg' }) });

    const { blobs, missing } = await collectVideoAssets(
      irWith([{ assetId: 'aud-1', kind: 'audio', path: 'audio/a.mp3', present: true }]),
      [],
      records({ audioById: new Map([['aud-1', rec]]) }),
    );

    expect(blobs.get('audio/a.mp3')).toBe(rec.blob);
    expect(missing).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches audio bytes from ossKey when the local blob was evicted', async () => {
    const fetched = new Blob(['remote'], { type: 'audio/mpeg' });
    const fetchSpy = vi.fn(async () => new Response(fetched));
    vi.stubGlobal('fetch', fetchSpy);
    const rec = audioRecord({ blob: new Blob([]), ossKey: 'https://cdn/a.mp3' });

    const { blobs, missing } = await collectVideoAssets(
      irWith([{ assetId: 'aud-1', kind: 'audio', path: 'audio/a.mp3', present: true }]),
      [],
      records({ audioById: new Map([['aud-1', rec]]) }),
    );

    expect(fetchSpy).toHaveBeenCalledWith('https://cdn/a.mp3');
    expect(await blobs.get('audio/a.mp3')?.text()).toBe('remote');
    expect(missing).toHaveLength(0);
  });

  it('reports missing when the blob is empty and there is no ossKey', async () => {
    const rec = audioRecord({ blob: new Blob([]) });
    const { blobs, missing } = await collectVideoAssets(
      irWith([{ assetId: 'aud-1', kind: 'audio', path: 'audio/a.mp3', present: true }]),
      [],
      records({ audioById: new Map([['aud-1', rec]]) }),
    );
    expect(blobs.has('audio/a.mp3')).toBe(false);
    expect(missing).toEqual(['audio/a.mp3']);
  });

  it('reports missing when the ossKey fetch fails', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const rec = audioRecord({ blob: new Blob([]), ossKey: 'https://cdn/gone.mp3' });

    const { missing } = await collectVideoAssets(
      irWith([{ assetId: 'aud-1', kind: 'audio', path: 'audio/a.mp3', present: true }]),
      [],
      records({ audioById: new Map([['aud-1', rec]]) }),
    );
    expect(missing).toEqual(['audio/a.mp3']);
  });

  it('reports missing when the ossKey fetch throws', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const rec = audioRecord({ blob: new Blob([]), ossKey: 'https://cdn/x.mp3' });

    const { missing } = await collectVideoAssets(
      irWith([{ assetId: 'aud-1', kind: 'audio', path: 'audio/a.mp3', present: true }]),
      [],
      records({ audioById: new Map([['aud-1', rec]]) }),
    );
    expect(missing).toEqual(['audio/a.mp3']);
  });

  it('fetches a video clip from ossKey and a poster from posterOssKey', async () => {
    const fetchSpy = vi.fn(async (url: string) => new Response(new Blob([url])));
    vi.stubGlobal('fetch', fetchSpy);
    const rec = videoRecord({
      blob: new Blob([]),
      ossKey: 'https://cdn/v.mp4',
      posterOssKey: 'https://cdn/v.jpg',
    });

    const { blobs, missing } = await collectVideoAssets(
      irWith([
        { assetId: 'stage:el-1', kind: 'video', path: 'media/v.mp4', present: true },
        { assetId: 'stage:el-1', kind: 'poster', path: 'media/v.jpg', present: true },
      ]),
      [],
      records({ mediaByElementId: new Map([['el-1', rec]]) }),
    );

    expect(await blobs.get('media/v.mp4')?.text()).toBe('https://cdn/v.mp4');
    expect(await blobs.get('media/v.jpg')?.text()).toBe('https://cdn/v.jpg');
    expect(missing).toHaveLength(0);
  });

  it('falls back to the original source fetch when generated-media lookup misses', async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url === 'logo.png'
        ? new Response(new Blob(['relative-image'], { type: 'image/png' }))
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { blobs, missing } = await collectVideoAssets(
      irWith([{ assetId: 'logo.png', kind: 'image', path: 'media/logo.png', present: true }]),
      [],
      records(),
    );

    expect(fetchSpy).toHaveBeenCalledWith('logo.png');
    expect(await blobs.get('media/logo.png')?.text()).toBe('relative-image');
    expect(missing).toHaveLength(0);
  });

  it('reads allocated image bytes through the shared pool-owner fallback', async () => {
    mediaOwnerMocks.withAssetUrl.mockImplementationOnce(async (_ref, fn) =>
      fn('https://pool.test/image'),
    );
    const fetchSpy = vi.fn(async (url: string) =>
      url === 'https://pool.test/image'
        ? new Response(new Blob(['pool-image'], { type: 'image/png' }))
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { blobs, missing } = await collectVideoAssets(
      irWith([{ assetId: 'ast_pool_image', kind: 'image', path: 'media/pool.png', present: true }]),
      [],
      records(),
    );

    expect(mediaOwnerMocks.withAssetUrl).toHaveBeenCalledWith(
      'ast_pool_image',
      expect.any(Function),
    );
    expect(await blobs.get('media/pool.png')?.text()).toBe('pool-image');
    expect(missing).toHaveLength(0);
  });

  it('prefers replaced pool bytes over a stale compatibility row', async () => {
    mediaOwnerMocks.withAssetUrl.mockImplementationOnce(async (_ref, fn) =>
      fn('https://pool.test/replaced-image'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['pool-new'], { type: 'image/png' }))),
    );
    const rec = imageRecord({
      id: 'stage:ast_retried_image',
      blob: new Blob(['dexie-old'], { type: 'image/png' }),
    });

    const { blobs, missing } = await collectVideoAssets(
      irWith([
        {
          assetId: 'stage:ast_retried_image',
          kind: 'image',
          path: 'media/retried.png',
          present: true,
        },
      ]),
      [],
      records({ mediaByElementId: new Map([['ast_retried_image', rec]]) }),
    );

    expect(mediaOwnerMocks.withAssetUrl).toHaveBeenCalledWith(
      'ast_retried_image',
      expect.any(Function),
    );
    expect(await blobs.get('media/retried.png')?.text()).toBe('pool-new');
    expect(missing).toHaveLength(0);
  });
});

describe('collectVideoAssets — frame base restores evicted generated media', () => {
  const frameEntry = {
    assetId: 'frame:s1',
    kind: 'frame' as const,
    path: 'frames/s1.png',
    present: true,
  };

  it('resolves and revokes an allocated image background before snapshotting', async () => {
    stubObjectUrls();
    const scene = slideScene({ type: 'text', content: 'Title' });
    if (scene.content.type !== 'slide') throw new Error('Expected slide scene');
    scene.content.canvas.background = {
      type: 'image',
      image: { src: 'ast_background', size: 'cover' },
    };
    const rec = imageRecord({
      id: 'stage:ast_background',
      blob: new Blob(['background'], { type: 'image/png' }),
    });

    await collectVideoAssets(
      irWith([frameEntry]),
      [scene],
      records({ mediaByElementId: new Map([['ast_background', rec]]) }),
    );

    expect(capturedSlides[0].background?.image?.src).toBe('blob:mock/1');
    expect(revoked).toEqual(['blob:mock/1']);
  });

  it('restores an evicted generated image via ossKey before snapshotting', async () => {
    const fetchSpy = vi.fn(async () => new Response(new Blob(['remote-img'])));
    vi.stubGlobal('fetch', fetchSpy);
    stubObjectUrls();
    // mediaByElementId is keyed by elementId (the `stageId:` prefix stripped).
    const rec = imageRecord({ blob: new Blob([]), ossKey: 'https://cdn/img.png' });

    const { blobs, missing } = await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'image', src: 'gen_img_1' })],
      records({ mediaByElementId: new Map([['gen_img_1', rec]]) }),
    );

    expect(fetchSpy).toHaveBeenCalledWith('https://cdn/img.png');
    // The snapshotted slide kept the media as an objectURL, not cleared to ''.
    expect(capturedSlides[0].elements[0].src).toMatch(/^blob:mock\//);
    expect(blobs.has('frames/s1.png')).toBe(true);
    expect(missing).toHaveLength(0);
    expect(revoked).toHaveLength(1); // objectURL released after the snapshot
  });

  it('restores an evicted generated video + poster via ossKey / posterOssKey', async () => {
    const fetchSpy = vi.fn(async (url: string) => new Response(new Blob([url])));
    vi.stubGlobal('fetch', fetchSpy);
    stubObjectUrls();
    const rec = videoRecord({
      id: 'stage:gen_vid_1',
      blob: new Blob([]),
      ossKey: 'https://cdn/v.mp4',
      posterOssKey: 'https://cdn/v.jpg',
    });

    await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'video', mediaRef: 'gen_vid_1' })],
      records({ mediaByElementId: new Map([['gen_vid_1', rec]]) }),
    );

    expect(fetchSpy).toHaveBeenCalledWith('https://cdn/v.mp4');
    expect(fetchSpy).toHaveBeenCalledWith('https://cdn/v.jpg');
    expect(capturedSlides[0].elements[0].src).toMatch(/^blob:mock\//);
    expect(capturedSlides[0].elements[0].poster).toMatch(/^blob:mock\//);
    expect(revoked).toHaveLength(2); // video + poster objectURLs both released
  });

  it('decodes a first-frame poster when a generated video has no stored poster', async () => {
    stubObjectUrls();
    stubFirstFrameDecode('data:image/png;base64,FIRSTFRAME');
    // A present video with bytes but NO poster / posterOssKey.
    const rec = videoRecord({
      id: 'stage:gen_vid_1',
      blob: new Blob(['video-bytes'], { type: 'video/mp4' }),
    });

    await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'video', mediaRef: 'gen_vid_1' })],
      records({ mediaByElementId: new Map([['gen_vid_1', rec]]) }),
    );

    // The snapshotted slide got a poster (the decoded first frame), not blank.
    expect(capturedSlides[0].elements[0].src).toMatch(/^blob:mock\//);
    expect(capturedSlides[0].elements[0].poster).toBe('data:image/png;base64,FIRSTFRAME');
  });

  it('leaves the video posterless (no throw) when first-frame decode fails', async () => {
    stubObjectUrls();
    stubFirstFrameDecode(null); // decode error / CORS-tainted → null
    const rec = videoRecord({
      id: 'stage:gen_vid_1',
      blob: new Blob(['video-bytes'], { type: 'video/mp4' }),
    });

    const { blobs } = await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'video', mediaRef: 'gen_vid_1' })],
      records({ mediaByElementId: new Map([['gen_vid_1', rec]]) }),
    );

    expect(capturedSlides[0].elements[0].src).toMatch(/^blob:mock\//);
    expect(capturedSlides[0].elements[0].poster).toBeUndefined();
    expect(blobs.has('frames/s1.png')).toBe(true); // frame still rendered
  });

  it('clears an image placeholder whose generated-media lookup misses', async () => {
    stubObjectUrls();
    const rec = imageRecord({ blob: new Blob([]) });

    await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'image', src: 'gen_img_1' })],
      records({ mediaByElementId: new Map([['gen_img_1', rec]]) }),
    );

    expect(capturedSlides[0].elements[0].src).toBe('');
  });

  it('resolves a poster through its original fetch fallback independently of video src', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === 'poster.jpg'
          ? new Response(new Blob(['poster'], { type: 'image/jpeg' }))
          : new Response(null, { status: 404 }),
      ),
    );
    stubObjectUrls();

    await collectVideoAssets(
      irWith([frameEntry]),
      [
        slideScene({
          type: 'video',
          src: 'https://example.test/video.mp4',
          poster: 'poster.jpg',
        }),
      ],
      records(),
    );

    expect(capturedSlides[0].elements[0]).toMatchObject({
      src: 'https://example.test/video.mp4',
      poster: expect.stringMatching(/^blob:mock\//),
    });
    expect(revoked).toHaveLength(1);
  });

  it('snapshots a concrete video src instead of a stale opaque mediaRef', async () => {
    const concreteSrc = 'https://cdn.example/direct.mp4';
    const fetchSpy = vi.fn(async (url: string) =>
      url === concreteSrc
        ? new Response(new Blob(['direct-video'], { type: 'video/mp4' }))
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    stubObjectUrls();
    stubFirstFrameDecode(null);

    await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'video', src: concreteSrc, mediaRef: 'ast_stale_video' })],
      records(),
    );

    expect(fetchSpy).toHaveBeenCalledWith(concreteSrc);
    expect(mediaOwnerMocks.withAssetUrl).not.toHaveBeenCalledWith(
      'ast_stale_video',
      expect.any(Function),
    );
    expect(capturedSlides[0].elements[0].src).toMatch(/^blob:mock\//);
  });
});

describe('collectVideoAssets — interactive HTML', () => {
  it('collects exact prepared HTML bytes for an html asset-plan entry', async () => {
    const prepared = '<!doctype html><h1>Frozen fixture</h1>';
    const { blobs, missing } = await collectVideoAssets(
      irWith([
        {
          assetId: 'interactive:s1',
          kind: 'html',
          path: 'interactive/001-fixture.html',
          present: true,
        },
      ]),
      [],
      records({
        interactiveHtml: {
          html: () => null,
          content: (assetId) => (assetId === 'interactive:s1' ? prepared : undefined),
        },
      }),
    );

    expect(await blobs.get('interactive/001-fixture.html')?.text()).toBe(prepared);
    expect(missing).toEqual([]);
  });
});
