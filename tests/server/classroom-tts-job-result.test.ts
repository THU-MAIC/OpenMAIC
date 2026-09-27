import { promises as fs } from 'fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { GenerateClassroomResult } from '@/lib/server/classroom-generation';

const jobsDir = vi.hoisted(() => `/tmp/openmaic-1567-jobs-${process.pid}-${Date.now()}`);

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  const { promises: fsPromises } = await import('node:fs');
  return {
    ...actual,
    CLASSROOM_JOBS_DIR: jobsDir,
    ensureClassroomJobsDir: async () => {
      await fsPromises.mkdir(jobsDir, { recursive: true });
    },
  };
});

const INCOMPLETE_WARNING = 'TTS generation INCOMPLETE: 1 written, 2 speech actions left silent';

function classroomResult(extra: Partial<GenerateClassroomResult> = {}): GenerateClassroomResult {
  return {
    id: 'cls1',
    url: 'http://localhost/classroom/cls1',
    stage: { id: 'cls1' } as GenerateClassroomResult['stage'],
    scenes: [],
    scenesCount: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...extra,
  };
}

async function loadJobStore() {
  return import('@/lib/server/classroom-job-store');
}

describe('classroom generation job TTS coverage', () => {
  beforeEach(async () => {
    vi.resetModules();
    await fs.rm(jobsDir, { recursive: true, force: true });
    await fs.mkdir(jobsDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(jobsDir, { recursive: true, force: true });
  });

  it('persists partial TTS coverage on a succeeded job and changes the success message', async () => {
    const {
      createClassroomGenerationJob,
      markClassroomGenerationJobSucceeded,
      readClassroomGenerationJob,
    } = await loadJobStore();

    await createClassroomGenerationJob('jobtts1', { requirement: 'Teach pacing' });
    await markClassroomGenerationJobSucceeded(
      'jobtts1',
      classroomResult({
        ttsCoverage: { written: 1, total: 3 },
        warning: INCOMPLETE_WARNING,
      }),
    );

    const job = await readClassroomGenerationJob('jobtts1');
    expect(job?.status).toBe('succeeded');
    expect(job?.message).toBe(INCOMPLETE_WARNING);
    expect(job?.result).toEqual({
      classroomId: 'cls1',
      url: 'http://localhost/classroom/cls1',
      scenesCount: 2,
      ttsCoverage: { written: 1, total: 3 },
      warning: INCOMPLETE_WARNING,
    });
  });

  it('persists complete TTS coverage without replacing the success message', async () => {
    const {
      createClassroomGenerationJob,
      markClassroomGenerationJobSucceeded,
      readClassroomGenerationJob,
    } = await loadJobStore();

    await createClassroomGenerationJob('jobtts4', { requirement: 'Teach pacing' });
    await markClassroomGenerationJobSucceeded(
      'jobtts4',
      classroomResult({ ttsCoverage: { written: 4, total: 4 } }),
    );

    const job = await readClassroomGenerationJob('jobtts4');
    expect(job?.status).toBe('succeeded');
    expect(job?.message).toBe('Classroom generation completed');
    expect(job?.result).toEqual({
      classroomId: 'cls1',
      url: 'http://localhost/classroom/cls1',
      scenesCount: 2,
      ttsCoverage: { written: 4, total: 4 },
    });
    expect(job?.result).not.toHaveProperty('warning');
  });

  it('leaves a clean success unchanged when TTS coverage is absent', async () => {
    const {
      createClassroomGenerationJob,
      markClassroomGenerationJobSucceeded,
      readClassroomGenerationJob,
    } = await loadJobStore();

    await createClassroomGenerationJob('jobtts2', { requirement: 'Teach pacing' });
    await markClassroomGenerationJobSucceeded('jobtts2', classroomResult());

    const job = await readClassroomGenerationJob('jobtts2');
    expect(job?.status).toBe('succeeded');
    expect(job?.message).toBe('Classroom generation completed');
    expect(job?.result).toEqual({
      classroomId: 'cls1',
      url: 'http://localhost/classroom/cls1',
      scenesCount: 2,
    });
  });

  it('returns persisted TTS coverage from the job poll route', async () => {
    const { createClassroomGenerationJob, markClassroomGenerationJobSucceeded } =
      await loadJobStore();
    await createClassroomGenerationJob('jobtts3', { requirement: 'Teach pacing' });
    await markClassroomGenerationJobSucceeded(
      'jobtts3',
      classroomResult({
        ttsCoverage: { written: 1, total: 3 },
        warning: INCOMPLETE_WARNING,
      }),
    );

    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
    const response = await GET(new NextRequest('http://localhost/api/generate-classroom/jobtts3'), {
      params: Promise.resolve({ jobId: 'jobtts3' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('succeeded');
    expect(body.message).toBe(INCOMPLETE_WARNING);
    expect(body.result).toMatchObject({
      ttsCoverage: { written: 1, total: 3 },
      warning: INCOMPLETE_WARNING,
    });
  });
});
