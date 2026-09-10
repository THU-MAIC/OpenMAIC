import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { Pool } from 'pg';
import {
  PgDocumentStore,
  ensureDocumentSchema,
  type Queryable,
  type WithTransaction,
} from '../src/document/pg.js';
import {
  acquireDocumentPgContractLock,
  truncateDocumentTables,
} from './pg-document-contract-helpers.js';
import { runDocumentStoreContract } from './document-contract.js';

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
