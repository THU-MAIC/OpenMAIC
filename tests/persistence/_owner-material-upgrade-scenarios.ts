/**
 * `owner_material` schema upgrade scenarios, shared by the PGlite suite
 * (`owner-materials.test.ts`) and the PostgreSQL one
 * (`owner-materials.pg.test.ts`). Each scenario expects an EMPTY database (or
 * schema) of its own: it builds one historical table shape, runs the current
 * bootstrap against it, and checks the result.
 *
 * The shapes a deployment can hold, by which bootstrap last ran on it:
 *
 * - none: no table (a fresh database);
 * - 1.0.0 or later: `oss_key`, and no `asset_id` (every release dropped it);
 * - the pre-release asset-id era: `asset_id TEXT NOT NULL`, with or without
 *   rows, and no `oss_key`.
 */
import { expect } from 'vitest';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureOwnerMaterialSchema,
  OWNER_MATERIAL_MIGRATIONS,
  registerOwnerMaterial,
  type RegisterOwnerMaterialInput,
} from '@/lib/persistence/owner-materials';

export interface UpgradeHarness {
  /** Statements run here, one at a time, against the scenario's own database. */
  db: {
    query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: TRow[] }>;
  };
  /** The same database as a pool, for the registration path under test. */
  pool: ConnectableQueryable;
}

/** The table the pre-release asset-id era created. */
const ASSET_ID_ERA_TABLE = `CREATE TABLE owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  asset_id TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
)`;

/** The table every release from 1.0.0 on leaves behind. */
const RELEASE_TABLE = `CREATE TABLE owner_material (
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
)`;

/** The statement every bootstrap before this change ran, verbatim. */
const PRE_ROOTS_DROP = 'ALTER TABLE owner_material DROP COLUMN IF EXISTS asset_id';

const upload = (
  overrides: Partial<RegisterOwnerMaterialInput> = {},
): RegisterOwnerMaterialInput => ({
  id: 'mat_new',
  ownerId: 'owner-1',
  kind: 'source',
  mime: 'application/pdf',
  bytes: 100,
  originalName: 'new.pdf',
  ossKey: 'materials/owner-1/mat_new',
  extraction: { status: 'idle' },
  ...overrides,
});

async function assetIdColumn(h: UpgradeHarness): Promise<{ is_nullable: string } | undefined> {
  const result = await h.db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'owner_material' AND column_name = 'asset_id'`,
  );
  return result.rows[0];
}

async function columnNames(h: UpgradeHarness): Promise<string[]> {
  const result = await h.db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'owner_material'`,
  );
  return result.rows.map((row) => row.column_name);
}

async function folderForeignKeyCount(h: UpgradeHarness): Promise<number> {
  const result = await h.db.query(
    `SELECT 1 FROM pg_constraint
      WHERE conname = 'owner_material_folder_fk'
        AND conrelid = 'owner_material'::regclass`,
  );
  return result.rows.length;
}

/** What every upgraded database has, whatever shape it started from. */
async function expectCurrentShape(h: UpgradeHarness): Promise<void> {
  expect(await assetIdColumn(h)).toEqual({ is_nullable: 'YES' });
  expect(await columnNames(h)).toEqual(
    expect.arrayContaining(['oss_key', 'asset_id', 'folder_id', 'display_name']),
  );
  expect(await folderForeignKeyCount(h)).toBe(1);
  const record = await registerOwnerMaterial(h.pool, upload(), {
    maxCount: 10,
    maxTotalBytes: 10_000,
  });
  expect(record).toMatchObject({ status: 'uploading', ossKey: 'materials/owner-1/mat_new' });
}

async function insertAssetIdEraRow(h: UpgradeHarness): Promise<void> {
  await h.db.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, asset_id, sha256,
        status, extraction, created_at)
     VALUES ('mat_legacy', 'owner-1', 'source', 'application/pdf', 2048, 'legacy.pdf',
             'legacy-asset-1', NULL, 'ready', NULL, 1600000000000)`,
  );
}

export async function freshDatabaseScenario(h: UpgradeHarness): Promise<void> {
  await ensureOwnerMaterialSchema(h.db);
  await ensureOwnerMaterialSchema(h.db);
  await expectCurrentShape(h);
}

export async function releaseTableScenario(h: UpgradeHarness): Promise<void> {
  await h.db.query(RELEASE_TABLE);
  await h.db.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, bytes, oss_key, status, created_at)
     VALUES ('mat_release', 'owner-1', 'source', 10, 'materials/owner-1/mat_release', 'ready', 1)`,
  );

  await ensureOwnerMaterialSchema(h.db);
  await ensureOwnerMaterialSchema(h.db);

  await expectCurrentShape(h);
  const row = await h.db.query<{ asset_id: string | null; oss_key: string }>(
    `SELECT asset_id, oss_key FROM owner_material WHERE id = 'mat_release'`,
  );
  expect(row.rows[0]).toEqual({ asset_id: null, oss_key: 'materials/owner-1/mat_release' });
}

export async function assetIdEraWithRowsScenario(h: UpgradeHarness): Promise<void> {
  await h.db.query(ASSET_ID_ERA_TABLE);
  await insertAssetIdEraRow(h);

  await ensureOwnerMaterialSchema(h.db);
  await ensureOwnerMaterialSchema(h.db);

  await expectCurrentShape(h);
  // The retired registry id is cleared, never left to read as a pool pointer,
  // and the row survives with the "no bytes recorded" oss_key sentinel.
  const row = await h.db.query<{ asset_id: string | null; oss_key: string; status: string }>(
    `SELECT asset_id, oss_key, status FROM owner_material WHERE id = 'mat_legacy'`,
  );
  expect(row.rows[0]).toEqual({ asset_id: null, oss_key: '', status: 'ready' });
}

export async function assetIdEraEmptyScenario(h: UpgradeHarness): Promise<void> {
  await h.db.query(ASSET_ID_ERA_TABLE);

  await ensureOwnerMaterialSchema(h.db);
  await ensureOwnerMaterialSchema(h.db);

  await expectCurrentShape(h);
}

export async function preRootsDropRecoveryScenario(h: UpgradeHarness): Promise<void> {
  await applySchemaMigrations(h.db, {
    ...OWNER_MATERIAL_MIGRATIONS,
    migrations: OWNER_MATERIAL_MIGRATIONS.migrations.filter((m) => m.version <= 4),
  });
  // Old processes must stop before v5 runs. Their last DROP precedes the
  // new migration; recorded migrations do not repair a later old bootstrap.
  await h.db.query(PRE_ROOTS_DROP);
  expect(await assetIdColumn(h)).toBeUndefined();
  await ensureOwnerMaterialSchema(h.db);
  await expectCurrentShape(h);
}

export async function clearingIsAtomicScenario(h: UpgradeHarness): Promise<void> {
  await applySchemaMigrations(h.db, {
    ...OWNER_MATERIAL_MIGRATIONS,
    migrations: OWNER_MATERIAL_MIGRATIONS.migrations.filter((m) => m.version <= 4),
  });
  const failing = {
    query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS material_folders'))
        throw new Error('refused by test');
      return h.db.query<T>(sql, params);
    },
  };
  await expect(ensureOwnerMaterialSchema(failing)).rejects.toThrow('refused by test');
  // All of v5 is rolled back, including columns preceding the failed DDL.
  expect(await assetIdColumn(h)).toBeUndefined();
  await ensureOwnerMaterialSchema(h.db);
  await expectCurrentShape(h);
}

export async function folderForeignKeyScenario(h: UpgradeHarness): Promise<void> {
  await ensureOwnerMaterialSchema(h.db);
  await h.db.query(
    `INSERT INTO material_folders (owner_id, id, name, normalized_name, created_at, updated_at)
     VALUES ('owner-1', 'folder-1', 'Unit 1', 'unit 1', 1, 1)`,
  );
  await h.db.query(
    `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, status, created_at, folder_id)
     VALUES ('mat_filed', 'owner-1', 'source', 1, 'k', 'ready', 1, 'folder-1'),
            ('mat_unfiled', 'owner-1', 'source', 1, 'k', 'ready', 1, NULL)`,
  );

  // A folder that still holds a material cannot be deleted.
  await expect(
    h.db.query(`DELETE FROM material_folders WHERE owner_id = 'owner-1' AND id = 'folder-1'`),
  ).rejects.toThrow();
  // A material cannot be filed in another owner's folder.
  await expect(
    h.db.query(
      `INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, status, created_at, folder_id)
       VALUES ('mat_cross', 'owner-2', 'source', 1, 'k', 'ready', 1, 'folder-1')`,
    ),
  ).rejects.toThrow();
  // Folder names are unique per owner by their normalized form.
  await expect(
    h.db.query(
      `INSERT INTO material_folders (owner_id, id, name, normalized_name, created_at, updated_at)
       VALUES ('owner-1', 'folder-2', 'UNIT 1', 'unit 1', 1, 1)`,
    ),
  ).rejects.toThrow();
}

export const UPGRADE_SCENARIOS = {
  'a fresh database gets the current shape, idempotently': freshDatabaseScenario,
  'a 1.0.0-or-later table gains the library columns': releaseTableScenario,
  'an asset-id era table with rows is made nullable and cleared': assetIdEraWithRowsScenario,
  'an empty asset-id era table is made nullable': assetIdEraEmptyScenario,
  'the last old bootstrap precedes the new library migration': preRootsDropRecoveryScenario,
  'the library migration is atomic and a failed attempt is retried': clearingIsAtomicScenario,
  'the folder foreign key and name uniqueness hold': folderForeignKeyScenario,
} as const;
