import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PreviewGate } from '../src/preview-gate.js';
import { PreviewTimeoutError, type PreviewRenderer } from '../src/preview-renderer.js';
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
          elements: [],
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
  options: { extractionGate?: Semaphore; previewDeadlineMs?: number } = {},
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

  it('rejects a declared oversized body with HTTP 413', async () => {
    const render = vi.fn<PreviewRenderer['render']>();
    const request = previewRequest();
    request.headers.set('content-length', String(301 * 1024 * 1024));
    const response = await appWith({ render }).fetch(request);

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
    finish();
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);
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

  it('retains the extraction permit while the parsed payload is rendering', async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renderCalls).toBe(1);
    expect(pulls).toBe(pullsBeforeFetch);

    finishFirst.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(renderCalls).toBe(2);
  });

  it('shares the Chromium execution limit with video renders', async () => {
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
    await coordinator.submit(
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
    const preview = app.fetch(previewRequest());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(render).not.toHaveBeenCalled();

    finishVideo.resolve();
    expect((await preview).status).toBe(200);
    expect(render).toHaveBeenCalledOnce();
  });
});
