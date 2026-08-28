import { afterEach, describe, expect, test, vi } from 'vitest';
import { replaceMediaPlaceholders } from '@/lib/server/classroom-media-generation';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

// The media pipeline writes generated files to disk; intercept the writes so
// the test never touches the worktree. Everything else (including the YAML
// provider-config read) delegates to the real fs.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function slideScene(
  elements: Array<{ id: string; type: string; src?: string; mediaRef?: string }>,
) {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas_1',
        elements,
      },
    },
  } as unknown as Scene;
}

describe('classroom media placeholder replacement', () => {
  test('preserves direct video src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'https://example.com/direct.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    const video = content.canvas.elements[0];
    expect(video.src).toBe('https://example.com/direct.mp4');
  });

  test('preserves an author-supplied non-URL src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'lesson-intro.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    expect(content.canvas.elements[0].src).toBe('lesson-intro.mp4');
  });

  test('does not treat an image placeholder as the video-manifest overwrite guard', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'gen_img_preview123',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    expect(content.canvas.elements[0].src).toBe('gen_img_preview123');
  });
});

describe('generateMediaForClassroom model fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('gracefully skips media when every configured provider is force-disabled', async () => {
    vi.stubEnv('IMAGE_SEEDREAM_API_KEY', 'sk-seedream');
    vi.stubEnv('IMAGE_SEEDREAM_ENABLED', 'false');
    vi.stubEnv('VIDEO_SEEDANCE_API_KEY', 'sk-seedance');
    vi.stubEnv('VIDEO_SEEDANCE_ENABLED', 'false');
    vi.resetModules();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');
    const outlines = [
      {
        id: 'outline_disabled',
        type: 'slide',
        title: 'Scene',
        description: 'd',
        order: 1,
        mediaGenerations: [
          { type: 'image', prompt: 'image', elementId: 'gen_img_disabled' },
          { type: 'video', prompt: 'video', elementId: 'gen_vid_disabled' },
        ],
      },
    ] as unknown as SceneOutline[];

    await expect(
      generateMediaForClassroom(outlines, 'cls-disabled', 'http://localhost'),
    ).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('falls back to the first catalog image model when the server pins no models', async () => {
    // Key-only managed provider (no IMAGE_SEEDREAM_MODELS pin): the resolver
    // yields no model, so the classroom path must fall back to the first
    // catalog model instead of reaching the adapter with an undefined model.
    vi.stubEnv('IMAGE_SEEDREAM_API_KEY', 'sk-seedream');
    vi.resetModules();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ url: 'https://cdn.example.com/x.png' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');

    const outlines = [
      {
        id: 'outline_1',
        type: 'slide',
        title: 'Scene 1',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'image', prompt: 'a cat', elementId: 'gen_img_1' }],
      },
    ] as unknown as SceneOutline[];

    const mediaMap = await generateMediaForClassroom(outlines, 'cls-fallback', 'http://localhost');

    expect(mediaMap['gen_img_1']).toBe(
      'http://localhost/api/classroom-media/cls-fallback/media/gen_img_1.png',
    );
    const genBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(genBody.model).toBe('doubao-seedream-5-0-260128');
  });

  test('uses the server-pinned model when IMAGE_<PREFIX>_MODELS is set', async () => {
    vi.stubEnv('IMAGE_SEEDREAM_API_KEY', 'sk-seedream');
    vi.stubEnv('IMAGE_SEEDREAM_MODELS', 'pinned-a');
    vi.resetModules();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ url: 'https://cdn.example.com/y.png' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');

    const outlines = [
      {
        id: 'outline_1',
        type: 'slide',
        title: 'Scene 1',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'image', prompt: 'a cat', elementId: 'gen_img_2' }],
      },
    ] as unknown as SceneOutline[];

    await generateMediaForClassroom(outlines, 'cls-pinned', 'http://localhost');

    const genBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(genBody.model).toBe('pinned-a');
  });

  test('falls back to the first catalog video model when the server pins no models', async () => {
    // Key-only managed provider (no VIDEO_SEEDANCE_MODELS pin): the resolver
    // yields no model, so the classroom path must fall back to the first
    // catalog model instead of reaching the adapter with an undefined model.
    vi.stubEnv('VIDEO_SEEDANCE_API_KEY', 'sk-seedance');
    vi.useFakeTimers();
    vi.resetModules();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'video-task-1' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'video-task-1',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example.com/video.mp4' },
          resolution: '720p',
          ratio: '16:9',
          duration: 5,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');

    const outlines = [
      {
        id: 'outline_1',
        type: 'slide',
        title: 'Scene 1',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'video', prompt: 'a cat running', elementId: 'gen_vid_1' }],
      },
    ] as unknown as SceneOutline[];

    const mediaMapPromise = generateMediaForClassroom(
      outlines,
      'cls-video-fallback',
      'http://localhost',
    );
    // Seedance submits a task then polls on a 5s interval; advance the fake
    // timers past the first poll so the mocked success response is consumed.
    await vi.advanceTimersByTimeAsync(5_000);
    const mediaMap = await mediaMapPromise;

    expect(mediaMap['gen_vid_1']).toBe(
      'http://localhost/api/classroom-media/cls-video-fallback/media/gen_vid_1.mp4',
    );
    const genBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(genBody.model).toBe('doubao-seedance-2-0-260128');
  });

  test('uses the server-pinned video model when VIDEO_<PREFIX>_MODELS is set', async () => {
    vi.stubEnv('VIDEO_SEEDANCE_API_KEY', 'sk-seedance');
    vi.stubEnv('VIDEO_SEEDANCE_MODELS', 'pinned-video-a');
    vi.useFakeTimers();
    vi.resetModules();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'video-task-2' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'video-task-2',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example.com/video.mp4' },
          resolution: '720p',
          ratio: '16:9',
          duration: 5,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');

    const outlines = [
      {
        id: 'outline_1',
        type: 'slide',
        title: 'Scene 1',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type: 'video', prompt: 'a cat running', elementId: 'gen_vid_2' }],
      },
    ] as unknown as SceneOutline[];

    const mediaMapPromise = generateMediaForClassroom(
      outlines,
      'cls-video-pinned',
      'http://localhost',
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const mediaMap = await mediaMapPromise;

    expect(mediaMap['gen_vid_2']).toBe(
      'http://localhost/api/classroom-media/cls-video-pinned/media/gen_vid_2.mp4',
    );
    const genBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(genBody.model).toBe('pinned-video-a');
  });
});
