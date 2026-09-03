import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PreviewGate } from '../src/preview-gate.js';
import { PreviewTimeoutError, type PreviewRenderer } from '../src/preview-renderer.js';
import {
  MAX_INTERACTIVE_HTML_DEPTH,
  MAX_INTERACTIVE_HTML_ELEMENTS,
} from '../src/preview-validation.js';
import type { RenderExecutor } from '../src/render-executor.js';
import { Semaphore } from '../src/semaphore.js';
import {
  createMemoryArtifactStore,
  createMemoryJobStore,
  succeedingExecutor,
} from './support/fakes.js';

process.env.RENDER_SERVICE_NO_LISTEN = 'true';

let createApp: typeof import('../src/main.js').createApp;
let RenderCoordinator: typeof import('../src/render-coordinator.js').RenderCoordinator;

beforeAll(async () => {
  ({ createApp } = await import('../src/main.js'));
  ({ RenderCoordinator } = await import('../src/render-coordinator.js'));
});

function previewPayload() {
  return {
    version: 1,
    scene: {
      id: 'scene-1',
      stageId: 'stage-1',
      order: 1,
      title: 'Preview me',
      type: 'slide',
      content: {
        type: 'slide',
        canvas: {
          id: 'canvas-1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#fff',
            themeColors: ['#000'],
            fontColor: '#111',
            fontName: 'Inter',
          },
          elements: [{ id: 'text-1', type: 'text', content: 'Preview' }],
        },
      },
      actions: [],
    },
    stage: { id: 'stage-1', name: 'Preview course' },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  } as const;
}

function previewRequest(payload: unknown = previewPayload(), identity = 'preview-user'): Request {
  return new Request('http://test/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openmaic-client': identity },
    body: JSON.stringify(payload),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

function appWith(
  previewRenderer: PreviewRenderer,
  previewGate = new PreviewGate(8, 2),
  options: {
    extractionGate?: Semaphore;
    previewDeadlineMs?: number;
    previewMaxJsonBytes?: number;
  } = {},
) {
  const jobs = createMemoryJobStore();
  const artifacts = createMemoryArtifactStore().store;
  const coordinator = new RenderCoordinator(succeedingExecutor, jobs, artifacts);
  return createApp({
    jobs,
    artifacts,
    coordinator,
    extractionGate: options.extractionGate ?? new Semaphore(1),
    previewGate,
    previewRenderer,
    previewDeadlineMs: options.previewDeadlineMs,
    previewMaxJsonBytes: options.previewMaxJsonBytes,
  });
}

describe('POST /preview', () => {
  it('returns the rendered PNG synchronously', async () => {
    const render = vi.fn<PreviewRenderer['render']>(async () => new Uint8Array([137, 80, 78, 71]));
    const response = await appWith({ render }).fetch(previewRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe('4');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: previewPayload().scene,
        stage: previewPayload().stage,
        viewport: previewPayload().viewport,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    {
      name: 'non-JSON content',
      request: new Request('http://test/preview', { method: 'POST', body: 'not json' }),
      error: 'Expected application/json',
    },
    {
      name: 'malformed JSON',
      request: new Request('http://test/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
      error: 'Expected valid JSON',
    },
    {
      name: 'invalid scene',
      request: previewRequest({ ...previewPayload(), scene: { id: 'incomplete' } }),
      error: 'Invalid scene',
    },
    {
      name: 'mismatched stage',
      request: previewRequest({
        ...previewPayload(),
        stage: { id: 'other-stage', name: 'Other' },
      }),
      error: 'Stage context does not match scene.stageId',
    },
    {
      name: 'oversized viewport',
      request: previewRequest({
        ...previewPayload(),
        viewport: { width: 4096, height: 4096, deviceScaleFactor: 2 },
      }),
      error: 'pixel limit',
    },
  ])('maps $name to HTTP 400 before rendering', async ({ request, error }) => {
    const render = vi.fn<PreviewRenderer['render']>();
    const response = await appWith({ render }).fetch(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining(error) });
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['missing-type', {}],
  ])('rejects a $name canvas element with HTTP 400, never 500', async (_name, element) => {
    const payload = {
      ...previewPayload(),
      scene: {
        ...previewPayload().scene,
        content: {
          ...previewPayload().scene.content,
          canvas: { ...previewPayload().scene.content.canvas, elements: [element] },
        },
      },
    };
    // JSON.stringify canonicalizes an undefined array slot to null. The unit
    // test exercises the exact in-memory undefined value as well.
    const request = previewRequest(payload);
    const render = vi.fn<PreviewRenderer['render']>();

    const response = await appWith({ render }).fetch(request);

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('/content/canvas/elements/0'),
    });
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'an empty slide canvas',
      payload: {
        ...previewPayload(),
        scene: {
          ...previewPayload().scene,
          content: {
            ...previewPayload().scene.content,
            canvas: { ...previewPayload().scene.content.canvas, elements: [] },
          },
        },
      },
      error: 'no renderable elements',
    },
    {
      name: 'a slide with a non-data asset reference',
      payload: {
        ...previewPayload(),
        scene: {
          ...previewPayload().scene,
          content: {
            ...previewPayload().scene.content,
            canvas: {
              ...previewPayload().scene.content.canvas,
              elements: [{ id: 'image-1', type: 'image', src: 'asset_opaque_1' }],
            },
          },
        },
      },
      error: 'Scene is not self-contained: 1 slide media reference(s) must use data: URLs',
    },
    {
      name: 'URL-only interactive content',
      payload: {
        ...previewPayload(),
        scene: {
          ...previewPayload().scene,
          type: 'interactive',
          content: { type: 'interactive', url: '/widget.html' },
        },
      },
      error: 'non-empty embedded HTML',
    },
    {
      name: 'interactive HTML with an external dependency',
      payload: {
        ...previewPayload(),
        scene: {
          ...previewPayload().scene,
          type: 'interactive',
          content: {
            type: 'interactive',
            html: '<!doctype html><script src="https://cdn.example.test/game.js"></script>',
          },
        },
      },
      error:
        'Interactive HTML is not self-contained: 1 resource reference(s) must be inline or use data: URLs',
    },
  ])('maps $name to HTTP 422 before rendering', async ({ payload, error }) => {
    const render = vi.fn<PreviewRenderer['render']>();
    const response = await appWith({ render }).fetch(previewRequest(payload));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining(error) });
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'DOM depth',
      limit: MAX_INTERACTIVE_HTML_DEPTH,
      fixtureSize: MAX_INTERACTIVE_HTML_DEPTH + 1,
      html: `${'<i>'.repeat(MAX_INTERACTIVE_HTML_DEPTH + 1)}content${'</i>'.repeat(MAX_INTERACTIVE_HTML_DEPTH + 1)}`,
    },
    {
      name: 'element count',
      limit: MAX_INTERACTIVE_HTML_ELEMENTS,
      fixtureSize: MAX_INTERACTIVE_HTML_ELEMENTS + 1,
      html:
        '<!doctype html><body>' + '<i></i>'.repeat(MAX_INTERACTIVE_HTML_ELEMENTS + 1) + '</body>',
    },
  ])('rejects interactive HTML beyond the $name ceiling with HTTP 422', async (testCase) => {
    expect(testCase.fixtureSize).toBeGreaterThan(testCase.limit);
    const payload = {
      ...previewPayload(),
      scene: {
        ...previewPayload().scene,
        type: 'interactive',
        content: { type: 'interactive', html: testCase.html },
      },
    };
    const render = vi.fn<PreviewRenderer['render']>();

    const response = await appWith({ render }).fetch(previewRequest(payload));

    expect(response.status).toBe(422);
    expect(response.status).not.toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining(`maximum ${testCase.name} of ${testCase.limit}`),
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized body with HTTP 413', async () => {
    const render = vi.fn<PreviewRenderer['render']>();
    const request = previewRequest();
    request.headers.set('content-length', String(33 * 1024 * 1024));
    const response = await appWith({ render }).fetch(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Upload too large' });
    expect(render).not.toHaveBeenCalled();
  });

  it('caps streamed preview JSON independently of the ZIP upload limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(65)));
        controller.close();
      },
    });
    const request = new Request('http://test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    const render = vi.fn<PreviewRenderer['render']>();
    const response = await appWith({ render }, new PreviewGate(8, 0), {
      previewMaxJsonBytes: 64,
    }).fetch(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Upload too large' });
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects at admission before consuming the request body', async () => {
    const gate = new PreviewGate(1, 0);
    const release = gate.acquire('held');
    let pulls = 0;
    const body = new ReadableStream({
      pull() {
        pulls += 1;
      },
    });
    const request = new Request('http://test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmaic-client': 'rejected' },
      body,
      duplex: 'half',
    } as RequestInit);
    await Promise.resolve();
    const pullsBeforeFetch = pulls;

    const response = await appWith({ render: async () => new Uint8Array([1]) }, gate).fetch(
      request,
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('preview queue is full'),
      reason: 'preview_queue_full',
    });
    expect(pulls).toBe(pullsBeforeFetch);
    release();
  });

  it('enforces the per-identity cap while allowing another identity', async () => {
    let finish!: () => void;
    const parked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const app = appWith(
      { render: async () => (await parked, new Uint8Array([1])) },
      new PreviewGate(8, 1),
    );

    const first = app.fetch(previewRequest(previewPayload(), 'alice'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rejected = await app.fetch(previewRequest(previewPayload(), 'alice'));
    const other = app.fetch(previewRequest(previewPayload(), 'bob'));

    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({
      reason: 'preview_per_user_limit',
    });
    const otherResponse = await other;
    expect(otherResponse.status).toBe(429);
    await expect(otherResponse.json()).resolves.toMatchObject({ reason: 'capacity_busy' });
    finish();
    expect((await first).status).toBe(200);
  });

  it('maps renderer deadlines to 504 and other failures to 500', async () => {
    const timedOut = await appWith({
      render: async () => {
        throw new PreviewTimeoutError('Preview exceeded the deadline');
      },
    }).fetch(previewRequest());
    expect(timedOut.status).toBe(504);

    const failed = await appWith({
      render: async () => {
        throw new Error('Chromium launch failed');
      },
    }).fetch(previewRequest());
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: 'Chromium launch failed' });
  });

  it('applies the deadline while waiting for an extraction permit', async () => {
    const extractionGate = new Semaphore(1);
    let releasePermit!: () => void;
    const held = extractionGate.run(
      () =>
        new Promise<void>((resolve) => {
          releasePermit = resolve;
        }),
    );
    await Promise.resolve();

    const render = vi.fn<PreviewRenderer['render']>(async () => new Uint8Array([1]));
    const app = appWith({ render }, new PreviewGate(8, 2), {
      extractionGate,
      previewDeadlineMs: 20,
    });
    const started = Date.now();
    const response = await app.fetch(previewRequest());

    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(500);
    expect(render).not.toHaveBeenCalled();

    releasePermit();
    await held;
    const next = await app.fetch(previewRequest());
    expect(next.status).toBe(200);
  });

  it('cancels a stalled body read when the preview deadline expires', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    const render = vi.fn<PreviewRenderer['render']>(async () => new Uint8Array([1]));
    const app = appWith({ render }, new PreviewGate(8, 2), { previewDeadlineMs: 20 });

    const started = Date.now();
    const response = await app.fetch(request);

    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(500);
    expect(cancelled).toBe(true);
    expect(render).not.toHaveBeenCalled();

    const next = await app.fetch(previewRequest());
    expect(next.status).toBe(200);
  });

  it('releases the extraction permit after parsing and never queues for execution', async () => {
    const finishFirst = deferred();
    let renderCalls = 0;
    const app = appWith({
      render: async () => {
        renderCalls += 1;
        if (renderCalls === 1) await finishFirst.promise;
        return new Uint8Array([1]);
      },
    });

    const first = app.fetch(previewRequest(previewPayload(), 'first'));
    await waitFor(() => renderCalls === 1);

    const bytes = new TextEncoder().encode(JSON.stringify(previewPayload()));
    let offset = 0;
    let pulls = 0;
    const secondBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const next = Math.min(offset + 32, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, next));
        offset = next;
      },
    });
    const secondRequest = new Request('http://test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmaic-client': 'second' },
      body: secondBody,
      duplex: 'half',
    } as RequestInit);
    await Promise.resolve();
    const pullsBeforeFetch = pulls;
    const second = app.fetch(secondRequest);

    const secondResponse = await second;
    expect(renderCalls).toBe(1);
    expect(pulls).toBeGreaterThan(pullsBeforeFetch);
    expect(secondResponse.status).toBe(429);
    await expect(secondResponse.json()).resolves.toMatchObject({ reason: 'capacity_busy' });

    finishFirst.resolve();
    expect((await first).status).toBe(200);
    expect(renderCalls).toBe(1);
  });

  it('fast-rejects when a video render holds the shared Chromium execution limit', async () => {
    const videoStarted = deferred();
    const finishVideo = deferred();
    const executor: RenderExecutor = {
      async execute() {
        videoStarted.resolve();
        await finishVideo.promise;
        return { status: 'succeeded' };
      },
    };
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const coordinator = new RenderCoordinator(executor, jobs, artifacts, { maxConcurrency: 1 });
    const videoId = await coordinator.submit(
      coordinator.reserve('video-user'),
      '/tmp/openmaic-preview-route-video-test',
      { fps: 30, quality: 'standard', format: 'mp4' },
    );
    await videoStarted.promise;

    const render = vi.fn<PreviewRenderer['render']>(async () => new Uint8Array([1]));
    const app = createApp({
      jobs,
      artifacts,
      coordinator,
      extractionGate: new Semaphore(1),
      previewRenderer: { render },
      previewDeadlineMs: 1_000,
    });
    const started = Date.now();
    const preview = await app.fetch(previewRequest());

    expect(Date.now() - started).toBeLessThan(500);
    expect(render).not.toHaveBeenCalled();
    expect(preview.status).toBe(429);
    await expect(preview.json()).resolves.toMatchObject({ reason: 'capacity_busy' });

    finishVideo.resolve();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await jobs.get(videoId))?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await jobs.get(videoId))?.status).toBe('succeeded');
    expect((await app.fetch(previewRequest())).status).toBe(200);
    expect(render).toHaveBeenCalledOnce();
  });

  it('aborts rendering and releases admission when the client disconnects', async () => {
    const rendering = deferred();
    let calls = 0;
    const render = vi.fn<PreviewRenderer['render']>(async ({ signal }) => {
      calls += 1;
      if (calls > 1) return new Uint8Array([1]);
      rendering.resolve();
      return new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const app = appWith({ render }, new PreviewGate(1, 0));
    const disconnected = new AbortController();
    const request = previewRequest();
    const abortableRequest = new Request(request, { signal: disconnected.signal });
    const responsePromise = app.fetch(abortableRequest);
    await rendering.promise;

    disconnected.abort(new Error('client disconnected'));
    const response = await responsePromise;
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'client disconnected' });

    expect((await app.fetch(previewRequest())).status).toBe(200);
  });
});
