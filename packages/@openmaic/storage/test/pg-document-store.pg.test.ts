import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { Pool } from 'pg';
import {
  PgDocumentStore,
  ensureDocumentSchema,
  type Queryable,
  type WithTransaction,
} from '../src/document/pg.js';
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

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    await ensureDocumentSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE document_outlines, document_scenes, document_stages');
    store = new PgDocumentStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await pool.end();
  });

  runDocumentStoreContract('PostgreSQL 16 (node-postgres)', () => store);
});
