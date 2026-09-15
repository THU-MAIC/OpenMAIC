import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RenderCoordinator } from '../src/render-coordinator.js';
import { InMemoryJobStore } from '../src/job-store.js';
import { createMemoryArtifactStore, createMemoryJobStore } from './support/fakes.js';
import type { RenderExecutor } from '../src/render-executor.js';
import type { RenderExecutionResult, RenderResourceSettlement } from '../src/types.js';
const directories: string[] = [];
const options = { fps: 30, quality: 'standard', format: 'mp4' } as const;
const retained: RenderResourceSettlement = {
  published: false,
  cleanupVerified: false,
  reservationReturned: false,
  admissionClosed: true,
  details: { residual: { memoryCurrent: '500000' } },
};
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'openmaic-settlement-'));
  directories.push(dir);
  return dir;
}
async function finish(jobs: ReturnType<typeof createMemoryJobStore>, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await jobs.get(id);
    if (job && ['succeeded', 'failed'].includes(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Job did not settle');
}
it.each(['failed', 'succeeded'] as const)(
  'retains quarantined objects and accounting after %s, including TTL cleanup calls',
  async (status) => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    let accepting = true;
    const executor: RenderExecutor = {
      accepting: () => accepting,
      async execute() {
        accepting = false;
        const resources = { ...retained, published: status === 'succeeded' };
        return status === 'succeeded'
          ? { status, resources }
          : {
              status,
              failure: { code: 'execution_failed', message: 'cleanup unverified' },
              resources,
            };
      },
    };
    const coordinator = new RenderCoordinator(executor, jobs, artifacts.store, {
      onEvent: () => {},
    });
    const dir = await directory();
    const id = await coordinator.submit(coordinator.reserve('one'), dir, options);
    const job = await finish(jobs, id);
    expect(job.resources).toMatchObject({ reservationReturned: false, details: retained.details });
    await coordinator.cleanupProject(dir);
    await expect(access(dir)).resolves.toBeUndefined();
    expect(coordinator.accepting).toBe(false);
    expect(() => coordinator.reserve('two')).toThrow('resource owner');
    if (status === 'succeeded')
      expect(await artifacts.store.locate(id)).toMatchObject({ path: join(dir, 'output.mp4') });
  },
);
it('rejects a queued job without launching when the owner becomes unavailable', async () => {
  const jobs = createMemoryJobStore();
  const artifacts = createMemoryArtifactStore();
  let accepting = true;
  let settle!: (value: RenderExecutionResult) => void;
  const execute = vi.fn(
    () =>
      new Promise<RenderExecutionResult>((resolve) => {
        settle = resolve;
      }),
  );
  const coordinator = new RenderCoordinator(
    { execute, accepting: () => accepting },
    jobs,
    artifacts.store,
    { maxJobsPerUser: 0, onEvent: () => {} },
  );
  const a = await directory();
  const b = await directory();
  const first = await coordinator.submit(coordinator.reserve('a'), a, options);
  for (let i = 0; i < 20 && !settle; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await coordinator.submit(coordinator.reserve('b'), b, options);
  accepting = false;
  settle({
    status: 'failed',
    failure: { code: 'execution_failed', message: 'owner lost' },
    resources: retained,
  });
  await finish(jobs, first);
  await finish(jobs, second);
  expect(execute).toHaveBeenCalledOnce();
  await expect(access(a)).resolves.toBeUndefined();
  await expect(access(b)).rejects.toThrow();
});
it('preserves the quarantine record across the job TTL', async () => {
  vi.useFakeTimers();
  const reap = vi.fn();
  const store = new InMemoryJobStore(100, reap);
  await store.create({
    id: 'retained',
    status: 'failed',
    progress: 0,
    currentStage: 'failed',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    projectDir: '/work/render',
    resources: retained,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await store.get('retained')).not.toBeNull();
  expect(reap).not.toHaveBeenCalled();
});
