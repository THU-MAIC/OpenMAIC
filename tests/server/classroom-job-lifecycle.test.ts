import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type {
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import type { ClassroomGenerationJob } from '@/lib/server/classroom-job-store';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  processes: new Map<number, string>(),
  write: vi.fn(),
  generate: vi.fn(),
}));
function noEntry(): NodeJS.ErrnoException {
  return Object.assign(new Error('File not found'), { code: 'ENOENT' });
}
function stat(pid: number, ticks: string): string {
  return `${pid} (node with spaces) S ${Array(18).fill('0').join(' ')} ${ticks} 0 0`;
}
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async (file: string) => {
        if (file === '/proc/self/stat')
          return stat(process.pid, mocks.processes.get(process.pid) || '100');
        const proc = /^\/proc\/(\d+)\/stat$/.exec(file);
        if (proc) {
          const pid = Number(proc[1]);
          const ticks = mocks.processes.get(pid);
          if (!ticks) throw noEntry();
          return stat(pid, ticks);
        }
        const result = mocks.files.get(file);
        if (result === undefined) throw noEntry();
        return result;
      }),
    },
  };
});
vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOM_JOBS_DIR: '/test-private-jobs',
  ensureClassroomJobsDir: vi.fn(async () => {}),
  writeJsonFileAtomic: mocks.write,
  buildRequestOrigin: () => 'http://localhost',
}));
vi.mock('@/lib/server/classroom-generation', () => ({ generateClassroom: mocks.generate }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

const file = (jobId: string) => `/test-private-jobs/${jobId}.json`;
const input = (): GenerateClassroomInput => ({
  requirement: 'ORIGINAL EXACT code: a  b\n',
  pdfContent: { text: 'Evidence', images: ['fixture'] },
});
const result = (): GenerateClassroomResult =>
  ({
    id: 'classroom-result',
    url: 'http://localhost/classroom/classroom-result',
    scenesCount: 1,
    scenes: [],
    stage: {},
    createdAt: new Date().toISOString(),
  }) as unknown as GenerateClassroomResult;
const saved = (id: string): ClassroomGenerationJob => JSON.parse(mocks.files.get(file(id))!);
function put(id: string, value: ClassroomGenerationJob): void {
  mocks.files.set(file(id), JSON.stringify(value));
}
function legacy(id: string, status: ClassroomGenerationJob['status']): ClassroomGenerationJob {
  const now = new Date().toISOString();
  return {
    id,
    status,
    step:
      status === 'succeeded'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'queued'
            ? 'queued'
            : 'generating_scenes',
    progress: 25,
    message: 'Existing status',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    inputSummary: {
      requirementPreview: 'private original source',
      hasPdf: false,
      pdfTextLength: 0,
      pdfImageCount: 0,
    },
    scenesGenerated: 0,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  delete (globalThis as typeof globalThis & { __openmaicClassroomJobRuntimeV1?: unknown })
    .__openmaicClassroomJobRuntimeV1;
  mocks.files.clear();
  mocks.processes.clear();
  mocks.processes.set(process.pid, '100');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T02:00:00Z'));
  mocks.write.mockImplementation(async (p: string, data: unknown) => {
    mocks.files.set(p, JSON.stringify(data));
  });
  mocks.generate.mockResolvedValue(result());
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (mocks.processes.has(Number(pid))) return true;
    throw Object.assign(new Error('Missing process'), { code: 'ESRCH' });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as typeof globalThis & { __openmaicClassroomJobRuntimeV1?: unknown })
    .__openmaicClassroomJobRuntimeV1;
});

describe('native classroom source-bound job lifecycle', () => {
  test('concurrent calls share exactly one Promise and use a detached input captured before any await', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const runner = await import('@/lib/server/classroom-job-runner');
    const source = input();
    await store.createClassroomGenerationJob('same', source);
    let finish!: (value: GenerateClassroomResult) => void;
    mocks.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = runner.runClassroomGenerationJob('same', source, 'http://localhost');
    const second = runner.runClassroomGenerationJob('same', source, 'http://localhost');
    expect(second).toBe(first);
    source.requirement = 'mutated caller source';
    source.pdfContent!.images[0] = 'mutated caller evidence';
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    expect(mocks.generate.mock.calls[0][0]).toEqual(input());
    finish(result());
    await first;
    expect(saved('same').status).toBe('succeeded');
    await runner.runClassroomGenerationJob('same', input(), 'http://localhost');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  test('route/runner module reloads retain the same in-process running Promise', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('bundles', input());
    const firstModule = await import('@/lib/server/classroom-job-runner');
    let finish!: (value: GenerateClassroomResult) => void;
    mocks.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = firstModule.runClassroomGenerationJob('bundles', input(), 'http://localhost');
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    vi.resetModules();
    const secondModule = await import('@/lib/server/classroom-job-runner');
    expect(secondModule.runClassroomGenerationJob('bundles', input(), 'http://localhost')).toBe(
      first,
    );
    finish(result());
    await first;
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  test.each(['succeeded', 'failed'] as const)(
    'existing %s jobs cannot restart or be overwritten by late updates',
    async (status) => {
      const store = await import('@/lib/server/classroom-job-store');
      const runner = await import('@/lib/server/classroom-job-runner');
      const job = legacy('terminal', status);
      job.result = {
        classroomId: 'old-success',
        url: 'http://localhost/old-success',
        scenesCount: 1,
      };
      job.error = 'Original terminal reason';
      put('terminal', job);
      const bytes = mocks.files.get(file('terminal'));
      await runner.runClassroomGenerationJob('terminal', input(), 'http://localhost');
      await store.markClassroomGenerationJobRunning('terminal', input());
      await store.updateClassroomGenerationJobProgress('terminal', {
        step: 'generating_scenes',
        progress: 60,
        message: 'Late progress',
        scenesGenerated: 2,
      });
      await store.markClassroomGenerationJobSucceeded('terminal', result());
      await store.markClassroomGenerationJobFailed('terminal', 'Late error');
      await expect(store.createClassroomGenerationJob('terminal', input())).rejects.toThrow(
        'already exists',
      );
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.files.get(file('terminal'))).toBe(bytes);
    },
  );

  test('source strings and nested evidence are digest-bound; mismatches fail without calling generation', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const runner = await import('@/lib/server/classroom-job-runner');
    const original = input();
    await store.createClassroomGenerationJob('mismatch', original);
    const wrong = input();
    wrong.requirement = original.requirement.replace('a  b', 'a b');
    await runner.runClassroomGenerationJob('mismatch', wrong, 'http://localhost');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(saved('mismatch').status).toBe('failed');
    expect(saved('mismatch').error).toBe(
      'Classroom generation input does not match the queued source',
    );
    expect(saved('mismatch').error).not.toContain(original.requirement);
    await store.createClassroomGenerationJob('nested', original);
    const changed = input();
    changed.pdfContent!.images[0] = 'changed';
    await expect(store.markClassroomGenerationJobRunning('nested', changed)).rejects.toThrow(
      'does not match',
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  test('semantically identical key ordering is accepted without changing source bytes', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('order', input());
    const reordered = {
      pdfContent: { images: ['fixture'], text: 'Evidence' },
      requirement: input().requirement,
    };
    expect(await store.markClassroomGenerationJobRunning('order', reordered)).toMatchObject({
      status: 'running',
    });
    store.releaseClassroomGenerationJobRunner('order');
  });

  test('a late generation success cannot replace a failed terminal job', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const runner = await import('@/lib/server/classroom-job-runner');
    await store.createClassroomGenerationJob('late', input());
    let finish!: (value: GenerateClassroomResult) => void;
    mocks.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = runner.runClassroomGenerationJob('late', input(), 'http://localhost');
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    await store.markClassroomGenerationJobFailed('late', 'First terminal failure');
    const bytes = mocks.files.get(file('late'));
    await expect(
      mocks.generate.mock.calls[0][1].onProgress({
        step: 'generating_scenes',
        progress: 80,
        message: 'Late progress',
        scenesGenerated: 3,
      }),
    ).rejects.toThrow('no longer active');
    finish(result());
    await running;
    expect(mocks.files.get(file('late'))).toBe(bytes);
    await runner.runClassroomGenerationJob('late', input(), 'http://localhost');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  test('source digest and owner metadata cannot be changed through generic progress patches', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('fields', input());
    await store.markClassroomGenerationJobRunning('fields', input());
    const bytes = mocks.files.get(file('fields'));
    const old = saved('fields');
    await store.updateClassroomGenerationJob('fields', {
      id: 'other',
      sourceDigest: 'different',
      executionOwner: { instanceId: 'different', pid: 1 },
      inputSummary: { ...old.inputSummary, requirementPreview: 'changed' },
    });
    expect(mocks.files.get(file('fields'))).toBe(bytes);
    store.releaseClassroomGenerationJobRunner('fields');
  });

  test('a genuinely active local job is not expired merely because progress is quiet', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('active', input());
    await store.markClassroomGenerationJobRunning('active', input());
    vi.setSystemTime(new Date('2026-10-15T02:10:00Z'));
    expect(await store.readClassroomGenerationJob('active')).toMatchObject({ status: 'running' });
    store.releaseClassroomGenerationJobRunner('active');
    expect(await store.readClassroomGenerationJob('active')).toMatchObject({
      status: 'failed',
      step: 'failed',
      error: expect.stringContaining('no longer has an active runner'),
    });
  });

  test('jobs from a dead owner process fail promptly without an automatic second generation', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const runner = await import('@/lib/server/classroom-job-runner');
    for (const status of ['queued', 'running'] as const) {
      const id = `dead-${status}`;
      const job = legacy(id, status);
      job.executionOwner = { instanceId: 'old-instance', pid: 91919, processStartTicks: '100' };
      put(id, job);
      const bytes = mocks.files.get(file(id));
      expect(await store.readClassroomGenerationJob(id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('server restart'),
      });
      await runner.runClassroomGenerationJob(id, input(), 'http://localhost');
      expect(mocks.files.get(file(id))).toBe(bytes);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform !== 'linux')(
    'PID reuse is distinguished by Linux process-start ticks',
    async () => {
      const store = await import('@/lib/server/classroom-job-store');
      const job = legacy('reused', 'running');
      job.executionOwner = { instanceId: 'old-instance', pid: 91919, processStartTicks: '100' };
      mocks.processes.set(91919, '200');
      put('reused', job);
      expect(await store.readClassroomGenerationJob('reused')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('server restart'),
      });
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );

  test('another live worker is preserved and cannot be claimed by this instance', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const runner = await import('@/lib/server/classroom-job-runner');
    for (const status of ['queued', 'running'] as const) {
      const id = `live-${status}`;
      const job = legacy(id, status);
      job.executionOwner = {
        instanceId: 'other-live-instance',
        pid: 91919,
        processStartTicks: '100',
      };
      mocks.processes.set(91919, '100');
      put(id, job);
      expect(await store.readClassroomGenerationJob(id)).toMatchObject({ status });
      expect(await store.markClassroomGenerationJobRunning(id, input())).toBeNull();
      await runner.runClassroomGenerationJob(id, input(), 'http://localhost');
      expect(saved(id).status).toBe(status);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  test('legacy queued/running records have bounded failure views without modifying terminal history', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    put('legacy-queued', legacy('legacy-queued', 'queued'));
    put('legacy-running', legacy('legacy-running', 'running'));
    const success = legacy('legacy-success', 'succeeded');
    success.createdAt = '2000-01-01T00:00:00Z';
    put('legacy-success', success);
    expect(await store.readClassroomGenerationJob('legacy-queued')).toMatchObject({
      status: 'queued',
    });
    vi.setSystemTime(new Date('2026-10-15T02:02:01Z'));
    expect(await store.readClassroomGenerationJob('legacy-queued')).toMatchObject({
      status: 'failed',
    });
    expect(await store.readClassroomGenerationJob('legacy-running')).toMatchObject({
      status: 'running',
    });
    vi.setSystemTime(new Date('2026-10-15T02:14:01Z'));
    expect(await store.readClassroomGenerationJob('legacy-running')).toMatchObject({
      status: 'failed',
    });
    expect(await store.readClassroomGenerationJob('legacy-success')).toEqual(success);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  test('malformed/far-future legacy time cannot leave a task pending indefinitely', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    for (const status of ['queued', 'running'] as const) {
      const job = legacy(`bad-${status}`, status);
      job.createdAt = 'invalid';
      job.startedAt = 'invalid';
      put(job.id, job);
      expect(await store.readClassroomGenerationJob(job.id)).toMatchObject({ status: 'failed' });
      job.createdAt = '2099-01-01T00:00:00Z';
      job.startedAt = job.createdAt;
      put(job.id, job);
      expect(await store.readClassroomGenerationJob(job.id)).toMatchObject({ status: 'failed' });
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });

  test('the unchanged GET route reports interrupted done/error without exposing private source or lifecycle metadata', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const job = await store.createClassroomGenerationJob('get-dead', input());
    job.executionOwner = { instanceId: 'old-instance', pid: 91919, processStartTicks: '100' };
    put(job.id, job);
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
    const response = await GET({} as NextRequest, { params: Promise.resolve({ jobId: job.id }) });
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      jobId: job.id,
      status: 'failed',
      step: 'failed',
      done: true,
      error: expect.stringContaining('server restart'),
      pollIntervalMs: 5000,
    });
    expect(body).not.toHaveProperty('executionOwner');
    expect(body).not.toHaveProperty('sourceDigest');
    expect(body).not.toHaveProperty('inputSummary');
    expect(JSON.stringify(body)).not.toContain('ORIGINAL EXACT');
  });
});
