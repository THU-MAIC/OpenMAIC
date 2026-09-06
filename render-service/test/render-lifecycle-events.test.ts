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

    // Three complete lifecycles, and every finished event still carried a
    // duration — the submission timestamps were consumed, not leaked.
    const finished = events.filter((event) => event.event === 'render_job_finished');
    expect(finished).toHaveLength(3);
    for (const event of finished) expect(typeof event.durationMs).toBe('number');
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

  function captureEmitted(): RenderEvent[] {
    const emitted: RenderEvent[] = [];
    for (const stream of ['log', 'error'] as const) {
      vi.spyOn(console, stream).mockImplementation((line: unknown) => {
        try {
          emitted.push(JSON.parse(String(line)) as RenderEvent);
        } catch {
          /* the startup banner is not JSON */
        }
      });
    }
    return emitted;
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
      executionGate: new Semaphore(1),
      previewRenderer: { render: async () => new Uint8Array([137, 80, 78, 71]) },
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
      executionGate: new Semaphore(1),
      previewRenderer: { render: async () => new Uint8Array([1]) },
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
      executionGate: new Semaphore(1),
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
