/**
 * Integration test for the admission/buffering boundary of `POST /owner-bound/render`.
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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ArtifactStore } from '../src/artifact-store.js';
import { InMemoryJobStore, type JobStore } from '../src/job-store.js';
import type { RenderCoordinatorOptions } from '../src/render-coordinator.js';
import type { RenderExecutor } from '../src/render-executor.js';
import { Semaphore } from '../src/semaphore.js';
import {
  requireAdmissionIdentity,
  requireRenderOwnerId,
  type RenderJobRecord,
} from '../src/types.js';
import { waitUntil } from './support/async.js';
import {
  createMemoryArtifactStore,
  createMemoryJobStore,
  parkingExecutor,
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

/** Build a valid-looking multipart body for `POST /owner-bound/render`. */
const OWNER_HEADER = 'x-openmaic-render-owner';
const OWNER_BOUND_HEADER = 'x-openmaic-render-owner-bound';

function renderRequest(sizeBytes = 4096, identity = 'anon', ownerId = 'owner-a'): Request {
  const form = new FormData();
  form.append('project', new Blob([new Uint8Array(sizeBytes)]), 'project.zip');
  form.append('fps', '24');
  form.append('quality', 'draft');
  form.append('format', 'mp4');
  return new Request('http://test/owner-bound/render', {
    method: 'POST',
    body: form,
    headers: { 'x-openmaic-client': identity, [OWNER_HEADER]: ownerId },
  });
}

function jobRequest(
  path: string,
  ownerId = 'owner-a',
  init: Omit<RequestInit, 'headers'> = {},
): Request {
  return new Request(`http://test${path}`, {
    ...init,
    headers: { [OWNER_HEADER]: ownerId },
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
  ownerId = 'owner-a',
): Promise<Record<string, unknown>> {
  return waitUntil(async () => {
    const response = await app.fetch(jobRequest(`/owner-bound/render/${jobId}`, ownerId));
    const body = (await response.json()) as Record<string, unknown>;
    return body.status === status ? body : null;
  }, `${jobId} to reach ${status}`);
}

async function healthBody(app: ReturnType<typeof createApp>): Promise<Record<string, unknown>> {
  const response = await app.fetch(new Request('http://test/health'));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /owner-bound/render buffering/extraction bound', () => {
  it('reports the configured preview concurrency, not just its default', async () => {
    vi.stubEnv('RENDER_PREVIEW_MAX_CONCURRENCY', '2');
    vi.resetModules();
    try {
      const { createApp: createConfiguredApp } = await import('../src/main.js');
      const jobs = createMemoryJobStore();
      const artifacts = createMemoryArtifactStore().store;
      const app = createConfiguredApp({
        jobs,
        artifacts,
        coordinator: new RenderCoordinator(succeedingExecutor, jobs, artifacts),
        extractionGate: new Semaphore(1),
      });
      await expect(healthBody(app)).resolves.toMatchObject({ previewMaxConcurrency: 2 });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

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
    expect(response.headers.get(OWNER_BOUND_HEADER)).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      previewMaxConcurrency: 1,
      resourceProfile: {
        name: 'standard',
        capturePolicy: 'prefer-beginframe',
        requestedCaptureMode: 'beginframe',
        requireBeginFrame: false,
        producerWorkers: 1,
        maxConcurrency: 1,
        maxPreviewConcurrency: 2,
        minimumMemoryMiB: 8 * 1024,
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
  it('exposes a safe startup summary without leaking private owner diagnostics', async () => {
    const jobs = createMemoryJobStore();
    const now = Date.now();
    await jobs.create({
      id: 'startup-failed',
      ownerId: requireRenderOwnerId('owner-a'),
      admissionIdentity: requireAdmissionIdentity('client-a'),
      status: 'failed',
      progress: 0,
      currentStage: 'failed',
      error: 'Resource render failed; see service logs',
      createdAtMs: now,
      updatedAtMs: now,
      projectDir: '/tmp/startup-failed',
      resources: {
        published: false,
        cleanupVerified: false,
        reservationReturned: false,
        admissionClosed: true,
        diagnosticCode: 'main_pid_read_error',
        details: { diagnostic: '/proc/42/cgroup: private permission failure' },
      },
    });
    const { app } = testApp(succeedingExecutor, { jobs });
    const response = await app.fetch(jobRequest('/owner-bound/render/startup-failed'));
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      resources: {
        published: false,
        cleanupVerified: false,
        reservationReturned: false,
        admissionClosed: true,
        diagnosticCode: 'main_pid_read_error',
      },
    });
    expect(text).not.toContain('/proc/42');
    expect(text).not.toContain('private permission failure');
  });

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
    expect(submit.headers.get(OWNER_BOUND_HEADER)).toBe('1');
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

    const download = await app.fetch(jobRequest(`/owner-bound/render/${jobId}/download`));
    expect(download.status).toBe(200);
    expect(download.headers.get(OWNER_BOUND_HEADER)).toBe('1');
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
      jobRequest(`/owner-bound/render/${jobId}`, 'owner-a', { method: 'DELETE' }),
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
      jobRequest(`/owner-bound/render/${jobId}`, 'owner-a', { method: 'DELETE' }),
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
      ownerId: requireRenderOwnerId('owner-a'),
      admissionIdentity: requireAdmissionIdentity('client-a'),
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
      ownerId: requireRenderOwnerId('owner-a'),
      admissionIdentity: requireAdmissionIdentity('client-a'),
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

    const redirect = await app.fetch(jobRequest('/owner-bound/render/ready/download'));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.test/video.mp4');

    const notReady = await app.fetch(jobRequest('/owner-bound/render/failed/download'));
    expect(notReady.status).toBe(409);
    await expect(notReady.json()).resolves.toEqual({ error: 'Job not ready (status: failed)' });

    const missing = await app.fetch(jobRequest('/owner-bound/render/missing/download'));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'Job not found' });
  });

  it('requires valid internal identities before admission or request-body reads', async () => {
    const { app, coordinator } = testApp(succeedingExecutor);
    const reserve = vi.spyOn(coordinator, 'reserve');

    for (const headers of [
      { 'x-openmaic-client': 'client-a' },
      { 'x-openmaic-client': 'client-a', [OWNER_HEADER]: 'owner with spaces' },
      { 'x-openmaic-client': 'client-a', [OWNER_HEADER]: 'x'.repeat(257) },
      { [OWNER_HEADER]: 'owner-a' },
      { 'x-openmaic-client': 'client with spaces', [OWNER_HEADER]: 'owner-a' },
    ]) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = await app.fetch(
        new Request('http://test/owner-bound/render', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'multipart/form-data; boundary=fixture' },
          body,
          duplex: 'half',
        } as RequestInit),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid render identity' });
      expect(pulls).toBe(0);
    }

    expect(reserve).not.toHaveBeenCalled();
  });

  it('refuses legacy job paths without buffering, reservation, lookup, or cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-legacy-'));
    scratch.push(dir);
    const jobs = new InMemoryJobStore(60_000);
    const { app, artifacts, coordinator } = testApp(succeedingExecutor, {
      jobs,
      coordinator: { maxConcurrency: 0 },
      makeProjectDir: async () => dir,
    });
    const submitted = await app.fetch(renderRequest());
    expect(submitted.status).toBe(202);
    const { jobId } = (await submitted.json()) as { jobId: string };
    const snapshot = await jobs.list();
    const reserve = vi.spyOn(coordinator, 'reserve');
    const cancel = vi.spyOn(coordinator, 'cancelForOwner');
    const get = vi.spyOn(jobs, 'getForOwner');
    const locate = vi.spyOn(artifacts, 'locate');
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls++;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    // Even valid assertions from an old app must not activate legacy routes.
    const legacySubmit = new Request('http://test/render', {
      method: 'POST',
      headers: {
        [OWNER_HEADER]: 'owner-a',
        'x-openmaic-client': 'anon',
        'content-type': 'multipart/form-data; boundary=fixture',
      },
      body,
      duplex: 'half',
    } as RequestInit);
    for (const req of [
      legacySubmit,
      jobRequest(`/render/${jobId}`),
      jobRequest(`/render/${jobId}`, 'owner-a', { method: 'DELETE' }),
      jobRequest(`/render/${jobId}/download`),
    ]) {
      const response = await app.fetch(req);
      expect(response.status).toBe(404);
      expect(response.headers.get(OWNER_BOUND_HEADER)).toBe('1');
    }
    expect(pulls).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(await jobs.list()).toEqual(snapshot);
  });

  it('makes foreign and missing jobs indistinguishable across poll and cancel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-owner-cancel-'));
    scratch.push(dir);
    const jobs = new InMemoryJobStore(60_000);
    const { app } = testApp(succeedingExecutor, {
      jobs,
      coordinator: { maxConcurrency: 0 },
      makeProjectDir: async () => dir,
    });
    const submit = await app.fetch(renderRequest(4096, 'client-a', 'owner-a'));
    const { jobId } = (await submit.json()) as { jobId: string };

    const ownPoll = await app.fetch(jobRequest(`/owner-bound/render/${jobId}`, 'owner-a'));
    expect(ownPoll.status).toBe(200);
    await expect(ownPoll.json()).resolves.toMatchObject({ jobId, status: 'queued' });

    for (const id of [jobId, 'missing']) {
      const poll = await app.fetch(jobRequest(`/owner-bound/render/${id}`, 'owner-b'));
      expect(poll.status).toBe(404);
      await expect(poll.json()).resolves.toEqual({ error: 'Job not found' });

      const cancel = await app.fetch(
        jobRequest(`/owner-bound/render/${id}`, 'owner-b', { method: 'DELETE' }),
      );
      expect(cancel.status).toBe(404);
      await expect(cancel.json()).resolves.toEqual({ error: 'Job not found' });
    }

    const stillQueued = await app.fetch(jobRequest(`/owner-bound/render/${jobId}`, 'owner-a'));
    await expect(stillQueued.json()).resolves.toMatchObject({ status: 'queued' });
    const ownCancel = await app.fetch(
      jobRequest(`/owner-bound/render/${jobId}`, 'owner-a', { method: 'DELETE' }),
    );
    expect(ownCancel.status).toBe(200);
  });

  it('does not locate an artifact for a foreign or missing job', async () => {
    const jobs = new InMemoryJobStore(60_000);
    const now = Date.now();
    await jobs.create({
      id: 'ready-for-owner',
      ownerId: requireRenderOwnerId('owner-a'),
      admissionIdentity: requireAdmissionIdentity('client-a'),
      status: 'succeeded',
      progress: 1,
      currentStage: 'complete',
      createdAtMs: now,
      updatedAtMs: now,
      projectDir: '/tmp/ready-for-owner',
      outputPath: '/tmp/ready-for-owner/output.mp4',
    });
    const locate = vi.fn(async () => ({
      kind: 'url' as const,
      href: 'https://example.test/owned.mp4',
    }));
    const artifacts: ArtifactStore = {
      async put() {},
      locate,
      async remove() {},
    };
    const { app } = testApp(succeedingExecutor, { artifacts, jobs });

    const own = await app.fetch(
      jobRequest('/owner-bound/render/ready-for-owner/download', 'owner-a'),
    );
    expect(own.status).toBe(302);
    expect(locate).toHaveBeenCalledOnce();

    for (const id of ['ready-for-owner', 'missing']) {
      const response = await app.fetch(jobRequest(`/owner-bound/render/${id}/download`, 'owner-b'));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Job not found' });
    }
    expect(locate).toHaveBeenCalledOnce();
  });

  it('hides an ownerless record from poll, cancel, and download', async () => {
    const jobs = new InMemoryJobStore(60_000);
    const records: unknown = Reflect.get(jobs, 'jobs');
    if (!(records instanceof Map)) throw new Error('InMemoryJobStore backing map not found');
    const now = Date.now();
    records.set('legacy-ownerless', {
      id: 'legacy-ownerless',
      admissionIdentity: requireAdmissionIdentity('client-a'),
      status: 'succeeded',
      progress: 1,
      currentStage: 'complete',
      createdAtMs: now,
      updatedAtMs: now,
      projectDir: '/tmp/legacy-ownerless',
      outputPath: '/tmp/legacy-ownerless/output.mp4',
    });
    const locate = vi.fn();
    const artifacts: ArtifactStore = {
      async put() {},
      locate,
      async remove() {},
    };
    const { app } = testApp(succeedingExecutor, { artifacts, jobs });

    for (const request of [
      jobRequest('/owner-bound/render/legacy-ownerless'),
      jobRequest('/owner-bound/render/legacy-ownerless', 'owner-a', { method: 'DELETE' }),
      jobRequest('/owner-bound/render/legacy-ownerless/download'),
    ]) {
      const response = await app.fetch(request);
      expect(response.status).toBe(404);
      expect(response.headers.get(OWNER_BOUND_HEADER)).toBe('1');
      await expect(response.json()).resolves.toEqual({ error: 'Job not found' });
    }
    expect(locate).not.toHaveBeenCalled();
  });
});

describe('admission observability (429 reason + /health accepting)', () => {
  it('keeps /health aggregate-only: exact key set, boolean accepting', async () => {
    const { app } = testApp(succeedingExecutor);
    const body = await healthBody(app);
    // Pinning the exact key set: any new field (queue depths, per-identity
    // data) must be a deliberate, reviewed change — identity keys are client
    // IPs behind a trusted proxy, so they must never reach this response.
    expect(Object.keys(body).sort()).toEqual([
      'accepting',
      'ok',
      'previewMaxConcurrency',
      'resourceProfile',
      'versions',
    ]);
    expect(typeof body.accepting).toBe('boolean');
  });

  it('labels a queue-full 429 with reason and flips /health accepting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-queue-full-'));
    scratch.push(dir);
    const { executor, releaseRenders } = parkingExecutor();
    const { app } = testApp(executor, {
      coordinator: { maxQueue: 1, maxJobsPerUser: 0 },
      makeProjectDir: async () => dir,
    });

    // Empty system: health reports we're accepting, aggregates only.
    await expect(healthBody(app)).resolves.toMatchObject({ ok: true, accepting: true });

    // One admitted render fills the entire global cap and parks there.
    const first = await app.fetch(renderRequest(4096, 'user-a'));
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    await expect(healthBody(app)).resolves.toMatchObject({ accepting: false });

    // A second render from a DIFFERENT identity is still refused — the global
    // cap fired, not the per-user guard — and the 429 body says so.
    const second = await app.fetch(renderRequest(4096, 'user-b'));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({
      error: 'The render queue is full; try again shortly.',
      reason: 'queue_full',
    });

    // Once the parked render finishes, capacity — and the flag — come back.
    releaseRenders();
    await waitForPoll(app, jobId, 'succeeded');
    await expect(healthBody(app)).resolves.toMatchObject({ accepting: true });
  });

  it('labels a per-identity 429 with reason (queue itself has room)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-per-identity-'));
    scratch.push(dir);
    const { executor, releaseRenders } = parkingExecutor();
    const { app } = testApp(executor, {
      coordinator: { maxQueue: 20, maxJobsPerUser: 1 },
      makeProjectDir: async () => dir,
    });

    const first = await app.fetch(renderRequest(4096, 'solo'));
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };

    // Same identity again: the system still has queue room (and health stays
    // accepting) — only this identity's own slot is exhausted.
    await expect(healthBody(app)).resolves.toMatchObject({ accepting: true });
    const second = await app.fetch(renderRequest(4096, 'solo'));
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({
      error: 'A render is already in progress (limit 1).',
      reason: 'per_identity_limit',
    });

    releaseRenders();
    await waitForPoll(app, jobId, 'succeeded');
  });
});

describe('render project CSP hardening', () => {
  it('injects the render policy into the extracted project before the executor reads it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'render-route-csp-'));
    scratch.push(dir);
    let observedHtml: string | undefined;
    const executor: RenderExecutor = {
      async execute(request) {
        observedHtml = await readFile(join(request.projectDir, 'index.html'), 'utf8');
        return { status: 'succeeded' };
      },
    };
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const coordinator = new RenderCoordinator(executor, jobs, artifacts);
    const app = createApp({
      jobs,
      artifacts,
      coordinator,
      extractionGate: new Semaphore(1),
      // The real default `hardenProject` runs here; only extraction is stubbed.
      unzipProject: async (_zip, destDir) => {
        await writeFile(join(destDir, 'index.html'), '<!doctype html><html><head></head></html>');
      },
      makeProjectDir: async () => dir,
    });

    const submit = await app.fetch(renderRequest());
    expect(submit.status).toBe(202);
    const { jobId } = (await submit.json()) as { jobId: string };
    await waitForPoll(app, jobId, 'succeeded');

    expect(observedHtml).toContain('data-openmaic-untrusted-csp');
    expect(observedHtml).toContain("connect-src 'none'");
  });
});
