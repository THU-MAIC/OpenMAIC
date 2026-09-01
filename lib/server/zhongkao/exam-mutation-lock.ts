import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';

export type ExamMutationLock = <T>(examSessionId: string, work: () => Promise<T>) => Promise<T>;

export function examMutationLockKey(examSessionId: string): string {
  return `zhongkao-exam:${examSessionId}:mutation`;
}

/** Serialize all byte and event mutations for one Exam without adding DDL. */
export function postgresExamMutationLock(queryable: ConnectableQueryable): ExamMutationLock {
  const withTransaction = nodePostgresTransaction(queryable);
  return async <T>(examSessionId: string, work: () => Promise<T>): Promise<T> =>
    withTransaction(async (transaction) => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        examMutationLockKey(examSessionId),
      ]);
      return work();
    });
}

interface ExamLockPoolState {
  connectionString?: string;
  pool?: Pool;
  lock?: ExamMutationLock;
}

const EXAM_LOCK_POOL_STATE_KEY = Symbol.for('openmaic.zhongkao.exam-lock-pool');
const globalState = globalThis as typeof globalThis & {
  [EXAM_LOCK_POOL_STATE_KEY]?: ExamLockPoolState;
};
const lockPoolState = (globalState[EXAM_LOCK_POOL_STATE_KEY] ??= {});

/**
 * Keep advisory locks off the main provider pool. The callback may obtain
 * RuntimeStore and source transactions without waiting for a connection held
 * by its own outer lock.
 */
export function serverExamMutationLock(connectionString: string): ExamMutationLock {
  if (connectionString.trim() === '') throw new Error('Exam runtime requires DATABASE_URL');
  if (
    lockPoolState.connectionString === connectionString &&
    lockPoolState.pool &&
    lockPoolState.lock
  ) {
    return lockPoolState.lock;
  }

  const previousPool = lockPoolState.pool;
  const pool = new Pool({ connectionString, max: 4 });
  const lock = postgresExamMutationLock(pool as unknown as ConnectableQueryable);
  lockPoolState.connectionString = connectionString;
  lockPoolState.pool = pool;
  lockPoolState.lock = lock;
  if (previousPool) void previousPool.end().catch(() => undefined);
  return lock;
}
