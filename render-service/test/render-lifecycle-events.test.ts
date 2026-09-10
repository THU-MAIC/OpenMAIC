/**
 * A render's outcome lives only in the JobStore, which is in memory by default
 * and gone on restart, and a failed render answers the client with HTTP 200
 * whose body says `failed`. These tests pin the lifecycle events that make an
 * outcome observable outside the process: submitted -> started (with the queue
 * wait) -> finished (with the outcome), plus the admission rejections and the
 * synchronous preview route's real status.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RenderEvent } from '../src/events.js';
import { RenderCoordinator } from '../src/render-coordinator.js';
import type { RenderExecutor } from '../src/render-executor.js';
import { Semaphore } from '../src/semaphore.js';
import type { RenderExecutionResult, RenderJobRecord } from '../src/types.js';
import type { JobStore } from '../src/job-store.js';
import { createMemoryArtifactStore, createMemoryJobStore } from './support/fakes.js';

process.env.RENDER_SERVICE_NO_LISTEN = 'true';

let createApp: typeof import('../src/main.js').createApp;

beforeAll(async () => {
  ({ createApp } = await import('../src/main.js'));
});

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function projectDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'render-events-'));
  scratch.push(path);
  return path;
}

function executor(result: () => Promise<RenderExecutionResult>): RenderExecutor {
  return { execute: result };
}

async function waitForJob(
  jobs: JobStore,
  id: string,
  predicate: (job: RenderJobRecord) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await jobs.get(id);
    if (job && predicate(job)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} never reached the expected state`);
}

function coordinatorWith(
  events: RenderEvent[],
  execute: () => Promise<RenderExecutionResult>,
  options: { maxQueue?: number; maxJobsPerUser?: number } = {},
) {
  const jobs = createMemoryJobStore();
  const artifacts = createMemoryArtifactStore().store;
  const coordinator = new RenderCoordinator(executor(execute), jobs, artifacts, {
    ...options,
    onEvent: (event) => events.push(event),
  });
  return { coordinator, jobs };
}

describe('render job lifecycle events', () => {
  it('reports submitted, started with a queue wait, and finished with the outcome', async () => {
    const events: RenderEvent[] = [];
    const { coordinator, jobs } = coordinatorWith(events, async () => ({
      status: 'succeeded',
      outputPath: 'out.mp4',
    }));

    const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
      fps: 24,
      quality: 'draft',
      format: 'mp4',
    });
    await waitForJob(jobs, id, (job) => job.status === 'succeeded');

    expect(events.map((event) => event.event)).toEqual([
      'render_job_submitted',
      'render_job_started',
      'render_job_finished',
    ]);
    const started = events[1]!;
    expect(started.jobId).toBe(id);
    expect(typeof started.queueWaitMs).toBe('number');
    expect(started.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(events[2]).toMatchObject({ jobId: id, outcome: 'succeeded' });
    expect(typeof events[2]!.durationMs).toBe('number');
  });

  it('reports a failed render with its failure code and never its message', async () => {
    const events: RenderEvent[] = [];
    const { coordinator, jobs } = coordinatorWith(events, async () => {
      throw new Error('chromium crashed at /tmp/secret-project/scene.html');
    });

    const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
      fps: 24,
      quality: 'draft',
      format: 'mp4',
    });
    await waitForJob(jobs, id, (job) => job.status === 'failed');

    const finished = events.find((event) => event.event === 'render_job_finished');
    expect(finished).toMatchObject({ outcome: 'failed', errorCode: 'execution_failed' });
    // The free-text message carries a scratch path; it must not reach the log.
    expect(JSON.stringify(events)).not.toContain('secret-project');
    expect(JSON.stringify(events)).not.toContain('chromium crashed');
  });

  it('reports a cancelled render as cancelled rather than failed', async () => {
    const events: RenderEvent[] = [];
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { coordinator, jobs } = coordinatorWith(events, async () => {
      await parked;
      return { status: 'succeeded', outputPath: 'out.mp4' };
    });

    const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
      fps: 24,
      quality: 'draft',
      format: 'mp4',
    });
    await waitForJob(jobs, id, (job) => job.status === 'running');
    await coordinator.cancel(id);
    release();
    await waitForJob(jobs, id, (job) => job.status === 'cancelled');

    expect(events.find((event) => event.event === 'render_job_finished')).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('closes a job exactly once when the terminal job-store write rejects', async () => {
    // The JobStore is a seam — a Redis-backed one can reject a write that a
    // memory one never would. If the success event were emitted before that
    // write, the rejection would land in the catch and close the same job a
    // second time as 'failed', so one render would be counted as both a success
    // and a failure and every rate built on this stream would be wrong.
    const events: RenderEvent[] = [];
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const realUpdate = jobs.update.bind(jobs);
    jobs.update = async (id, patch) => {
      if (patch.status === 'succeeded') throw new Error('job store unavailable');
      return realUpdate(id, patch);
    };
    const coordinator = new RenderCoordinator(
      executor(async () => ({ status: 'succeeded', outputPath: 'out.mp4' })),
      jobs,
      artifacts,
      { onEvent: (event) => events.push(event) },
    );

    const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
      fps: 24,
      quality: 'draft',
      format: 'mp4',
    });
    await waitForJob(jobs, id, (job) => job.status === 'failed');

    const finished = events.filter((event) => event.event === 'render_job_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ jobId: id, outcome: 'failed' });
    expect(coordinator.trackedJobs).toBe(0);
  });

  it('separates the queue wait from the render itself on the finished event', async () => {
    const events: RenderEvent[] = [];
    const { coordinator, jobs } = coordinatorWith(events, async () => ({
      status: 'succeeded',
      outputPath: 'out.mp4',
    }));

    const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
      fps: 24,
      quality: 'draft',
      format: 'mp4',
    });
    await waitForJob(jobs, id, (job) => job.status === 'succeeded');

    const finished = events.find((event) => event.event === 'render_job_finished')!;
    // durationMs is submission-to-finish and therefore includes the wait; the
    // two components are reported so a consumer never has to join events to
    // tell a slow render from a long queue.
    expect(finished.durationMs).toBeGreaterThanOrEqual(
      (finished.queueWaitMs ?? 0) + (finished.renderMs ?? 0) - 2,
    );
    expect(typeof finished.queueWaitMs).toBe('number');
    expect(typeof finished.renderMs).toBe('number');
  });

  it('reports an idle service as having nothing queued behind the new job', async () => {
    const events: RenderEvent[] = [];
    const { coordinator, jobs } = coordinatorWith(events, async () => ({
      status: 'succeeded',
      outputPath: 'out.mp4',
    }));

    const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
      fps: 24,
      quality: 'draft',
      format: 'mp4',
    });
    await waitForJob(jobs, id, (job) => job.status === 'succeeded');

    // Counting the submitting job itself would make `queued` never reach 0 and
    // break the obvious "alert when queued > 0" rule.
    expect(events.find((event) => event.event === 'render_job_submitted')).toMatchObject({
      queued: 0,
      running: 0,
    });
  });

  it('closes the lifecycle for a job cancelled before it ever started', async () => {
    // Cancelling a queued job takes a different path from cancelling a running
    // one. If it skipped the finished event, a submitted job would simply never
    // be heard from again and any success rate built on these events would be
    // silently wrong.
    const events: RenderEvent[] = [];
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { coordinator, jobs } = coordinatorWith(
      events,
      async () => {
        await parked;
        return { status: 'succeeded', outputPath: 'out.mp4' };
      },
      // Two jobs in flight at once, so the second is genuinely queued rather
      // than rejected by the per-identity guard.
      { maxJobsPerUser: 0 },
    );
    const options = { fps: 24, quality: 'draft', format: 'mp4' } as const;

    // The first job takes the only execution slot; the second stays queued.
    const runningId = await coordinator.submit(
      coordinator.reserve('tester'),
      await projectDir(),
      options,
    );
    await waitForJob(jobs, runningId, (job) => job.status === 'running');
    const queuedId = await coordinator.submit(
      coordinator.reserve('tester'),
      await projectDir(),
      options,
    );

    await coordinator.cancel(queuedId);
    await waitForJob(jobs, queuedId, (job) => job.status === 'cancelled');

    const finished = events.filter((event) => event.event === 'render_job_finished');
    expect(finished).toContainEqual(
      expect.objectContaining({ jobId: queuedId, outcome: 'cancelled' }),
    );
    // Every submitted job reported a terminal event — that is what makes the
    // stream summable into a success rate.
    const submitted = events.filter((event) => event.event === 'render_job_submitted');
    expect(finished.map((event) => event.jobId)).toContain(queuedId);
    expect(submitted.some((event) => event.jobId === queuedId)).toBe(true);

    release();
    await waitForJob(jobs, runningId, (job) => job.status === 'succeeded');
  });

  it('does not retain per-job state after a job finishes', async () => {
    const events: RenderEvent[] = [];
    const { coordinator, jobs } = coordinatorWith(events, async () => ({
      status: 'succeeded',
      outputPath: 'out.mp4',
    }));

    for (let i = 0; i < 3; i += 1) {
      const id = await coordinator.submit(coordinator.reserve('tester'), await projectDir(), {
        fps: 24,
        quality: 'draft',
        format: 'mp4',
      });
      await waitForJob(jobs, id, (job) => job.status === 'succeeded');
    }

    const finished = events.filter((event) => event.event === 'render_job_finished');
    expect(finished).toHaveLength(3);
    // Observe the tracked state directly. Asserting only on the events would be
    // satisfied just as well by an implementation that never releases them.
    expect(coordinator.trackedJobs).toBe(0);
  });
});

describe('admission and preview route events', () => {
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
    };
  }

  function previewRequest(identity = 'preview-user'): Request {
    return new Request('http://test/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmaic-client': identity },
      body: JSON.stringify(previewPayload()),
    });
  }

  /**
   * Collect through the injected sink, not the console: that is the seam an
   * embedder uses, and asserting on it is what proves the route events honour
   * it rather than writing straight to stdout.
   */
  function captureEmitted(): RenderEvent[] {
    return [];
  }

  it('records the preview route status and duration for a served preview', async () => {
    const emitted = captureEmitted();
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const app = createApp({
      jobs,
      artifacts,
      coordinator: new RenderCoordinator(
        executor(async () => ({ status: 'succeeded', outputPath: 'out.mp4' })),
        jobs,
        artifacts,
      ),
      extractionGate: new Semaphore(1),
      previewRenderer: { render: async () => new Uint8Array([137, 80, 78, 71]) },
      onEvent: (event) => emitted.push(event),
    });

    const response = await app.fetch(previewRequest());
    expect(response.status).toBe(200);

    const preview = emitted.find((event) => event.event === 'preview_request');
    expect(preview).toMatchObject({ route: '/preview', status: 200 });
    expect(typeof preview!.durationMs).toBe('number');
  });

  it('records the real status when the preview route rejects, not just successes', async () => {
    const emitted = captureEmitted();
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const app = createApp({
      jobs,
      artifacts,
      coordinator: new RenderCoordinator(
        executor(async () => ({ status: 'succeeded', outputPath: 'out.mp4' })),
        jobs,
        artifacts,
      ),
      extractionGate: new Semaphore(1),
      previewRenderer: { render: async () => new Uint8Array([1]) },
      onEvent: (event) => emitted.push(event),
    });

    const response = await app.fetch(
      new Request('http://test/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"version":1}',
      }),
    );
    expect(response.status).toBe(400);

    expect(emitted.find((event) => event.event === 'preview_request')).toMatchObject({
      status: 400,
    });
  });

  it('records an export admission rejection with its machine-readable reason', async () => {
    const emitted = captureEmitted();
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore().store;
    const coordinator = new RenderCoordinator(
      executor(async () => ({ status: 'succeeded', outputPath: 'out.mp4' })),
      jobs,
      artifacts,
      { maxQueue: 1 },
    );
    const app = createApp({
      jobs,
      artifacts,
      coordinator,
      extractionGate: new Semaphore(1),
      onEvent: (event) => emitted.push(event),
    });

    const held = coordinator.reserve('exporter');
    const form = new FormData();
    form.append('project', new Blob([new Uint8Array(64)]), 'project.zip');
    const response = await app.fetch(
      new Request('http://test/render', {
        method: 'POST',
        body: form,
        headers: { 'x-openmaic-client': 'someone-else' },
      }),
    );
    expect(response.status).toBe(429);

    expect(emitted.find((event) => event.event === 'render_admission_rejected')).toMatchObject({
      route: '/render',
      reason: 'queue_full',
      status: 429,
    });
    coordinator.release(held);
  });
});
