/**
 * Job record shaping without a database: the pool is an in-memory stand-in
 * for the three statements the store issues (insert, merge update, read), so
 * what the poll route answers can be checked in every environment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerateClassroomResult } from '@/lib/server/classroom-generation';

const rows = vi.hoisted(() => new Map<string, { owner_id: string; record: object }>());

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: {
      async query(text: string, params: unknown[]) {
        const [id, second, third] = params as [string, string, string];
        if (text.startsWith('INSERT INTO classroom_generation_jobs')) {
          rows.set(id, { owner_id: second, record: JSON.parse(third) });
          return { rows: [] };
        }
        if (text.includes('UPDATE classroom_generation_jobs')) {
          const row = rows.get(id);
          if (!row) return { rows: [] };
          const current = row.record as { startedAt?: string };
          row.record = {
            ...current,
            ...JSON.parse(second),
            ...(current.startedAt ? { startedAt: current.startedAt } : {}),
          };
          return { rows: [{ record: row.record }] };
        }
        if (text.startsWith('SELECT owner_id, record FROM classroom_generation_jobs')) {
          const row = rows.get(id);
          return { rows: row ? [row] : [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
  }),
}));

vi.mock('@/lib/persistence/owner-merges', () => ({
  canonicalizeOwner: async (_queryable: unknown, ownerId: string) => ownerId,
}));

const INCOMPLETE_WARNING = 'TTS generation INCOMPLETE: 1 written, 2 speech actions left silent';

function classroomResult(extra: Partial<GenerateClassroomResult> = {}): GenerateClassroomResult {
  return {
    id: 'stage-cls1',
    url: 'http://localhost/classroom/stage-cls1',
    stage: { id: 'stage-cls1' } as GenerateClassroomResult['stage'],
    scenes: [],
    scenesCount: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...extra,
  };
}

describe('classroom generation job records', () => {
  beforeEach(() => rows.clear());

  it('keeps partial TTS coverage and its warning as the success message', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job1', { requirement: 'Teach' }, { ownerId: 'o' });
    await store.markClassroomGenerationJobSucceeded(
      'job1',
      classroomResult({ ttsCoverage: { written: 1, total: 3 }, warning: INCOMPLETE_WARNING }),
    );

    const job = await store.readClassroomGenerationJob('job1', 'o');
    expect(job?.message).toBe(INCOMPLETE_WARNING);
    expect(job?.result).toEqual({
      classroomId: 'stage-cls1',
      url: 'http://localhost/classroom/stage-cls1',
      scenesCount: 2,
      ttsCoverage: { written: 1, total: 3 },
      warning: INCOMPLETE_WARNING,
    });
  });

  it('answers a clean success with only the id, url and count, and the default message', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job2', { requirement: 'Teach' }, { ownerId: 'o' });
    await store.markClassroomGenerationJobSucceeded('job2', classroomResult());

    const job = await store.readClassroomGenerationJob('job2', 'o');
    expect(job).toMatchObject({ status: 'succeeded', step: 'completed', progress: 100 });
    expect(job?.message).toBe('Classroom generation completed');
    expect(job?.result).toEqual({
      classroomId: 'stage-cls1',
      url: 'http://localhost/classroom/stage-cls1',
      scenesCount: 2,
    });
  });

  it('keeps complete TTS coverage without a warning', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job3', { requirement: 'Teach' }, { ownerId: 'o' });
    await store.markClassroomGenerationJobSucceeded(
      'job3',
      classroomResult({ ttsCoverage: { written: 4, total: 4 } }),
    );

    const job = await store.readClassroomGenerationJob('job3', 'o');
    expect(job?.message).toBe('Classroom generation completed');
    expect(job?.result).toEqual({
      classroomId: 'stage-cls1',
      url: 'http://localhost/classroom/stage-cls1',
      scenesCount: 2,
      ttsCoverage: { written: 4, total: 4 },
    });
  });

  it('answers another owner as if the job did not exist', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job4', { requirement: 'Teach' }, { ownerId: 'o' });
    await expect(store.readClassroomGenerationJob('job4', 'someone-else')).resolves.toBeNull();
    await expect(store.readClassroomGenerationJob('missing', 'o')).resolves.toBeNull();
  });

  it('reports a running job with no progress for 30 minutes as failed', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job5', { requirement: 'Teach' }, { ownerId: 'o' });
    await store.markClassroomGenerationJobRunning('job5');
    const row = rows.get('job5')!;
    row.record = { ...row.record, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() };

    const job = await store.readClassroomGenerationJob('job5', 'o');
    expect(job).toMatchObject({ status: 'failed', step: 'failed' });
    expect(job?.error).toMatch(/Stale job/);
  });
});
