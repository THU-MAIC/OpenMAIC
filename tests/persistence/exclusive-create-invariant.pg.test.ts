/**
 * The exclusive create's invariant on PostgreSQL: having found the id vacant
 * under the create lock, it must be the transaction that inserts the ownership
 * row. If that ever reports otherwise, the create throws and nothing it wrote
 * — the course, its ownership, the rows `inTransaction` would add — commits.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

vi.mock('@/lib/persistence/stage-meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/persistence/stage-meta')>();
  return {
    ...actual,
    // Insert the ownership row as usual, then claim it was already there.
    claimStageMeta: async (...args: Parameters<typeof actual.claimStageMeta>) => {
      await actual.claimStageMeta(...args);
      return false;
    },
  };
});

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_exclusive_create_invariant_test';

describe.skipIf(!contractUrl)('exclusive create invariant on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=exclusive-create`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    await getServerPersistenceProvider(databaseUrl, () => pool);
    await pool.query('CREATE TABLE extra_rows (stage_id TEXT)');
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('throws and rolls back everything when the ownership row reports not created', async () => {
    const store = createOwnerBoundDocumentStore({
      pool,
      ownerId: 'user:alice',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const inTransaction = vi.fn(async (tx: { query: (sql: string) => Promise<unknown> }) => {
      await tx.query("INSERT INTO extra_rows (stage_id) VALUES ('stage-invariant')");
    });

    await expect(
      store.createDocument(
        {
          stage: { id: 'stage-invariant', name: 'Invariant', createdAt: 1, updatedAt: 1 },
          scenes: [],
        },
        { inTransaction },
      ),
    ).rejects.toMatchObject({ code: 'STAGE_ID_TAKEN' });

    expect(inTransaction).not.toHaveBeenCalled();
    for (const sql of [
      "SELECT 1 FROM document_stages WHERE id = 'stage-invariant'",
      "SELECT 1 FROM stage_meta WHERE stage_id = 'stage-invariant'",
      "SELECT 1 FROM extra_rows WHERE stage_id = 'stage-invariant'",
    ]) {
      expect((await pool.query(sql)).rows).toEqual([]);
    }
  });
});
