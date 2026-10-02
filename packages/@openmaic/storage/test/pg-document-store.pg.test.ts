import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PgDocumentStore,
  ensureDocumentSchema,
  type Queryable,
  type WithTransaction,
} from '../src/document/pg.js';
import {
  acquireDocumentPgContractLock,
  CONTRACT_OWNERSHIP,
  truncateDocumentTables,
} from './pg-document-contract-helpers.js';
import { makeDocument, runDocumentStoreContract } from './document-contract.js';
import { DocumentNotFoundError } from '../src/document/types.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL contract suite',
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

describe.skipIf(!contractUrl)('PgDocumentStore with PostgreSQL 16', () => {
  let pool: Pool;
  let store: PgDocumentStore;
  let releaseContractLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    // Same shared-database lock as the scene-revision suite: both suites
    // provision the same document schema (functions and triggers included),
    // so they must never run at the same time.
    releaseContractLock = await acquireDocumentPgContractLock(pool);
    await ensureDocumentSchema(pool as Queryable);
  }, 60_000);

  beforeEach(async () => {
    await truncateDocumentTables(pool as Queryable);
    store = new PgDocumentStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await releaseContractLock?.();
    await pool.end();
  });

  runDocumentStoreContract('PostgreSQL 16 (node-postgres)', () => ({
    store,
    seedStoredVersion: async (stageId, version) => {
      const result = await pool.query<{ data: unknown }>(
        'SELECT data FROM document_stages WHERE id = $1',
        [stageId],
      );
      const data = result.rows[0]!.data as Record<string, unknown>;
      if (version === undefined) delete data.dslVersion;
      else data.dslVersion = version;
      await pool.query('UPDATE document_stages SET data = $2::jsonb WHERE id = $1', [
        stageId,
        JSON.stringify(data),
      ]);
    },
  }));
});

describe.skipIf(!contractUrl)('owner-scoped PgDocumentStore with PostgreSQL 16', () => {
  let pool: Pool;
  let root: PgDocumentStore;
  let releaseContractLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    releaseContractLock = await acquireDocumentPgContractLock(pool);
    await ensureDocumentSchema(pool as Queryable);
  }, 60_000);

  beforeEach(async () => {
    await truncateDocumentTables(pool as Queryable);
    root = new PgDocumentStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
      documentOwnership: CONTRACT_OWNERSHIP,
    });
  });

  afterAll(async () => {
    await releaseContractLock?.();
    await pool.end();
  });

  runDocumentStoreContract('PostgreSQL 16 owner scope through an ownership relation', () => ({
    store: root.forOwner('contract-owner'),
    seedStoredVersion: async (stageId, version) => {
      const result = await pool.query<{ data: unknown }>(
        'SELECT data FROM document_stages WHERE id = $1',
        [stageId],
      );
      const data = result.rows[0]!.data as Record<string, unknown>;
      if (version === undefined) delete data.dslVersion;
      else data.dslVersion = version;
      await pool.query('UPDATE document_stages SET data = $2::jsonb WHERE id = $1', [
        stageId,
        JSON.stringify(data),
      ]);
    },
  }));

  test('two owners creating the same new id concurrently: exactly one holds it', async () => {
    // Without an ownership column there is no upsert guard on the document
    // row; the claim in the same transaction is what refuses the loser.
    for (let round = 0; round < 10; round += 1) {
      const stageId = `race-${round}`;
      const results = await Promise.allSettled([
        root.forOwner('alice').saveDocument(makeDocument(stageId)),
        root.forOwner('bob').saveDocument(makeDocument(stageId)),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DocumentNotFoundError);
      const owners = await pool.query<{ owner_id: string }>(
        'SELECT owner_id FROM document_contract_owners WHERE stage_id = $1',
        [stageId],
      );
      expect(owners.rows).toHaveLength(1);
      const winner = owners.rows[0]!.owner_id;
      const loser = winner === 'alice' ? 'bob' : 'alice';
      await expect(root.forOwner(winner).listDocuments()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: stageId })]),
      );
      expect(
        (await root.forOwner(loser).listDocuments()).some((summary) => summary.id === stageId),
      ).toBe(false);
    }
  });
});

describe.skipIf(!contractUrl)('document schema upgrade with PostgreSQL 16', () => {
  const SCHEMA = 'document_owner_column_upgrade';
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl, max: 2 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    // Its own schema, so the legacy table never meets the shared suites'.
    pool = new Pool({
      connectionString: contractUrl,
      max: 4,
      options: `-c search_path=${SCHEMA}`,
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  test('a legacy owner column is kept, relaxed, unindexed, and never written', async () => {
    await pool.query(`CREATE TABLE document_stages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      interactive_mode BOOLEAN,
      task_engine_mode BOOLEAN,
      created_at DOUBLE PRECISION NOT NULL,
      updated_at DOUBLE PRECISION NOT NULL,
      owner_id TEXT NOT NULL DEFAULT 'nobody',
      folder_id TEXT,
      data JSONB NOT NULL
    )`);
    await pool.query(
      `CREATE INDEX document_stages_owner_folder_idx ON document_stages (owner_id, folder_id, id)
        WHERE owner_id IS NOT NULL AND folder_id IS NOT NULL`,
    );
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ('old-stage', 'Old', 1, 1, 'alice', '{}'::jsonb)`,
    );

    await ensureDocumentSchema(pool as Queryable);
    await ensureDocumentSchema(pool as Queryable);

    const column = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'document_stages' AND column_name = 'owner_id'`,
      [SCHEMA],
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES', column_default: null }]);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'document_stages' ORDER BY indexname`,
      [SCHEMA],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'document_stages_folder_idx',
      'document_stages_pkey',
    ]);

    const store = new PgDocumentStore(pool as Queryable, { withTransaction: transactionFor(pool) });
    await store.saveDocument(makeDocument('new-stage'));
    const owners = await pool.query<{ id: string; owner_id: string | null }>(
      'SELECT id, owner_id FROM document_stages ORDER BY id',
    );
    expect(owners.rows).toEqual([
      { id: 'new-stage', owner_id: null },
      { id: 'old-stage', owner_id: 'alice' },
    ]);
  });
});
