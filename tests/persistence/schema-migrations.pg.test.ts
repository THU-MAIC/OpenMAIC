/**
 * Versioned schema migrations through the application's bootstrap, on a real
 * PostgreSQL: upgrades of databases the earlier lines created (frozen DDL
 * snapshots of v1.1.2, `main` and `integration/provider-config`), the
 * pre-byte-store owner materials, a rollback to 1.1.x and forward again, a
 * one-time migration across restarts, and the refusal to start on a database
 * a newer release upgraded -- for every store, including the lazily
 * provisioned ones.
 *
 * Every case works in a schema of its own, so the suite shares nothing with
 * the package suites on the contract database.
 */
import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { ensureUserSkillSchema } from '@openmaic/storage/skill/pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const exitOnBootFailure = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/boot-failure', () => ({ exitOnBootFailure }));

import { startSchemaBootCheck } from '@/lib/persistence/schema-boot-check';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { APP_SCHEMA_STORES } from '@/lib/persistence/schema-stores';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import {
  MAIN_SCHEMA,
  PRE_BYTE_STORE_OWNER_MATERIAL_SCHEMA,
  PROVIDER_CONFIG_SCHEMA,
  RELEASE_1_1_2_SCHEMA,
  provisionSnapshot,
} from './_schema-snapshots';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_app_schema_migrations_test';

const EVERY_VERSION = APP_SCHEMA_STORES.map((set) => ({
  store: set.store,
  versions: set.migrations.map((migration) => migration.version),
})).sort((a, b) => a.store.localeCompare(b.store));

describe.skipIf(!contractUrl)('versioned schema migrations at boot (PostgreSQL)', () => {
  let admin: Pool;
  let boots = 0;
  const previousBucket = process.env.ASSET_S3_BUCKET;

  const schemaPool = () =>
    new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}`, max: 4 });

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    process.env.ASSET_S3_BUCKET = '';
  });

  beforeEach(async () => {
    exitOnBootFailure.mockReset();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  });

  afterAll(async () => {
    if (previousBucket === undefined) delete process.env.ASSET_S3_BUCKET;
    else process.env.ASSET_S3_BUCKET = previousBucket;
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  /** One process start: the provider, then the agent runtime's lazy stores. */
  async function boot(): Promise<void> {
    const pool = schemaPool();
    boots += 1;
    try {
      await getServerPersistenceProvider(`${contractUrl}#migrations-${boots}`, () => pool);
      const locked = pool as unknown as ConnectableQueryable;
      await withSchemaBootstrapLock(locked, ensureAgentSessionSchema);
      await withSchemaBootstrapLock(locked, ensureAgentSessionMaterialSchema);
      await withSchemaBootstrapLock(locked, ensureUserSkillSchema);
    } finally {
      await pool.end().catch(() => {});
    }
  }

  async function withPool<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
    const pool = schemaPool();
    try {
      return await body(pool);
    } finally {
      await pool.end();
    }
  }

  async function recordedVersions(): Promise<{ store: string; versions: number[] }[]> {
    return withPool(async (pool) => {
      const result = await pool.query<{ store: string; versions: number[] }>(
        `SELECT store, array_agg(version ORDER BY version) AS versions
           FROM openmaic_schema_migrations GROUP BY store`,
      );
      return result.rows.sort((a, b) => a.store.localeCompare(b.store));
    });
  }

  async function hasColumn(pool: Pool, table: string, column: string): Promise<boolean> {
    const result = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
       ) AS present`,
      [TEST_SCHEMA, table, column],
    );
    return result.rows[0]?.present === true;
  }

  /** A course as a 1.1.x writer records it: owner on the document row only. */
  async function insertColumnOnlyCourse(pool: Pool, stageId: string, ownerId: string) {
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ($1, $1, 1, 1, $2, jsonb_build_object('id', $1::text))`,
      [stageId, ownerId],
    );
  }

  async function stageMeta(): Promise<unknown[]> {
    return withPool(
      async (pool) =>
        (await pool.query('SELECT stage_id, owner_id FROM stage_meta ORDER BY stage_id')).rows,
    );
  }

  it('a fresh install records every version of every store', async () => {
    await boot();
    expect(await recordedVersions()).toEqual(EVERY_VERSION);
  }, 60_000);

  it('upgrades a database v1.1.2 created, adopting its column-only courses', async () => {
    await withPool(async (pool) => {
      await provisionSnapshot(pool, RELEASE_1_1_2_SCHEMA);
      await insertColumnOnlyCourse(pool, 'legacy', 'owner-a');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await boot();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adopted 1 owned course\(s\)/));
    } finally {
      warn.mockRestore();
    }

    expect(await recordedVersions()).toEqual(EVERY_VERSION);
    expect(await stageMeta()).toEqual([{ stage_id: 'legacy', owner_id: 'owner-a' }]);
  }, 60_000);

  it.each([
    ['main', MAIN_SCHEMA],
    ['integration/provider-config', PROVIDER_CONFIG_SCHEMA],
  ])(
    'upgrades a database %s created, keeping its courses',
    async (_, snapshot) => {
      await withPool(async (pool) => {
        await provisionSnapshot(pool, snapshot);
        // Those lines record ownership in stage_meta only.
        await pool.query(
          `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ('course', 'Course', 1, 1, '{"id":"course"}'::jsonb)`,
        );
        await pool.query(
          `INSERT INTO stage_meta (stage_id, owner_id) VALUES ('course', 'owner-a')`,
        );
      });

      await boot();

      expect(await recordedVersions()).toEqual(EVERY_VERSION);
      expect(await stageMeta()).toEqual([{ stage_id: 'course', owner_id: 'owner-a' }]);
      await withPool(async (pool) => {
        expect((await pool.query('SELECT id FROM document_stages')).rows).toEqual([
          { id: 'course' },
        ]);
      });
    },
    60_000,
  );

  it('adopts a course a rolled-back 1.1.x instance created, when upgraded again', async () => {
    await withPool((pool) => provisionSnapshot(pool, RELEASE_1_1_2_SCHEMA));
    await boot();
    // Rolled back: 1.1.x writes ownership on the document row, and runs its
    // own every-start DDL, which leaves the version table alone.
    await withPool(async (pool) => {
      await provisionSnapshot(pool, RELEASE_1_1_2_SCHEMA);
      await insertColumnOnlyCourse(pool, 'during-rollback', 'owner-b');
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await boot();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adopted 1 owned course\(s\)/));
    } finally {
      warn.mockRestore();
    }
    expect(await stageMeta()).toEqual([{ stage_id: 'during-rollback', owner_id: 'owner-b' }]);
  }, 60_000);

  it('drops the pre-byte-store asset_id once, and never on a later start', async () => {
    await withPool(async (pool) => {
      // `main`'s tables, with an owner_material from before the byte store.
      await provisionSnapshot(
        pool,
        MAIN_SCHEMA.filter(([store]) => store !== 'owner-material'),
      );
      await provisionSnapshot(pool, [['owner-material', PRE_BYTE_STORE_OWNER_MATERIAL_SCHEMA]]);
      await pool.query(
        `INSERT INTO owner_material (id, owner_id, kind, bytes, asset_id, created_at)
         VALUES ('mat-1', 'owner-a', 'source', 1, 'asset-1', 1)`,
      );
    });

    await boot();

    expect(await recordedVersions()).toEqual(EVERY_VERSION);
    await withPool(async (pool) => {
      expect(await hasColumn(pool, 'owner_material', 'asset_id')).toBe(false);
      const rows = await pool.query('SELECT id, oss_key FROM owner_material');
      expect(rows.rows).toEqual([{ id: 'mat-1', oss_key: '' }]);
      // A later schema brings the column back for a purpose of its own...
      await pool.query('ALTER TABLE owner_material ADD COLUMN asset_id TEXT');
    });

    await boot();

    // ...and a restart no longer drops it: the drop ran once, with its version.
    await withPool(async (pool) => {
      expect(await hasColumn(pool, 'owner_material', 'asset_id')).toBe(true);
    });
  }, 60_000);

  it('refuses to start on a database a newer release upgraded', async () => {
    await boot();
    await withPool((pool) =>
      pool.query(
        `INSERT INTO openmaic_schema_migrations (store, version, name, checksum)
         VALUES ('owner-material', 3, 'from_a_newer_release', 'x')`,
      ),
    );

    await expect(boot()).rejects.toMatchObject({
      name: 'SchemaVersionAheadError',
      store: 'owner-material',
      recordedVersion: 3,
      knownVersion: 2,
    });
  }, 60_000);

  describe('the startup check', () => {
    const checkPool = () => schemaPool();

    it('passes a database with nothing recorded yet, and creates nothing', async () => {
      await startSchemaBootCheck(contractUrl!, checkPool);

      expect(exitOnBootFailure).not.toHaveBeenCalled();
      const tables = await admin.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [TEST_SCHEMA],
      );
      expect(tables.rows).toEqual([]);
    });

    it('passes a database this release provisioned', async () => {
      await boot();
      await startSchemaBootCheck(contractUrl!, checkPool);
      expect(exitOnBootFailure).not.toHaveBeenCalled();
    }, 60_000);

    it.each(APP_SCHEMA_STORES.map((set) => [set.store, set.migrations.length] as const))(
      'stops the process when %s records a version newer than this release knows',
      async (store, known) => {
        // Only the provider's stores: the lazily provisioned ones need not exist.
        await withPool(async (pool) => {
          await pool.query(
            `CREATE TABLE openmaic_schema_migrations (
               store TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
               checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
               PRIMARY KEY (store, version))`,
          );
          await pool.query(
            `INSERT INTO openmaic_schema_migrations (store, version, name, checksum)
             VALUES ($1, $2, 'from_a_newer_release', 'x')`,
            [store, known + 1],
          );
        });

        await startSchemaBootCheck(contractUrl!, checkPool);

        expect(exitOnBootFailure).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'SchemaVersionAheadError',
            store,
            recordedVersion: known + 1,
          }),
        );
      },
    );
  });
});
