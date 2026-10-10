/**
 * The migration runner on a real PostgreSQL: several processes starting
 * together, an upgrade of a database 1.1.x provisioned, and the refusal of a
 * database a newer release upgraded.
 *
 * Works in a schema of its own (every pool sets `search_path`), so it shares
 * nothing but advisory locks with the other suites on the contract database.
 */
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureAgentSessionSchema } from '../src/agent-session/pg.js';
import { ensureAssetSchema } from '../src/asset/pg.js';
import { ensureDocumentSchema } from '../src/document/pg.js';
import { ensureAgentSessionMaterialSchema } from '../src/material/pg.js';
import {
  SCHEMA_MIGRATION_LOCK_KEY,
  SchemaLockTimeoutError,
  SchemaMigrationInTransactionError,
  SchemaVersionAheadError,
  applySchemaMigrations,
  type MigrationQueryable,
  type SchemaMigrationSet,
} from '../src/pg-migrations.js';
import { ensureSchema } from '../src/runtime/pg.js';
import { ensureUserSkillSchema } from '../src/skill/pg.js';
import { provisionRelease11Storage } from './schema-release-1-1.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL contract suite',
  );
}

const TEST_SCHEMA = 'openmaic_storage_schema_migrations_test';
const INSTANCES = 6;

async function ensureAll(queryable: MigrationQueryable): Promise<void> {
  await ensureSchema(queryable);
  await ensureDocumentSchema(queryable);
  await ensureAssetSchema(queryable);
  await ensureAgentSessionSchema(queryable);
  await ensureAgentSessionMaterialSchema(queryable);
  await ensureUserSkillSchema(queryable);
}

describe.skipIf(!contractUrl)('schema migrations (PostgreSQL)', () => {
  let admin: Pool;

  const instancePool = () =>
    new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}`, max: 3 });

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
  });

  beforeEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function onInstances<T>(
    body: (pool: Pool) => Promise<T>,
  ): Promise<PromiseSettledResult<T>[]> {
    const pools = Array.from({ length: INSTANCES }, instancePool);
    try {
      return await Promise.allSettled(pools.map(body));
    } finally {
      await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
    }
  }

  function rejections(results: PromiseSettledResult<unknown>[]): string[] {
    return results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => String(result.reason));
  }

  it('instances starting together apply each migration once', async () => {
    const pool = instancePool();
    try {
      await pool.query('CREATE TABLE probe_runs (pid INTEGER NOT NULL)');
    } finally {
      await pool.end();
    }
    const set: SchemaMigrationSet = {
      store: 'probe',
      migrations: [
        { version: 1, name: 'baseline', up: 'CREATE TABLE IF NOT EXISTS probe (id TEXT)' },
        {
          version: 2,
          name: 'one_time',
          up: async (queryable) => {
            await queryable.query('INSERT INTO probe_runs (pid) SELECT pg_backend_pid()');
            // Long enough that every other instance is waiting on the lock.
            await queryable.query('SELECT pg_sleep(0.2)');
          },
        },
      ],
    };

    const results = await onInstances(async (instance) => {
      await ensureAll(instance);
      return applySchemaMigrations(instance, set);
    });

    expect(rejections(results)).toEqual([]);
    const applied = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(applied.filter((versions) => versions.length > 0)).toEqual([[1, 2]]);
    const check = instancePool();
    try {
      expect((await check.query('SELECT pid FROM probe_runs')).rows).toHaveLength(1);
    } finally {
      await check.end();
    }
  }, 60_000);

  it('instances starting together upgrade a database 1.1.x provisioned', async () => {
    const pool = instancePool();
    try {
      await provisionRelease11Storage(pool);
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
         VALUES ('legacy', 'Legacy', 1, 1, 'owner-a', '{"id":"legacy"}'::jsonb)`,
      );
    } finally {
      await pool.end();
    }

    expect(rejections(await onInstances(ensureAll))).toEqual([]);

    const check = instancePool();
    try {
      const recorded = await check.query<{ store: string; versions: number[] }>(
        `SELECT store, array_agg(version ORDER BY version) AS versions
           FROM openmaic_schema_migrations GROUP BY store ORDER BY store`,
      );
      expect(recorded.rows).toEqual([
        { store: 'agent-session', versions: [1, 2] },
        { store: 'agent-session-material', versions: [1] },
        { store: 'asset', versions: [1] },
        { store: 'document', versions: [1, 2] },
        { store: 'runtime', versions: [1] },
        { store: 'user-skill', versions: [1] },
      ]);
      const stages = await check.query('SELECT id, owner_id FROM document_stages');
      expect(stages.rows).toEqual([{ id: 'legacy', owner_id: 'owner-a' }]);
    } finally {
      await check.end();
    }
  }, 60_000);

  describe('on every kind of connection', () => {
    const versions = async (): Promise<number[]> => {
      const check = instancePool();
      try {
        const result = await check.query<{ version: number }>(
          `SELECT version FROM openmaic_schema_migrations WHERE store = 'runtime'`,
        );
        return result.rows.map((row) => row.version);
      } finally {
        await check.end();
      }
    };

    it('a pool, checking one connection out', async () => {
      const pool = instancePool();
      try {
        await ensureSchema(pool);
      } finally {
        await pool.end();
      }
      expect(await versions()).toEqual([1]);
    });

    it('a client checked out of a pool', async () => {
      const pool = instancePool();
      const client = await pool.connect();
      try {
        await ensureSchema(client);
      } finally {
        client.release();
        await pool.end();
      }
      expect(await versions()).toEqual([1]);
    });

    it('a connected node-postgres Client', async () => {
      const client = new Client({
        connectionString: contractUrl,
        options: `-c search_path=${TEST_SCHEMA}`,
      });
      await client.connect();
      try {
        await ensureSchema(client);
        await ensureSchema(client);
      } finally {
        await client.end();
      }
      expect(await versions()).toEqual([1]);
    });

    it("refuses a connection inside an open transaction, leaving the caller's work alone", async () => {
      const client = new Client({
        connectionString: contractUrl,
        options: `-c search_path=${TEST_SCHEMA}`,
      });
      await client.connect();
      try {
        await client.query('CREATE TABLE caller_work (id TEXT)');
        await client.query('BEGIN');
        await client.query(`INSERT INTO caller_work VALUES ('pending')`);
        await expect(ensureSchema(client)).rejects.toBeInstanceOf(
          SchemaMigrationInTransactionError,
        );
        await client.query('ROLLBACK');
        expect((await client.query('SELECT 1 FROM caller_work')).rows).toEqual([]);
        expect((await client.query(`SELECT to_regclass('runtime_sessions') AS t`)).rows).toEqual([
          { t: null },
        ]);
      } finally {
        await client.end();
      }
    });
  });

  it('gives up waiting for a held migration lock, naming it', async () => {
    const holder = new Client({ connectionString: contractUrl });
    await holder.connect();
    const pool = instancePool();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
      const waited = applySchemaMigrations(
        pool,
        { store: 'probe', migrations: [{ version: 1, name: 'baseline', up: 'SELECT 1' }] },
        { lockTimeoutMs: 300 },
      );
      await expect(waited).rejects.toBeInstanceOf(SchemaLockTimeoutError);
      await expect(waited).rejects.toThrow(/schema migration lock/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
      await holder.end();
      await pool.end();
    }
  });

  it('every instance refuses a database a newer release upgraded', async () => {
    const pool = instancePool();
    try {
      await ensureAll(pool);
      await pool.query(
        `INSERT INTO openmaic_schema_migrations (store, version, name, checksum)
         VALUES ('asset', 2, 'from_a_newer_release', 'x')`,
      );
    } finally {
      await pool.end();
    }

    const results = await onInstances(ensureAll);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SchemaVersionAheadError);
    }
  }, 60_000);
});
