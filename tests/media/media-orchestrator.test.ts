import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: mocks.mediaPut,
      delete: mocks.mediaDelete,
    },
  },
}));

import {
  generateMediaForOutlines,
  mediaRetryTarget,
  retryMediaTask,
} from '@/lib/media/media-orchestrator';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';

const stageId = 'classic-stage';
const imageRef = 'gen_img_classic';
const videoRef = 'gen_vid_classic';

function outlineWith(
  ...mediaGenerations: NonNullable<SceneOutline['mediaGenerations']>
): SceneOutline {
  return {
    id: 'outline-1',
    type: 'slide',
    title: 'Classic scene',
    description: 'Classic scene',
    keyPoints: ['media'],
    order: 1,
    mediaGenerations,
  };
}

function failedTask(ref: string, type: 'image' | 'video' = 'image'): MediaTask {
  return {
    elementId: ref,
    type,
    status: 'failed',
    prompt: 'Retry media',
    params: { aspectRatio: '16:9' },
    error: 'retry me',
    retryCount: 0,
    stageId,
  };
}

describe('classic media orchestrator', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let objectUrls: Map<string, Blob>;

  beforeEach(() => {
    resetProxyMediaFailureCache();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.settings.mockReset().mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'image-provider',
      imageModelId: 'image-model',
      imageProvidersConfig: {},
      videoProviderId: 'video-provider',
      videoModelId: 'video-model',
      videoProvidersConfig: {},
    });
    useMediaGenerationStore.setState({ tasks: {} });

    objectUrls = new Map();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:classic-${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetProxyMediaFailureCache();
    vi.unstubAllGlobals();
  });

  function serveImage(bytes = 'classic-image'): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        return new Response(new Blob([bytes], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
  }

  function serveVideo(): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/generate/video') {
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              url: 'https://media.test/video',
              poster: 'https://media.test/poster',
              width: 1280,
              height: 720,
              duration: 5,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        const requested = JSON.parse(String(init?.body)) as { url: string };
        return requested.url.endsWith('/poster')
          ? new Response(new Blob(['classic-poster'], { type: 'image/jpeg' }), { status: 200 })
          : new Response(new Blob(['classic-video'], { type: 'video/mp4' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
  }

  it('stores generated image bytes under the original placeholder without allocating an asset id', async () => {
    serveImage();

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'A diagram', elementId: imageRef })],
      stageId,
    );

    expect(mocks.mediaPut).toHaveBeenCalledTimes(1);
    const row = mocks.mediaPut.mock.calls[0]![0] as {
      id: string;
      stageId: string;
      blob: Blob;
      placeholderRef?: string;
    };
    expect(row.id).toBe(`${stageId}:${imageRef}`);
    expect(row.stageId).toBe(stageId);
    expect(row.placeholderRef).toBeUndefined();
    await expect(row.blob.text()).resolves.toBe('classic-image');

    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.keys(tasks)).toEqual([imageRef]);
    expect(tasks[imageRef]).toMatchObject({
      elementId: imageRef,
      status: 'done',
      objectUrl: 'blob:classic-1',
    });
  });

  it('stores video and poster bytes in one placeholder-keyed classic row', async () => {
    serveVideo();

    await generateMediaForOutlines(
      [outlineWith({ type: 'video', prompt: 'A clip', elementId: videoRef })],
      stageId,
    );

    expect(mocks.mediaPut).toHaveBeenCalledTimes(1);
    const row = mocks.mediaPut.mock.calls[0]![0] as { id: string; blob: Blob; poster?: Blob };
    expect(row.id).toBe(`${stageId}:${videoRef}`);
    await expect(row.blob.text()).resolves.toBe('classic-video');
    await expect(row.poster?.text()).resolves.toBe('classic-poster');
    expect(useMediaGenerationStore.getState().tasks[videoRef]).toMatchObject({
      elementId: videoRef,
      status: 'done',
      objectUrl: 'blob:classic-1',
      poster: 'blob:classic-2',
    });
  });

  it('keeps a hosted result as classic row metadata without downloading or allocating it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: { url: '', ossUrl: 'https://cdn.test/generated.png' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Hosted', elementId: imageRef })],
      stageId,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${stageId}:${imageRef}`,
        ossKey: 'https://cdn.test/generated.png',
        size: 0,
      }),
    );
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.objectUrl).toBe(
      'https://cdn.test/generated.png',
    );
  });

  it('processes API-limited media requests serially', async () => {
    const events: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/generate/image') {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        events.push(`generate:${body.prompt}`);
        return new Response(
          JSON.stringify({
            success: true,
            result: { url: `https://media.test/${body.prompt}` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        const body = JSON.parse(String(init?.body)) as { url: string };
        events.push(`proxy:${body.url.split('/').at(-1)}`);
        return new Response(new Blob([body.url], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    await generateMediaForOutlines(
      [
        outlineWith(
          { type: 'image', prompt: 'first', elementId: 'gen_img_first' },
          { type: 'image', prompt: 'second', elementId: 'gen_img_second' },
        ),
      ],
      stageId,
    );

    expect(events).toEqual(['generate:first', 'proxy:first', 'generate:second', 'proxy:second']);
  });

  it('skips already completed, permanently failed, and disabled requests', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        done: { ...failedTask('done'), status: 'done', objectUrl: 'blob:done', error: undefined },
        failed: failedTask('failed'),
      },
    });
    mocks.settings.mockReturnValue({
      ...mocks.settings(),
      videoGenerationEnabled: false,
    });

    await generateMediaForOutlines(
      [
        outlineWith(
          { type: 'image', prompt: 'done', elementId: 'done' },
          { type: 'image', prompt: 'failed', elementId: 'failed' },
          { type: 'video', prompt: 'disabled', elementId: 'disabled' },
        ),
      ],
      stageId,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.mediaPut).not.toHaveBeenCalled();
  });

  it('retries a failed placeholder by deleting and replacing its classic row', async () => {
    useMediaGenerationStore.setState({ tasks: { [imageRef]: failedTask(imageRef) } });
    serveImage('retried-image');

    await retryMediaTask(imageRef, {
      elementId: 'image-element',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    expect(mocks.mediaDelete).toHaveBeenCalledWith(`${stageId}:${imageRef}`);
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${imageRef}` }),
    );
    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'done',
      retryCount: 1,
    });
  });

  it('persists structured terminal errors under the placeholder for reload', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sensitive content', errorCode: 'CONTENT_SENSITIVE' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Blocked', elementId: imageRef })],
      stageId,
    );

    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      errorCode: 'CONTENT_SENSITIVE',
    });
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${stageId}:${imageRef}`,
        errorCode: 'CONTENT_SENSITIVE',
        size: 0,
      }),
    );
  });

  it('keeps transient failures in memory without writing an empty durable row', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Retry later', elementId: imageRef })],
      stageId,
    );

    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      error: 'network unavailable',
    });
    expect(mocks.mediaPut).not.toHaveBeenCalled();
  });

  it('does not import the asset pool or document mutation seams', () => {
    const source = readFileSync(join(process.cwd(), 'lib/media/media-orchestrator.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]@\/lib\/media\/asset-pool['"]/);
    expect(source).not.toContain('putAsset(');
    expect(source).not.toContain('replaceAsset(');
    expect(source).not.toContain('mutateDocument(');
    expect(source).not.toContain('.rekeyDone(');
  });

  it('retains renderer retry targeting as a read-side compatibility seam', () => {
    expect(mediaRetryTarget('image-element', 'scene-1', { canvas: { id: 'slide-1' } })).toEqual({
      elementId: 'image-element',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });
  });
});
