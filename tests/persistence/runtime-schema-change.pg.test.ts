import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import { PBL_MIGRATIONS } from '@/lib/persistence/pbl-studies';
const database = vi.hoisted(() => ({ pool: undefined as unknown as Pool }));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: database.pool }),
}));
import { assertRuntimeSchemaCompatibility } from '@/lib/persistence/schema-boot-check';

const url = process.env.PG_CONTRACT_URL;
describe.skipIf(!url)('schema changes after a worker has already started (PostgreSQL)', () => {
  const schema = `runtime_guard_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    database.pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await database.pool?.end();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
  it('accepts the initial database, then detects a newer lazy-store version on the same pool', async () => {
    await applySchemaMigrations(database.pool, {
      store: 'runtime-guard-probe',
      migrations: [{ version: 1, name: 'probe', up: 'SELECT 1;' }],
    });
    await expect(assertRuntimeSchemaCompatibility()).resolves.toBeUndefined();
    // Simulate the other release's committed version records, entirely inside
    // this suite's schema. No application/learner tables are created or altered.
    await applySchemaMigrations(database.pool, {
      store: PBL_MIGRATIONS.store,
      migrations: Array.from({ length: PBL_MIGRATIONS.migrations.length + 1 }, (_, index) => ({
        version: index + 1,
        name: `future-${index + 1}`,
        up: 'SELECT 1;',
      })),
    });
    await expect(assertRuntimeSchemaCompatibility()).rejects.toMatchObject({
      name: 'SchemaVersionAheadError',
    });
  });
});
