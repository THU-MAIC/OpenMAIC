import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PgRuntimeStore,
  ensureSchema,
  type Queryable,
  type WithTransaction,
} from '../src/runtime/pg.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL contract suite',
  );
}

function transactionFor(pool: Pool, afterBegin?: () => Promise<void>): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await afterBegin?.();
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the transaction body's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

describe.skipIf(!contractUrl)('PgRuntimeStore with PostgreSQL 16', () => {
  let pool: Pool;
  let store: PgRuntimeStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    await ensureSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE runtime_records, runtime_sessions');
    store = new PgRuntimeStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await pool.end();
  });

  runRuntimeStoreContract('PostgreSQL 16 (node-postgres)', () => store);

  test('genuinely concurrent appends assign distinct gapless sequences', async () => {
    const concurrentTransactions = 8;
    await store.createSession(makeSession({ kind: 'playback' }));
    const allTransactionsStarted = makeBarrier(concurrentTransactions);
    const concurrentStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: transactionFor(pool, allTransactionsStarted),
    });

    const appended = await Promise.all(
      Array.from({ length: concurrentTransactions }, (_, index) =>
        concurrentStore.appendRecord(
          makeRecordInit('sess-1', {
            id: `pg-concurrent-${index}`,
            payload: { index },
          }),
        ),
      ),
    );

    const seqs = appended.map((record) => record.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: concurrentTransactions }, (_, index) => index));
    expect(new Set(seqs).size).toBe(concurrentTransactions);
  });

  test('retries after a real unique violation from an independent writer', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    const writer = await pool.connect();
    let attempts = 0;
    let collisionErrorCode: unknown;
    const collisionStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: async (body) => {
        attempts += 1;
        const client = await pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          if (attempts === 1) {
            // Establish the store transaction's snapshot before the external
            // row commits, so MAX(seq) still chooses the colliding value.
            await client.query('SELECT COUNT(*) FROM runtime_records');
            await writer.query(
              `INSERT INTO runtime_records
                 (id, session_id, seq, scene_id, created_at, data)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
              [
                'external-collision',
                'sess-1',
                0,
                null,
                '2026-01-01T00:01:00.000Z',
                JSON.stringify({
                  id: 'external-collision',
                  sessionId: 'sess-1',
                  seq: 0,
                  createdAt: '2026-01-01T00:01:00.000Z',
                  payload: { source: 'external' },
                }),
              ],
            );
          }
          const result = await body(client as Queryable);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          if (attempts === 1) collisionErrorCode = (error as { code?: unknown }).code;
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    });

    try {
      const appended = await collisionStore.appendRecord(
        makeRecordInit('sess-1', { id: 'store-after-collision', payload: { source: 'store' } }),
      );

      expect(attempts).toBe(2);
      expect(collisionErrorCode).toBe('23505');
      expect(appended.seq).toBe(1);
      expect((await store.listRecords('sess-1')).map((record) => record.seq)).toEqual([0, 1]);
    } finally {
      writer.release();
    }
  });

  test('a real aborted transaction does not poison the next store operation', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    const baseTransaction = transactionFor(pool);
    let injectFailure = true;
    let initialErrorCode: unknown;
    let abortedErrorCode: unknown;
    const recoveryStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: (body) =>
        baseTransaction((queryable) =>
          body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ) {
              if (injectFailure && text.includes('SELECT COALESCE(MAX(seq)')) {
                injectFailure = false;
                try {
                  await queryable.query('SELECT 1 / 0');
                } catch (error) {
                  initialErrorCode = (error as { code?: unknown }).code;
                  try {
                    await queryable.query('SELECT 1');
                  } catch (abortedError) {
                    abortedErrorCode = (abortedError as { code?: unknown }).code;
                  }
                  throw error;
                }
              }
              return queryable.query<TRow>(text, params);
            },
          }),
        ),
    });

    await expect(
      recoveryStore.appendRecord(
        makeRecordInit('sess-1', { id: 'aborted-attempt', payload: { attempt: 1 } }),
      ),
    ).rejects.toMatchObject({ code: '22012' });
    expect(initialErrorCode).toBe('22012');
    expect(abortedErrorCode).toBe('25P02');

    await expect(
      recoveryStore.appendRecord(
        makeRecordInit('sess-1', { id: 'after-abort', payload: { attempt: 2 } }),
      ),
    ).resolves.toMatchObject({ id: 'after-abort', seq: 0 });
  });
});
