import { describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  examMutationLockKey,
  postgresExamMutationLock,
} from '@/lib/server/zhongkao/exam-mutation-lock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordingPool() {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const release = vi.fn();
  const client = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, ...(params === undefined ? {} : { params }) });
      return { rows: [] };
    },
    release,
  };
  const pool = {
    query: client.query,
    connect: vi.fn(async () => client),
  } as unknown as ConnectableQueryable;
  return { pool, queries, release };
}

describe('PostgreSQL Exam mutation lock', () => {
  it('uses one domain-separated key and keeps the transaction open until work settles', async () => {
    const examSessionId = `exam:v1:${'a'.repeat(64)}`;
    const expectedKey = `zhongkao-exam:${examSessionId}:mutation`;
    const { pool, queries, release } = recordingPool();
    const workStarted = deferred();
    const releaseWork = deferred();
    const work = vi.fn(async () => {
      workStarted.resolve();
      await releaseWork.promise;
      return 'finished';
    });

    expect(examMutationLockKey(examSessionId)).toBe(expectedKey);
    expect(examMutationLockKey(examSessionId)).not.toBe(
      examMutationLockKey(`exam:v1:${'b'.repeat(64)}`),
    );

    const result = postgresExamMutationLock(pool)(examSessionId, work);
    await workStarted.promise;

    expect(queries).toEqual([
      { text: 'BEGIN' },
      {
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        params: [expectedKey],
      },
    ]);
    expect(release).not.toHaveBeenCalled();

    releaseWork.resolve();
    await expect(result).resolves.toBe('finished');
    expect(work).toHaveBeenCalledOnce();
    expect(queries).toEqual([
      { text: 'BEGIN' },
      {
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        params: [expectedKey],
      },
      { text: 'COMMIT' },
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the lock connection when work rejects', async () => {
    const { pool, queries, release } = recordingPool();
    const failure = new Error('injected mutation failure');

    await expect(
      postgresExamMutationLock(pool)(`exam:v1:${'c'.repeat(64)}`, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(queries.map(({ text }) => text)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('never enters mutation work when the advisory lock cannot be acquired', async () => {
    const failure = new Error('injected advisory lock failure');
    const release = vi.fn();
    const work = vi.fn(async () => 'must-not-run');
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes('pg_advisory_xact_lock')) throw failure;
        return { rows: [] };
      },
      release,
    };
    const pool = {
      query: client.query,
      connect: vi.fn(async () => client),
    } as unknown as ConnectableQueryable;

    await expect(postgresExamMutationLock(pool)(`exam:v1:${'d'.repeat(64)}`, work)).rejects.toBe(
      failure,
    );

    expect(work).not.toHaveBeenCalled();
    expect(queries).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
