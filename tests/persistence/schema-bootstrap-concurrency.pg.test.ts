/**
 * Several instances starting at once against one database, on a real
 * PostgreSQL: schema bootstrap is serialized by an advisory lock, so every
 * instance comes up -- on a fresh database and on one upgraded from the
 * previous release -- instead of one of them failing on a catalog race
 * ("duplicate key value violates unique constraint pg_class_relname_nsp_index",
 * "tuple concurrently updated") and answering its first request with a 500.
 *
 * Each instance gets its own pool, as separate processes would, and each round
 * gets a fresh schema, so every round races the same first-time DDL.
 */
import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { ALICE, provisionPreviousRelease, storeFor } from './_stage-meta-tenancy-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_schema_bootstrap_concurrency_test';
const INSTANCES = 8;
const ROUNDS = 4;

describe.skipIf(!contractUrl)('concurrent schema bootstrap (PostgreSQL)', () => {
  let admin: Pool;
  const previousBucket = process.env.ASSET_S3_BUCKET;
  let boots = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    process.env.ASSET_S3_BUCKET = '';
  });

  afterAll(async () => {
    if (previousBucket === undefined) delete process.env.ASSET_S3_BUCKET;
    else process.env.ASSET_S3_BUCKET = previousBucket;
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  const instancePool = () =>
    new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}`, max: 4 });

  async function freshSchema(): Promise<void> {
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  }

  /**
   * Start `INSTANCES` instances at once: each boots the persistence provider,
   * and then provisions the agent-runtime tables the way their lazy stores do.
   */
  async function bootConcurrently(): Promise<PromiseSettledResult<void>[]> {
    const pools = Array.from({ length: INSTANCES }, instancePool);
    try {
      return await Promise.allSettled(
        pools.map(async (pool) => {
          boots += 1;
          await getServerPersistenceProvider(`${contractUrl}#concurrent-${boots}`, () => pool);
          const locked = pool as unknown as ConnectableQueryable;
          await withSchemaBootstrapLock(locked, ensureAgentSessionSchema);
          await withSchemaBootstrapLock(locked, ensureAgentSessionMaterialSchema);
          await withSchemaBootstrapLock(locked, ensureUserSkillSchema);
        }),
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
    }
  }

  function expectAllUp(results: PromiseSettledResult<void>[]): void {
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => String(result.reason));
    expect(failures).toEqual([]);
  }

  it('every instance comes up on a fresh database', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await freshSchema();
      expectAllUp(await bootConcurrently());
    }
  }, 120_000);

  it('every instance comes up on a database upgraded from the previous release', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await freshSchema();
      const pool = instancePool();
      try {
        await provisionPreviousRelease(pool);
        await pool.query(
          `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
           VALUES ('legacy', 'Legacy', 1, 1, $1, '{"id":"legacy"}'::jsonb)`,
          [ALICE],
        );
      } finally {
        await pool.end();
      }

      expectAllUp(await bootConcurrently());

      const check = instancePool();
      try {
        // Adopted once, whichever instance got there first.
        const meta = await check.query('SELECT stage_id, owner_id FROM stage_meta');
        expect(meta.rows).toEqual([{ stage_id: 'legacy', owner_id: ALICE }]);
        expect((await storeFor(check, ALICE).listDocuments()).map((row) => row.id)).toEqual([
          'legacy',
        ]);
      } finally {
        await check.end();
      }
    }
  }, 120_000);
});
