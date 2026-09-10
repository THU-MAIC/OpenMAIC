import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the elementId → mediaRef bridge in the app-side compiler deps.
 *
 * A `play_video` action targets a slide element by its `.id` (e.g. `video_abc`),
 * but generated-media records are keyed by the element's media ref (`gen_vid_…`).
 * Without the bridge, `assets.media()` / `timing.videoDurationMs()` miss for every
 * generated video, which cascades to a dropped clip in the export (regression the
 * user reported as "视频元素丢失"). These tests mock Dexie (no Dexie-in-node
 * harness, per the repo pattern) and run the real factory.
 */
const mediaRows = new Map<string, MediaFileRecord>();
const mediaGet = vi.fn((id: string) => Promise.resolve(mediaRows.get(id)));
const audioGet = vi.fn<(id: string) => Promise<unknown>>((_id) => Promise.resolve(undefined));
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: { get: (id: string) => audioGet(id) },
    mediaFiles: {
      get: (...args: [string]) => mediaGet(...args),
    },
  },
}));

// Stub the off-screen geometry measurement (needs a real browser/layout). It
// records the calls so tests can assert which elements were measured, and
// returns a canned content-box geometry.
const measureCalls: Array<{ elementIds: string[] }> = [];
vi.mock('@openmaic/renderer/snapshot', () => ({
  measureSlideElementGeometry: vi.fn(async (_slide: unknown, elementIds: string[]) => {
    measureCalls.push({ elementIds: [...elementIds] });
    return new Map(
      elementIds.map((id) => [id, { x: 11, y: 19, w: 18, h: 25, centerX: 20, centerY: 31.5 }]),
    );
  }),
}));

// The proxy-mediated URL fetch and the pool read are module-level seams; the
// legacy-URL fallback tests drive them directly.
const fetchMediaUrlMock = vi.fn();
vi.mock('@/lib/media/fetch-media-url', () => ({
  fetchMediaUrl: (...args: unknown[]) => fetchMediaUrlMock(...args),
}));
const resolveAudioBlobMock = vi.fn<(id: string) => Promise<Blob | null>>((_id) =>
  Promise.resolve(null),
);
vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: (id: string) => resolveAudioBlobMock(id),
}));

import { createVideoTimelineDeps } from '@/lib/video-export-app/timeline-deps';
import { collectVideoAssets } from '@/lib/video-export-app/collect';
import { compileVideoTimeline } from '@/lib/video-export';
import { resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import type { MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';

const STAGE_ID = 'stage-1';
const MEDIA_REF = 'gen_vid_abc123';
const ELEMENT_ID = 'video_element_1';

/** A media record present via ossKey (no local bytes → no DOM probe in Node). */
function videoRecord(over: Partial<MediaFileRecord> = {}): MediaFileRecord {
  return {
    id: `${STAGE_ID}:${MEDIA_REF}`,
    stageId: STAGE_ID,
    type: 'video',
    blob: new Blob([], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    ossKey: 'https://cdn.example/v.mp4',
    size: 0,
    prompt: '',
    params: '',
    createdAt: 0,
    ...over,
  } as MediaFileRecord;
}

/** A media record for an arbitrary ref (id is `stageId:ref`). */
function videoRecordFor(ref: string, over: Partial<MediaFileRecord> = {}): MediaFileRecord {
  return videoRecord({ id: `${STAGE_ID}:${ref}`, ...over });
}

/** A slide scene whose element points at the media ref via `mediaRef`. */
function slideScene(el: Record<string, unknown>, actions: unknown[] = []): Scene {
  return {
    id: 'scene-1',
    stageId: STAGE_ID,
    title: 'Scene',
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [el] } },
    actions,
  } as unknown as Scene;
}

/** A slide scene with an explicit id, one element, and optional actions. */
function slideSceneWithId(
  sceneId: string,
  el: Record<string, unknown>,
  actions: unknown[] = [],
): Scene {
  return {
    id: sceneId,
    stageId: STAGE_ID,
    title: sceneId,
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [el] } },
    actions,
  } as unknown as Scene;
}

const spotlight = (elementId: string) => ({ type: 'spotlight', elementId });

/** Seed the mocked media table; rows are keyed by their compound id. */
function seedMedia(...records: MediaFileRecord[]) {
  for (const record of records) mediaRows.set(record.id, record);
}

beforeEach(() => {
  mediaRows.clear();
  mediaGet.mockClear();
  audioGet.mockReset().mockImplementation(() => Promise.resolve(undefined));
  measureCalls.length = 0;
  fetchMediaUrlMock.mockReset();
  resolveAudioBlobMock.mockReset().mockImplementation(() => Promise.resolve(null));
  useMediaGenerationStore.setState({ tasks: {} });
});

/** A fake `<audio>` element whose metadata reports the given duration. */
function fakeAudioElement(durationSec: number) {
  const el = {
    preload: '',
    duration: durationSec,
    onloadedmetadata: null as (() => void) | null,
    onerror: null as (() => void) | null,
    removeAttribute: (_name: string) => undefined,
  };
  Object.defineProperty(el, 'src', {
    set(_value: string) {
      queueMicrotask(() => el.onloadedmetadata?.());
    },
  });
  return el;
}

describe('createVideoTimelineDeps — legacy URL audio fallback', () => {
  it('ignores slide-audio elements while still loading speech narration', async () => {
    const slideAudioId = 'ast_slide_audio';
    const speechAudioId = 'ast_speech_audio';
    resolveAudioBlobMock.mockImplementation(async (id: string) =>
      id === speechAudioId ? new Blob(['speech'], { type: 'audio/mpeg' }) : null,
    );
    audioGet.mockImplementation(async (id: string) =>
      id === speechAudioId
        ? { id, blob: new Blob(['speech'], { type: 'audio/mpeg' }), format: 'mp3', createdAt: 0 }
        : undefined,
    );
    vi.stubGlobal('document', { createElement: () => fakeAudioElement(1.25) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const speech = { id: 'speech', type: 'speech', text: 'Hello', audioId: speechAudioId };
    const scene = slideScene({ id: 'slide-audio', type: 'audio', src: slideAudioId }, [speech]);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });

    expect(resolveAudioBlobMock).toHaveBeenCalledTimes(1);
    expect(resolveAudioBlobMock).toHaveBeenCalledWith(speechAudioId);
    expect(audioGet).toHaveBeenCalledTimes(1);
    expect(audioGet).toHaveBeenCalledWith(speechAudioId);
    expect(deps.assets.audio(speech as never)?.present).toBe(true);
    expect(deps.timing.audioDurationMs(speech as never)).toBe(1250);

    vi.unstubAllGlobals();
  });

  it('loads and probes narration in speech order when the manifest sees slide audio first', async () => {
    const audioA = new Blob(['speech-a'], { type: 'audio/mpeg' });
    const audioB = new Blob(['speech-b'], { type: 'audio/mpeg' });
    const blobs = new Map([
      ['ast_speech_a', audioA],
      ['ast_speech_b', audioB],
    ]);
    const probeOrder: string[] = [];
    audioGet.mockImplementation(async (id: string) => ({
      id,
      blob: blobs.get(id),
      format: 'mp3',
      createdAt: 0,
    }));
    resolveAudioBlobMock.mockImplementation(async (id: string) => blobs.get(id) ?? null);
    vi.stubGlobal('document', { createElement: () => fakeAudioElement(1) });
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      probeOrder.push(blob === audioA ? 'ast_speech_a' : 'ast_speech_b');
      return `blob:probe-${probeOrder.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const scene = slideScene({ id: 'slide-audio-b', type: 'audio', src: 'ast_speech_b' }, [
      { id: 'speech-a', type: 'speech', text: 'A', audioId: 'ast_speech_a' },
      { id: 'speech-b', type: 'speech', text: 'B', audioId: 'ast_speech_b' },
    ]);

    await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });

    expect(audioGet.mock.calls.map(([id]) => id)).toEqual(['ast_speech_a', 'ast_speech_b']);
    expect(resolveAudioBlobMock.mock.calls.map(([id]) => id)).toEqual([
      'ast_speech_a',
      'ast_speech_b',
    ]);
    expect(probeOrder).toEqual(['ast_speech_a', 'ast_speech_b']);

    vi.unstubAllGlobals();
  });

  it('ingests a dangling pair through its URL and surfaces a present, probed narration asset', async () => {
    const legacyUrl = 'https://server.example.com/audio/legacy.mp3';
    fetchMediaUrlMock.mockResolvedValue(
      new Response(new Blob(['narration'], { type: 'audio/mpeg' }), { status: 200 }),
    );
    // The duration probe needs a DOM audio element; this Node environment
    // gets a fake reporting 2.5s.
    vi.stubGlobal('document', { createElement: () => fakeAudioElement(2.5) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const action = {
      id: 'a1',
      type: 'speech',
      text: 'Hello',
      audioId: 'tts_dangling',
      audioUrl: legacyUrl,
    };
    const scene = slideScene({ id: 'text_1', type: 'text' }, [action]);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });

    expect(fetchMediaUrlMock).toHaveBeenCalledWith(legacyUrl, 15_000);
    const meta = deps.assets.audio(action as never);
    expect(meta?.present).toBe(true);
    expect(meta?.format).toBe('mpeg');
    expect(deps.timing.audioDurationMs(action as never)).toBe(2500);

    vi.unstubAllGlobals();
  });

  it('keeps a clip missing when the legacy URL will not fetch', async () => {
    const legacyUrl = 'https://server.example.com/audio/gone.mp3';
    fetchMediaUrlMock.mockResolvedValue(new Response(null, { status: 404 }));

    const action = { id: 'a1', type: 'speech', text: 'Hello', audioUrl: legacyUrl };
    const scene = slideScene({ id: 'text_1', type: 'text' }, [action]);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });

    expect(deps.assets.audio(action as never)).toBeNull();
  });

  it('retains an evicted speech row so collection reaches its CDN fallback', async () => {
    const audioId = 'ast_evicted_speech';
    const ossKey = 'https://cdn.example/evicted.mp3';
    const action = { id: 'a1', type: 'speech', text: 'Hello', audioId };
    const scene = slideScene({ id: 'text_1', type: 'text' }, [action]);
    const row = {
      id: audioId,
      blob: new Blob([], { type: 'audio/mpeg' }),
      format: 'mp3',
      duration: 3.25,
      ossKey,
      createdAt: 0,
    };
    audioGet.mockResolvedValue(row);
    resolveAudioBlobMock.mockResolvedValue(null);
    const fetchSpy = vi.fn(
      async () => new Response(new Blob(['cdn-speech'], { type: 'audio/mpeg' })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    expect(deps.records.audioById.get(audioId)).toBe(row);
    expect(deps.assets.audio(action as never)).toMatchObject({ present: true, durationMs: 3250 });

    const result = await collectVideoAssets(
      {
        assets: {
          entries: [{ assetId: audioId, kind: 'audio', path: 'audio/evicted.mp3', present: true }],
        },
      } as never,
      [scene],
      deps.records,
    );
    expect(fetchSpy).toHaveBeenCalledWith(ossKey);
    expect(await result.blobs.get('audio/evicted.mp3')?.text()).toBe('cdn-speech');
    expect(result.missing).toEqual([]);
  });

  it('round-trips one opaque ref as speech audio and later video media', async () => {
    const sharedRef = 'ast_cross_kind';
    const speech = { id: 'speech', type: 'speech', text: 'Hello', audioId: sharedRef };
    const play = { id: 'play', type: 'play_video', elementId: 'video-1' };
    const audioScene = slideSceneWithId('audio-scene', { id: 'text', type: 'text' }, [speech]);
    const videoScene = slideSceneWithId(
      'video-scene',
      { id: 'video-1', type: 'video', mediaRef: sharedRef, autoplay: false },
      [play],
    );
    const audioRow = {
      id: sharedRef,
      blob: new Blob([], { type: 'audio/mpeg' }),
      format: 'mp3',
      duration: 1,
      ossKey: 'https://cdn.example/shared.mp3',
      createdAt: 0,
    };
    audioGet.mockResolvedValue(audioRow);
    resolveAudioBlobMock.mockResolvedValue(null);
    seedMedia(
      videoRecordFor(sharedRef, {
        blob: new Blob([], { type: 'video/mp4' }),
        ossKey: 'https://cdn.example/shared.mp4',
      }),
    );
    const fetchSpy = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('.mp3')
            ? new Blob(['speech-bytes'], { type: 'audio/mpeg' })
            : new Blob(['video-bytes'], { type: 'video/mp4' }),
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const scenes = [audioScene, videoScene];
    const deps = await createVideoTimelineDeps({
      stage: { id: STAGE_ID },
      scenes,
      skipGeometry: true,
    });
    expect(deps.records.audioById.has(sharedRef)).toBe(true);
    expect(deps.records.mediaByElementId.has(sharedRef)).toBe(true);

    const ir = compileVideoTimeline({ stage: { id: STAGE_ID, name: 'Cross kind' }, scenes }, deps);
    const result = await collectVideoAssets(ir, scenes, deps.records);
    expect([...result.blobs.values()].some((blob) => blob.type === 'audio/mpeg')).toBe(true);
    expect([...result.blobs.values()].some((blob) => blob.type === 'video/mp4')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example/shared.mp4');
  });
});

describe('createVideoTimelineDeps — media ref bridge', () => {
  it('resolves a play_video element id to its media record via mediaRef', async () => {
    seedMedia(videoRecord());
    const scene = slideScene({ id: ELEMENT_ID, type: 'video', mediaRef: MEDIA_REF });

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    const meta = deps.assets.media(ELEMENT_ID, scene);

    expect(meta).not.toBeNull();
    expect(meta?.id).toBe(`${STAGE_ID}:${MEDIA_REF}`);
    expect(meta?.present).toBe(true);
    expect(meta?.format).toBe('mp4');
  });

  it('bridges a legacy placeholder `src` (gen_vid_…) when no explicit mediaRef', async () => {
    seedMedia(videoRecord());
    const scene = slideScene({ id: ELEMENT_ID, type: 'video', src: MEDIA_REF });

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    expect(deps.assets.media(ELEMENT_ID, scene)?.id).toBe(`${STAGE_ID}:${MEDIA_REF}`);
  });

  it('returns null for an element with no generated media', async () => {
    seedMedia(videoRecord());
    const scene = slideScene({ id: 'plain_text', type: 'text' });

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    expect(deps.assets.media('plain_text', scene)).toBeNull();
  });

  it('plans a concrete src instead of a stale opaque mediaRef', async () => {
    const concreteSrc = 'https://cdn.example/direct.mp4';
    const element = {
      id: ELEMENT_ID,
      type: 'video',
      src: concreteSrc,
      mediaRef: 'ast_stale_video',
    };
    const action = { type: 'play_video', elementId: ELEMENT_ID };
    const scene = slideScene(element, [action]);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    const rendererRef = resolveVideoMediaForElement({}, element as never, STAGE_ID, [
      element as never,
    ]).sourceRef;

    expect(rendererRef).toBe(concreteSrc);
    expect(deps.assets.media(ELEMENT_ID, scene)).toMatchObject({
      id: rendererRef,
      present: true,
      format: 'mp4',
    });
  });

  it('scopes the bridge by scene: a shared element id resolves per-scene, not last-writer-wins', async () => {
    // Two slides reuse the slide-local element id `video_001`, each pointing at a
    // different generated video. A deck-wide bridge would collapse both to the
    // last scene's ref; the scene-scoped bridge must keep them distinct.
    const SHARED_ID = 'video_001';
    const REF_A = 'gen_vid_aaa';
    const REF_B = 'gen_vid_bbb';
    seedMedia(videoRecordFor(REF_A), videoRecordFor(REF_B));

    const play = (elementId: string) => ({ type: 'play_video', elementId });
    const sceneA = slideSceneWithId('scene-a', { id: SHARED_ID, type: 'video', mediaRef: REF_A }, [
      play(SHARED_ID),
    ]);
    const sceneB = slideSceneWithId('scene-b', { id: SHARED_ID, type: 'video', mediaRef: REF_B }, [
      play(SHARED_ID),
    ]);

    const deps = await createVideoTimelineDeps({
      stage: { id: STAGE_ID },
      scenes: [sceneA, sceneB],
    });

    expect(deps.assets.media(SHARED_ID, sceneA)?.id).toBe(`${STAGE_ID}:${REF_A}`);
    expect(deps.assets.media(SHARED_ID, sceneB)?.id).toBe(`${STAGE_ID}:${REF_B}`);
  });
});

describe('createVideoTimelineDeps — geometry probe', () => {
  it('pre-measures the content box of spotlight/laser/video targets and serves it', async () => {
    const scene = slideScene({ id: 'text_1', type: 'text' }, [spotlight('text_1')]);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });

    expect(measureCalls).toHaveLength(1);
    expect(measureCalls[0].elementIds).toContain('text_1');
    expect(deps.geometry.contentGeometry('text_1', scene)).toEqual({
      x: 11,
      y: 19,
      w: 18,
      h: 25,
      centerX: 20,
      centerY: 31.5,
    });
  });

  it('does not render a scene with no effect/video targets', async () => {
    const scene = slideScene({ id: 'text_1', type: 'text' }, []);

    const deps = await createVideoTimelineDeps({ stage: { id: STAGE_ID }, scenes: [scene] });
    expect(measureCalls).toHaveLength(0);
    expect(deps.geometry.contentGeometry('text_1', scene)).toBeNull();
  });
});
