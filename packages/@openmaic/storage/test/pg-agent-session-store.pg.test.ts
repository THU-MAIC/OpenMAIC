import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '../src/agent-session/pg.js';
import {
  acquireAgentSessionPgContractLock,
  truncateAgentSessionTables,
} from './pg-agent-session-contract-helpers.js';
import { runAgentSessionConcurrencyContract } from './agent-session-concurrency-contract.js';
import { makeAgentSessionInput, runAgentSessionStoreContract } from './agent-session-contract.js';
import { runAgentSessionUrlContract } from './agent-session-url-contract.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL agent-session contract suite',
  );
}

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForDatabaseMillisecondAfter(pool: Pool, timestamp: number): Promise<void> {
  for (;;) {
    const result = await pool.query<{ now_ms: string }>(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
    );
    if (Number(result.rows[0]!.now_ms) > timestamp) return;
  }
}

describe.skipIf(!contractUrl)('PgAgentSessionStore with PostgreSQL 16', () => {
  let pool: Pool;
  let store: PgAgentSessionStore;
  let releaseContractLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    // The agent-session PG suites share one database and TRUNCATE the same
    // tables, so they must never run at the same time; the advisory lock
    // blocks this suite until the other suite's afterAll releases it.
    releaseContractLock = await acquireAgentSessionPgContractLock(pool);
    await ensureAgentSessionSchema(pool as Queryable);
  }, 60_000);

  beforeEach(async () => {
    // CASCADE keeps this order-independent against any table that references
    // agent_sessions without this suite listing it — see the probe test below.
    await truncateAgentSessionTables(pool as Queryable);
    store = new PgAgentSessionStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await releaseContractLock?.();
    await pool.end();
  });

  runAgentSessionStoreContract('PostgreSQL 16 (node-postgres)', () => store);
  runAgentSessionConcurrencyContract('PostgreSQL 16 (node-postgres)', () => store, {
    genuineConcurrency: true,
  });
  runAgentSessionUrlContract('PostgreSQL 16 (node-postgres)', () => store);

  test('orders title projection timestamps by the actual locked update', async () => {
    await store.createSession(makeAgentSessionInput());
    const transactionStarted = deferred<number>();
    const releaseTransaction = deferred<void>();
    const delayedStore = new PgAgentSessionStore(pool as Queryable, {
      withTransaction: async (body) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const started = await client.query<{ started_ms: string }>(
            `SELECT floor(extract(epoch FROM now()) * 1000)::bigint AS started_ms`,
          );
          transactionStarted.resolve(Number(started.rows[0]!.started_ms));
          await releaseTransaction.promise;
          const result = await body(client as Queryable);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    });

    const laterCommit = delayedStore.setManualSessionTitle('session-1', 'owner-a', 'Second commit');
    const delayedTransactionStartedAt = await transactionStarted.promise;
    await waitForDatabaseMillisecondAfter(pool, delayedTransactionStartedAt);
    try {
      await store.setManualSessionTitle('session-1', 'owner-a', 'First commit');
    } finally {
      releaseTransaction.resolve(undefined);
    }
    await laterCommit;

    const titleEvents = (await store.readAfter('owner-a', BigInt(0))).filter(
      (event) => event.type === 'session_title',
    );
    expect(titleEvents.map((event) => event.title)).toEqual(['First commit', 'Second commit']);
    expect(titleEvents[1]!.ts).toBeGreaterThanOrEqual(titleEvents[0]!.ts);
    await expect(store.getSession('session-1')).resolves.toMatchObject({ title: 'Second commit' });
  });

  test('upgrades a legacy owner-event constraint for a long custom table name once', async () => {
    const ownerEvents = 'owner_events_with_a_very_long_custom_table_name_for_migration';
    const legacyConstraint = `${ownerEvents}_type_known`;
    const currentConstraint = 'agent_owner_session_events_type_known_v2';
    await pool.query(`DROP TABLE IF EXISTS ${ownerEvents}`);
    try {
      await pool.query(`
        CREATE TABLE ${ownerEvents} (
          owner_id TEXT NOT NULL,
          id BIGINT NOT NULL,
          ts BIGINT NOT NULL,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT,
          attempt INTEGER,
          data JSONB NOT NULL,
          PRIMARY KEY (owner_id, id),
          CONSTRAINT ${legacyConstraint} CHECK (type IN
            ('session_created','session_status','session_deleted',
             'session_active_stage','session_cancel_requested'))
        )
      `);

      await Promise.all([
        ensureAgentSessionSchema(pool as Queryable, { ownerEvents }),
        ensureAgentSessionSchema(pool as Queryable, { ownerEvents }),
      ]);
      const readTypeConstraints = () =>
        pool.query<{ oid: number; conname: string; convalidated: boolean }>(
          `SELECT oid, conname, convalidated FROM pg_constraint
           WHERE conrelid = $1::regclass
             AND conname IN ($2::name, $3::name)
           ORDER BY conname`,
          [ownerEvents, legacyConstraint, currentConstraint],
        );
      const migrated = await readTypeConstraints();
      expect(migrated.rows).toEqual([
        expect.objectContaining({
          conname: currentConstraint,
          convalidated: true,
          oid: expect.any(Number),
        }),
      ]);
      const constraintOid = migrated.rows[0]!.oid;

      await ensureAgentSessionSchema(pool as Queryable, { ownerEvents });

      await expect(readTypeConstraints()).resolves.toMatchObject({
        rows: [{ oid: constraintOid, conname: currentConstraint, convalidated: true }],
      });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${ownerEvents}`);
    }
  });

  test('quotes a reserved custom owner-event table throughout its migration', async () => {
    const ownerEvents = 'user';
    const sessions = 'user_sessions';
    await pool.query(`DROP TABLE IF EXISTS "${ownerEvents}"`);
    await pool.query(`DROP TABLE IF EXISTS ${sessions}`);
    try {
      await pool.query(`
        CREATE TABLE "${ownerEvents}" (
          owner_id TEXT NOT NULL,
          id BIGINT NOT NULL,
          ts BIGINT NOT NULL,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT,
          attempt INTEGER,
          data JSONB NOT NULL,
          PRIMARY KEY (owner_id, id),
          CONSTRAINT user_type_known CHECK (type IN
            ('session_created','session_status','session_deleted',
             'session_active_stage','session_cancel_requested'))
        )
      `);

      await ensureAgentSessionSchema(pool as Queryable, { ownerEvents, sessions });
      await ensureAgentSessionSchema(pool as Queryable, { ownerEvents, sessions });

      await expect(
        pool.query<{ convalidated: boolean }>(
          `SELECT convalidated FROM pg_constraint
           WHERE conrelid = $1::regclass
             AND conname = 'agent_owner_session_events_type_known_v2'`,
          [`"${ownerEvents}"`],
        ),
      ).resolves.toMatchObject({ rows: [{ convalidated: true }] });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${ownerEvents}"`);
      await pool.query(`DROP TABLE IF EXISTS ${sessions}`);
    }
  });

  test('skips the validation table lock once the v2 constraint is valid', async () => {
    const blocker = await pool.connect();
    const initializer = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE agent_owner_session_events IN SHARE MODE');
      await initializer.query(`SET lock_timeout = '500ms'`);

      await expect(ensureAgentSessionSchema(initializer as Queryable)).resolves.toBeUndefined();
    } finally {
      await initializer.query('RESET lock_timeout').catch(() => {});
      initializer.release();
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
  });

  test('beforeEach cleanup reaches FK-referencing tables the suite does not list', async () => {
    // Simulate the next store that references agent_sessions (the way the
    // material store did) without editing this suite: its table must be
    // emptied by the cleanup through CASCADE, or a full-suite run breaks
    // again with "cannot truncate a table referenced in a foreign key
    // constraint". The probe runs in one transaction so it is atomic and
    // self-cleaning: any failure rolls everything back, and the shared
    // database is left exactly as it was.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO agent_sessions (id, owner_id, prompt, stage_id)
         VALUES ('cleanup-probe-session', 'cleanup-probe-owner', 'probe', 'stage-cleanup-probe')`,
      );
      await client.query(
        `CREATE TABLE agent_session_cleanup_probe (
           id         TEXT PRIMARY KEY,
           session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE
         )`,
      );
      await client.query(
        `INSERT INTO agent_session_cleanup_probe (id, session_id)
         VALUES ('cleanup-probe-1', 'cleanup-probe-session')`,
      );
      // The exact statement the suite's beforeEach relies on.
      await truncateAgentSessionTables(client as Queryable);
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_session_cleanup_probe`,
      );
      expect(rows[0]!.n).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.query('DROP TABLE IF EXISTS agent_session_cleanup_probe').catch(() => {});
      client.release();
    }
  });

  test('runs against PostgreSQL 16 or newer', async () => {
    const result = await pool.query<{ version_num: string }>(
      `SELECT current_setting('server_version_num') AS version_num`,
    );
    expect(Number(result.rows[0]!.version_num)).toBeGreaterThanOrEqual(160_000);
  });
});
