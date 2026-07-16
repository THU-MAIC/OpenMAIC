import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the renderer snapshot so the frame path is testable in plain Node (the
 * real `@openmaic/renderer/snapshot` needs a build + DOM). `slideToPng` records
 * the slide it was handed so tests can assert which media the frame captured.
 */
const capturedSlides: Array<{ elements: Array<Record<string, unknown>> }> = [];
vi.mock('@openmaic/renderer/snapshot', () => ({
  slideToPng: vi.fn(async (slide: { elements: Array<Record<string, unknown>> }) => {
    capturedSlides.push(structuredClone(slide));
    return new Blob(['png'], { type: 'image/png' });
  }),
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
});

/** Stub URL object-URL lifecycle (absent in Node) so frame tests can run. */
function stubObjectUrls() {
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:mock/${++objectUrlSeq}`,
    revokeObjectURL: (url: string) => revoked.push(url),
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
});

describe('collectVideoAssets — frame base restores evicted generated media', () => {
  const frameEntry = {
    assetId: 'frame:s1',
    kind: 'frame' as const,
    path: 'frames/s1.png',
    present: true,
  };

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

  it('clears an image whose blob is evicted and has no ossKey', async () => {
    stubObjectUrls();
    const rec = imageRecord({ blob: new Blob([]) });

    await collectVideoAssets(
      irWith([frameEntry]),
      [slideScene({ type: 'image', src: 'gen_img_1' })],
      records({ mediaByElementId: new Map([['gen_img_1', rec]]) }),
    );

    expect(capturedSlides[0].elements[0].src).toBe('');
  });
});
