/**
 * Versioned schema migrations through the application's bootstrap, on a real
 * PostgreSQL: a database 1.1.x created, one the previous development line
 * created (today's DDL, no version records), a one-time migration across
 * restarts, and the refusal to start on a database a newer release upgraded.
 *
 * Every round works in a schema of its own, so the suite shares nothing with
 * the package suites on the contract database.
 */
import {
  AGENT_SESSION_PG_MIGRATIONS,
  ensureAgentSessionSchema,
} from '@openmaic/storage/agent-session/pg';
import { ASSET_PG_MIGRATIONS } from '@openmaic/storage/asset/pg';
import { DOCUMENT_PG_MIGRATIONS, splitSqlStatements } from '@openmaic/storage/document/pg';
import {
  AGENT_SESSION_MATERIAL_PG_MIGRATIONS,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import type { SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import { RUNTIME_PG_MIGRATIONS } from '@openmaic/storage/runtime/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { USER_SKILL_PG_MIGRATIONS, ensureUserSkillSchema } from '@openmaic/storage/skill/pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLASSROOM_GENERATION_JOB_MIGRATIONS } from '@/lib/persistence/classroom-generation-jobs';
import { LEGACY_CLASSROOM_IMPORT_MIGRATIONS } from '@/lib/persistence/legacy-classroom-imports';
import { LEGACY_IMPORT_BINDING_MIGRATIONS } from '@/lib/persistence/legacy-import-bindings';
import { OWNER_MATERIAL_MIGRATIONS } from '@/lib/persistence/owner-materials';
import { OWNER_MERGE_MIGRATIONS } from '@/lib/persistence/owner-merges';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { STAGE_META_MIGRATIONS } from '@/lib/persistence/stage-meta';
import { WORKSPACE_MODEL_CONFIG_MIGRATIONS } from '@/lib/persistence/workspace-model-config';

import { provisionRelease11Storage } from '../../packages/@openmaic/storage/test/schema-release-1-1';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_app_schema_migrations_test';

/** Every store the application provisions, in its bootstrap order. */
const APP_STORES: readonly SchemaMigrationSet[] = [
  RUNTIME_PG_MIGRATIONS,
  DOCUMENT_PG_MIGRATIONS,
  STAGE_META_MIGRATIONS,
  OWNER_MERGE_MIGRATIONS,
  LEGACY_IMPORT_BINDING_MIGRATIONS,
  OWNER_MATERIAL_MIGRATIONS,
  ASSET_PG_MIGRATIONS,
  CLASSROOM_GENERATION_JOB_MIGRATIONS,
  LEGACY_CLASSROOM_IMPORT_MIGRATIONS,
  WORKSPACE_MODEL_CONFIG_MIGRATIONS,
  AGENT_SESSION_PG_MIGRATIONS,
  AGENT_SESSION_MATERIAL_PG_MIGRATIONS,
  USER_SKILL_PG_MIGRATIONS,
];

const EVERY_VERSION = APP_STORES.map((set) => ({
  store: set.store,
  versions: set.migrations.map((migration) => migration.version),
})).sort((a, b) => a.store.localeCompare(b.store));

/** What 1.1.x added beside the package tables (verbatim from v1.1.2). */
const RELEASE_11_APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);
ALTER TABLE stage_meta ADD COLUMN IF NOT EXISTS published_at DOUBLE PRECISION;
ALTER TABLE stage_meta ADD COLUMN IF NOT EXISTS generation_complete BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);
CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  oss_key TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);
`;

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

  it('a fresh install records every version of every store', async () => {
    await boot();
    expect(await recordedVersions()).toEqual(EVERY_VERSION);
  }, 60_000);

  it('upgrades a database 1.1.x created, adopting its column-only owners', async () => {
    await withPool(async (pool) => {
      await provisionRelease11Storage(pool);
      for (const statement of splitSqlStatements(RELEASE_11_APP_SCHEMA))
        await pool.query(statement);
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
         VALUES ('legacy', 'Legacy', 1, 1, 'owner-a', '{"id":"legacy"}'::jsonb)`,
      );
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await boot();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adopted 1 owned course\(s\)/));
    } finally {
      warn.mockRestore();
    }

    expect(await recordedVersions()).toEqual(EVERY_VERSION);
    await withPool(async (pool) => {
      const meta = await pool.query('SELECT stage_id, owner_id FROM stage_meta');
      expect(meta.rows).toEqual([{ stage_id: 'legacy', owner_id: 'owner-a' }]);
    });
  }, 60_000);

  it('upgrades a database the unversioned bootstrap created, and runs its one-time steps once', async () => {
    // Today's DDL as the bootstrap ran it before versions were recorded: every
    // SQL migration, with an owner_material table from before the byte store.
    await withPool(async (pool) => {
      for (const set of APP_STORES) {
        for (const migration of set.migrations) {
          if (typeof migration.up !== 'string') continue;
          for (const statement of splitSqlStatements(migration.up)) await pool.query(statement);
        }
      }
      await pool.query('ALTER TABLE owner_material DROP COLUMN oss_key');
      await pool.query(`ALTER TABLE owner_material ADD COLUMN asset_id TEXT NOT NULL DEFAULT 'a'`);
    });

    await boot();

    expect(await recordedVersions()).toEqual(EVERY_VERSION);
    await withPool(async (pool) => {
      expect(await hasColumn(pool, 'owner_material', 'asset_id')).toBe(false);
      expect(await hasColumn(pool, 'owner_material', 'oss_key')).toBe(true);
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
});
