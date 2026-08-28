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
import { runAgentSessionStoreContract } from './agent-session-contract.js';
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
