/**
 * Integration test for the admission/buffering boundary of `POST /render`.
 *
 * The security property under test (round-3 review P1#1): only
 * `maxConcurrentExtractions` requests may be inside the RAM-heavy section
 * (multipart buffering → file read → extraction) at once. Everything else waits
 * with its body unconsumed, so a burst of near-cap uploads can't stack in memory.
 *
 * We drive the real Hono app (`createApp`) with a fake coordinator/stores and a
 * `unzipProject` stub that parks — recording how many calls are simultaneously
 * "inside" — so we can assert the peak never exceeds the gate's permit count.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactStore } from '../src/artifact-store.js';
import type { JobStore } from '../src/job-store.js';
import type { RenderCoordinatorOptions } from '../src/render-coordinator.js';
import type { RenderExecutor } from '../src/render-executor.js';
import { Semaphore } from '../src/semaphore.js';
import type { RenderJobRecord } from '../src/types.js';
import {
  createMemoryArtifactStore,
  createMemoryJobStore,
  succeedingExecutor,
} from './support/fakes.js';

// Prevent main.ts from binding a port when we import it.
process.env.RENDER_SERVICE_NO_LISTEN = 'true';

// Loaded in beforeAll after the env guard above is set.
let createApp: typeof import('../src/main.js').createApp;
let RenderCoordinator: typeof import('../src/render-coordinator.js').RenderCoordinator;
const scratch: string[] = [];

beforeAll(async () => {
  ({ createApp } = await import('../src/main.js'));
  ({ RenderCoordinator } = await import('../src/render-coordinator.js'));
});

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Build a valid-looking multipart body for `POST /render`. */
function renderRequest(sizeBytes = 4096, identity = 'anon'): Request {
  const form = new FormData();
  form.append('project', new Blob([new Uint8Array(sizeBytes)]), 'project.zip');
  form.append('fps', '24');
  form.append('quality', 'draft');
  form.append('format', 'mp4');
  return new Request('http://test/render', {
    method: 'POST',
    body: form,
    headers: { 'x-openmaic-client': identity },
  });
}

function testApp(
  executor: RenderExecutor,
  options: {
    jobs?: JobStore;
    artifacts?: ArtifactStore;
    coordinator?: RenderCoordinatorOptions;
    makeProjectDir?: () => Promise<string>;
  } = {},
) {
  const jobs = options.jobs ?? createMemoryJobStore();
  const artifacts = options.artifacts ?? createMemoryArtifactStore().store;
  const coordinator = new RenderCoordinator(executor, jobs, artifacts, options.coordinator);
  const app = createApp({
    jobs,
    artifacts,
    coordinator,
    extractionGate: new Semaphore(1),
    unzipProject: async () => {},
    ...(options.makeProjectDir ? { makeProjectDir: options.makeProjectDir } : {}),
  });
  return { app, artifacts, coordinator, jobs };
}

async function waitForPoll(
  app: ReturnType<typeof createApp>,
  jobId: string,
  status: RenderJobRecord['status'],
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.fetch(new Request(`http://test/render/${jobId}`));
    const body = (await response.json()) as Record<string, unknown>;
    if (body.status === status) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${jobId} to reach ${status}`);
}

describe('POST /render buffering/extraction bound', () => {
  it('reports the selected profile and observed runtime versions from health', async () => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const runtimeVersions = {
      service: '0.1.0',
      producer: '0.7.60',
      node: 'v22.22.2',
      chromium: 'Chromium 151.0.7922.71',
      chromiumPath: '/usr/bin/chromium-headless-shell',
      ffmpeg: 'ffmpeg version 5.1.9-0+deb12u1',
      ffmpegPath: '/usr/bin/ffmpeg',
      containerImage: 'openmaic/render-service:test',
    };
    const app = createApp({
      jobs,
      artifacts,
      coordinator: new RenderCoordinator(succeedingExecutor, jobs, artifacts),
      extractionGate: new Semaphore(1),
      runtimeVersions,
    });

    const response = await app.fetch(new Request('http://test/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      resourceProfile: {
        name: 'standard',
        requestedCaptureMode: 'beginframe',
        producerWorkers: 1,
        maxConcurrency: 1,
        minimumMemoryMiB: 10 * 1024,
      },
      versions: runtimeVersions,
    });
  });

  it('never lets more than the permit count into the buffering+extraction section', async () => {
    const PERMITS = 2;
    const REQUESTS = 8;

    let inside = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    // Each extraction parks until we release it, so all admitted requests pile
    // up at the gate simultaneously — exposing any over-admission.
    const unzipProject = () =>
      new Promise<void>((resolve) => {
        inside++;
        peak = Math.max(peak, inside);
        release.push(() => {
          inside--;
          resolve();
        });
      });

    let n = 0;
    const makeProjectDir = async () => `/tmp/fake-${n++}`;

    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    // A big per-user cap so all REQUESTS are admitted (we're testing the gate,
    // not the per-identity guard); unique identities would also work.
    const coordinator = new RenderCoordinator(succeedingExecutor, jobs, artifacts);
    const app = createApp({
      jobs,
      artifacts,
      coordinator,
      extractionGate: new Semaphore(PERMITS),
      unzipProject,
      makeProjectDir,
    });

    // Fire all requests with distinct identities so admission never rejects them.
    const inFlight = Array.from({ length: REQUESTS }, (_, i) =>
      app.fetch(renderRequest(4096, `user-${i}`)),
    );

    // Let the event loop settle so every request that CAN enter the gate has.
    await new Promise((r) => setTimeout(r, 50));

    // The invariant: at most PERMITS extractions are parked inside right now.
    expect(inside).toBeLessThanOrEqual(PERMITS);
    expect(peak).toBeLessThanOrEqual(PERMITS);

    // Drain: release parked calls; each release frees a permit for a waiter.
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }

    const responses = await Promise.all(inFlight);
    // Every request ultimately succeeds (202) once it passes through the gate.
    for (const res of responses) expect(res.status).toBe(202);
    // Peak concurrency never exceeded the permit count across the whole run.
    expect(peak).toBe(PERMITS);
  });
});

describe('render HTTP contract through a replaceable executor', () => {
  it('preserves submit, polling, and file download behavior', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-success-'));
    scratch.push(dir);
    const executor: RenderExecutor = {
      async execute(request) {
        await request.onProgress({
          progress: 0.5,
          stage: 'capturing',
          framesRendered: 12,
          totalFrames: 24,
        });
        await writeFile(request.outputPath, Buffer.from('fake-mp4'));
        return { status: 'succeeded' };
      },
    };
    const { app } = testApp(executor, { makeProjectDir: async () => dir });

    const submit = await app.fetch(renderRequest());
    expect(submit.status).toBe(202);
    const { jobId } = (await submit.json()) as { jobId: string };

    await expect(waitForPoll(app, jobId, 'succeeded')).resolves.toEqual({
      jobId,
      status: 'succeeded',
      progress: 1,
      currentStage: 'complete',
      framesRendered: 12,
      totalFrames: 24,
      done: true,
    });

    const download = await app.fetch(new Request(`http://test/render/${jobId}/download`));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('video/mp4');
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${jobId}.mp4"`);
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe('fake-mp4');
  });

  it('preserves queued cancellation and its polling shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-queued-cancel-'));
    scratch.push(dir);
    const { app } = testApp(succeedingExecutor, {
      coordinator: { maxConcurrency: 0 },
      makeProjectDir: async () => dir,
    });
    const submit = await app.fetch(renderRequest());
    const { jobId } = (await submit.json()) as { jobId: string };

    const cancel = await app.fetch(
      new Request(`http://test/render/${jobId}`, { method: 'DELETE' }),
    );
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toEqual({ cancelled: true });
    await expect(waitForPoll(app, jobId, 'cancelled')).resolves.toEqual({
      jobId,
      status: 'cancelled',
      progress: 0,
      currentStage: 'cancelled',
      done: true,
    });
  });

  it('preserves the running-cancellation error in polling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-running-cancel-'));
    scratch.push(dir);
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: RenderExecutor = {
      async execute(request) {
        started();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          status: 'cancelled',
          failure: { code: 'cancelled', message: 'render_cancelled' },
        };
      },
    };
    const { app } = testApp(executor, { makeProjectDir: async () => dir });
    const submit = await app.fetch(renderRequest());
    const { jobId } = (await submit.json()) as { jobId: string };
    await executionStarted;

    const cancel = await app.fetch(
      new Request(`http://test/render/${jobId}`, { method: 'DELETE' }),
    );
    expect(cancel.status).toBe(200);
    await expect(waitForPoll(app, jobId, 'cancelled')).resolves.toEqual({
      jobId,
      status: 'cancelled',
      progress: 0,
      currentStage: 'cancelled',
      error: 'render_cancelled',
      done: true,
    });
  });

  it('preserves redirect downloads and terminal download errors', async () => {
    const jobs = createMemoryJobStore();
    const now = Date.now();
    await jobs.create({
      id: 'ready',
      status: 'succeeded',
      progress: 1,
      currentStage: 'complete',
      createdAtMs: now,
      updatedAtMs: now,
      projectDir: '/tmp/ready',
      outputPath: '/tmp/ready/output.mp4',
    });
    await jobs.create({
      id: 'failed',
      status: 'failed',
      progress: 0.25,
      currentStage: 'failed',
      error: 'boom',
      createdAtMs: now,
      updatedAtMs: now,
      projectDir: '/tmp/failed',
    });
    const artifacts: ArtifactStore = {
      async put() {},
      async locate(id) {
        return id === 'ready' ? { kind: 'url', href: 'https://example.test/video.mp4' } : null;
      },
      async remove() {},
    };
    const { app } = testApp(succeedingExecutor, { artifacts, jobs });

    const redirect = await app.fetch(new Request('http://test/render/ready/download'));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.test/video.mp4');

    const notReady = await app.fetch(new Request('http://test/render/failed/download'));
    expect(notReady.status).toBe(409);
    await expect(notReady.json()).resolves.toEqual({ error: 'Job not ready (status: failed)' });

    const missing = await app.fetch(new Request('http://test/render/missing/download'));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'Job not found' });
  });
});
