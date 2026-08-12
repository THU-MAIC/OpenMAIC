import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobStore } from '../src/job-store.js';
import { RenderCoordinator } from '../src/render-coordinator.js';
import type { RenderExecutor } from '../src/render-executor.js';
import type {
  RenderExecutionRequest,
  RenderExecutionResult,
  RenderJobRecord,
} from '../src/types.js';
import { createMemoryArtifactStore, createMemoryJobStore } from './support/fakes.js';

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeExecutor implements RenderExecutor {
  readonly requests: RenderExecutionRequest[] = [];

  constructor(
    private readonly handler: (request: RenderExecutionRequest) => Promise<RenderExecutionResult>,
  ) {}

  async execute(request: RenderExecutionRequest): Promise<RenderExecutionResult> {
    this.requests.push(request);
    return this.handler(request);
  }
}

async function projectDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'render-coordinator-'));
  scratch.push(path);
  return path;
}

async function waitForJob(
  jobs: JobStore,
  id: string,
  predicate: (job: RenderJobRecord) => boolean,
): Promise<RenderJobRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await jobs.get(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

const renderOptions = { fps: 30, quality: 'standard', format: 'mp4' } as const;

describe('RenderCoordinator through the RenderExecutor seam', () => {
  it('persists normalized progress, performance, and the artifact on success', async () => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const performance = {
      totalElapsedMs: 800,
      stages: { captureMs: 600 },
      workers: 1,
      totalFrames: 30,
      captureMode: 'beginframe',
    };
    const executor = new FakeExecutor(async (request) => {
      await request.onProgress({
        progress: 0.5,
        stage: 'capturing',
        framesRendered: 15,
        totalFrames: 30,
      });
      return { status: 'succeeded', performance };
    });
    const coordinator = new RenderCoordinator(executor, jobs, artifacts.store, {
      jobDeadlineMs: 12_345,
    });
    const dir = await projectDir();
    const id = await coordinator.submit(coordinator.reserve('alice'), dir, renderOptions);

    const job = await waitForJob(jobs, id, (current) => current.status === 'succeeded');
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0].deadlineMs).toBe(12_345);
    expect(job).toMatchObject({
      status: 'succeeded',
      progress: 1,
      currentStage: 'complete',
      framesRendered: 15,
      totalFrames: 30,
      performance,
    });
    expect(artifacts.paths.get(id)).toBe(join(dir, 'output.mp4'));
  });

  it('routes running-job cancellation through the executor signal and cleans up', async () => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const executor = new FakeExecutor(
      (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener('abort', () => {
            resolve({
              status: 'cancelled',
              failure: { code: 'cancelled', message: 'Render cancelled' },
            });
          });
        }),
    );
    const coordinator = new RenderCoordinator(executor, jobs, artifacts.store);
    const dir = await projectDir();
    const id = await coordinator.submit(coordinator.reserve('bob'), dir, renderOptions);
    await waitForJob(jobs, id, () => executor.requests.length === 1);

    expect(await coordinator.cancel(id)).toBe(true);
    const job = await waitForJob(jobs, id, (current) => current.status === 'cancelled');
    expect(job.failure).toEqual({ code: 'cancelled', message: 'Render cancelled' });
    await expect(access(dir)).rejects.toThrow();
  });

  it('keeps deadline failure classification from a replaceable executor', async () => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const executor = new FakeExecutor(async () => ({
      status: 'failed',
      failure: { code: 'deadline_exceeded', message: 'Render exceeded the deadline' },
    }));
    const coordinator = new RenderCoordinator(executor, jobs, artifacts.store, {
      jobDeadlineMs: 42,
    });
    const dir = await projectDir();
    const id = await coordinator.submit(coordinator.reserve('carol'), dir, renderOptions);

    const job = await waitForJob(jobs, id, (current) => current.status === 'failed');
    expect(executor.requests[0].deadlineMs).toBe(42);
    expect(job).toMatchObject({
      status: 'failed',
      error: 'Render exceeded the deadline',
      failure: { code: 'deadline_exceeded' },
    });
    expect(artifacts.paths.has(id)).toBe(false);
    await expect(access(dir)).rejects.toThrow();
  });

  it('classifies unexpected executor errors and still performs cleanup', async () => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    const executor = new FakeExecutor(async () => {
      throw new Error('executor unavailable');
    });
    const coordinator = new RenderCoordinator(executor, jobs, artifacts.store);
    const dir = await projectDir();
    const id = await coordinator.submit(coordinator.reserve('dana'), dir, renderOptions);

    const job = await waitForJob(jobs, id, (current) => current.status === 'failed');
    expect(job).toMatchObject({
      error: 'executor unavailable',
      failure: { code: 'execution_failed', message: 'executor unavailable' },
    });
    await expect(access(dir)).rejects.toThrow();
  });
});
