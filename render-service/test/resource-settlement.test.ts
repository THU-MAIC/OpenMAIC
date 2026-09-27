import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RenderCoordinator } from '../src/render-coordinator.js';
import { InMemoryJobStore } from '../src/job-store.js';
import { createMemoryArtifactStore, createMemoryJobStore } from './support/fakes.js';
import type { RenderExecutor } from '../src/render-executor.js';
import type { ArtifactStore } from '../src/artifact-store.js';
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

it.each([
  ['confirmed cleanup', true, true, false],
  ['unconfirmed cleanup', false, false, true],
] as const)(
  'preserves a committed publication across late cancellation with %s',
  async (_label, cleanupVerified, reservationReturned, admissionClosed) => {
    const jobs = createMemoryJobStore();
    const artifacts = createMemoryArtifactStore();
    let accepting = true;
    let started!: () => void;
    const publicationReady = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settle!: () => void;
    const resources: RenderResourceSettlement = {
      published: true,
      cleanupVerified,
      reservationReturned,
      admissionClosed,
      details: { publication: { directoryFsync: true } },
    };
    const executor: RenderExecutor = {
      accepting: () => accepting,
      async execute(request) {
        await writeFile(request.outputPath, 'published-after-cancel');
        started();
        return new Promise<RenderExecutionResult>((resolve) => {
          settle = () => {
            if (admissionClosed) accepting = false;
            resolve({ status: 'succeeded', resources });
          };
        });
      },
    };
    const coordinator = new RenderCoordinator(executor, jobs, artifacts.store, {
      onEvent: () => {},
    });
    const dir = await directory();
    const id = await coordinator.submit(coordinator.reserve('late-resource'), dir, options);
    await publicationReady;

    expect(await coordinator.cancel(id)).toBe(true);
    settle();

    const job = await finish(jobs, id);
    expect(job).toMatchObject({ status: 'succeeded', resources });
    expect(await artifacts.store.locate(id)).toEqual({
      kind: 'file',
      path: join(dir, 'output.mp4'),
    });
    await expect(readFile(join(dir, 'output.mp4'), 'utf8')).resolves.toBe('published-after-cancel');

    if (admissionClosed) {
      await coordinator.cleanupProject(dir);
      await expect(access(dir)).resolves.toBeUndefined();
      await expect(readFile(join(dir, 'output.mp4'), 'utf8')).resolves.toBe(
        'published-after-cancel',
      );
      expect(coordinator.accepting).toBe(false);
      expect(() => coordinator.reserve('blocked-after-quarantine')).toThrow('resource owner');
    }
  },
);

it('preserves a committed publication when bookkeeping fails after a late cancel', async () => {
  const jobs = createMemoryJobStore();
  const paths = new Map<string, string>();
  let enteredPut!: () => void;
  const putStarted = new Promise<void>((resolve) => {
    enteredPut = resolve;
  });
  let rejectPut!: (error: Error) => void;
  const putBlocked = new Promise<never>((_resolve, reject) => {
    rejectPut = reject;
  });
  const remove = vi.fn(async (id: string) => {
    paths.delete(id);
  });
  const artifacts: ArtifactStore = {
    async put(id, path) {
      paths.set(id, path);
      enteredPut();
      return putBlocked;
    },
    async locate(id) {
      const path = paths.get(id);
      return path ? { kind: 'file', path } : null;
    },
    remove,
  };
  const resources: RenderResourceSettlement = {
    published: true,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
  };
  const executor: RenderExecutor = {
    async execute(request) {
      await writeFile(request.outputPath, 'committed-before-bookkeeping');
      return { status: 'succeeded', resources };
    },
  };
  const coordinator = new RenderCoordinator(executor, jobs, artifacts, { onEvent: () => {} });
  const dir = await directory();
  const id = await coordinator.submit(coordinator.reserve('bookkeeping'), dir, options);
  await putStarted;

  expect(await coordinator.cancel(id)).toBe(true);
  rejectPut(new Error('artifact registration failed'));

  const job = await finish(jobs, id);
  expect(job).toMatchObject({
    status: 'failed',
    failure: { code: 'execution_failed', message: 'artifact registration failed' },
    resources,
  });
  expect(remove).not.toHaveBeenCalled();
  await expect(artifacts.locate(id)).resolves.toEqual({
    kind: 'file',
    path: join(dir, 'output.mp4'),
  });
  await expect(readFile(join(dir, 'output.mp4'), 'utf8')).resolves.toBe(
    'committed-before-bookkeeping',
  );
  await expect(access(dir)).resolves.toBeUndefined();
  await coordinator.cleanupProject(dir);
  await expect(access(dir)).rejects.toThrow();
});

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

it.each([
  [false, false, true],
  [false, true, true],
  [true, false, true],
  [true, true, false],
] as const)(
  'TTL retention: cleanup=%s returned=%s retains=%s',
  async (cleanupVerified, reservationReturned, keep) => {
    vi.useFakeTimers();
    const reap = vi.fn();
    const store = new InMemoryJobStore(100, reap);
    await store.create({
      id: 'settled',
      status: 'failed',
      progress: 0,
      currentStage: 'failed',
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      projectDir: '/work/render',
      resources: { ...retained, cleanupVerified, reservationReturned },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await store.get('settled')) !== null).toBe(keep);
    expect(reap).toHaveBeenCalledTimes(keep ? 0 : 1);
  },
);
it('keeps default-executor TTL cleanup when no resource settlement exists', async () => {
  vi.useFakeTimers();
  const reap = vi.fn();
  const store = new InMemoryJobStore(100, reap);
  await store.create({
    id: 'legacy',
    status: 'failed',
    progress: 0,
    currentStage: 'failed',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    projectDir: '/work/render',
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await store.get('legacy')).toBeNull();
  expect(reap).toHaveBeenCalledOnce();
});

it('contains a repeated settlement store failure without deleting a committed artifact', async () => {
  const jobs = createMemoryJobStore();
  const originalUpdate = jobs.update.bind(jobs);
  const update = vi.spyOn(jobs, 'update').mockImplementation(async (id, patch) => {
    if (patch.status === 'succeeded' || patch.status === 'failed')
      throw new Error('store unavailable');
    return originalUpdate(id, patch);
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const artifacts = createMemoryArtifactStore();
  const resources: RenderResourceSettlement = {
    published: true,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
  };
  const executor: RenderExecutor = {
    async execute(request) {
      await writeFile(request.outputPath, 'committed');
      return { status: 'succeeded', resources };
    },
  };
  const coordinator = new RenderCoordinator(executor, jobs, artifacts.store, { onEvent: () => {} });
  const dir = await directory();
  try {
    const id = await coordinator.submit(coordinator.reserve('recovery-failure'), dir, options);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(update.mock.calls.filter(([, patch]) => patch.status === 'failed')).toHaveLength(1);
    await expect(artifacts.store.locate(id)).resolves.toMatchObject({
      path: join(dir, 'output.mp4'),
    });
    expect(await readFile(join(dir, 'output.mp4'), 'utf8')).toBe('committed');
  } finally {
    log.mockRestore();
    update.mockRestore();
  }
});
