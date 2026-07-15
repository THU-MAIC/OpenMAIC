import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectVideoAssets } from '@/lib/video-export-app/collect';
import type { VideoTimeline } from '@/lib/video-export';
import type { VideoTimelineRecords } from '@/lib/video-export-app/timeline-deps';
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

function records(over: Partial<VideoTimelineRecords> = {}): VideoTimelineRecords {
  return {
    audioById: new Map(),
    mediaByElementId: new Map(),
    videoDurationMsByElementId: new Map(),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
