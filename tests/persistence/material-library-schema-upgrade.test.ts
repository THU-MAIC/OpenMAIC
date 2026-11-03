import { readMaterialExtractionResult } from '@/lib/server/materials/extraction';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it, vi } from 'vitest';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import { ASSET_PG_MIGRATIONS, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import {
  AGENT_SESSION_PG_MIGRATIONS,
  ensureAgentSessionSchema,
} from '@openmaic/storage/agent-session/pg';
import {
  AGENT_SESSION_MATERIAL_PG_MIGRATIONS,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';
import {
  OWNER_MATERIAL_MIGRATIONS,
  ensureOwnerMaterialSchema,
  sweepUnusedOwnerMaterials,
  getOwnerMaterial,
  startOwnerMaterialExtractions,
} from '@/lib/persistence/owner-materials';
import {
  listOwnerLibrary,
  ensureSessionMaterialLinkSchema,
} from '@/lib/persistence/session-material-links';

let db: PGlite;
afterEach(async () => {
  await db?.close();
});

it('appends library migrations to a recorded main schema without losing material metadata', async () => {
  db = new PGlite();
  await db.waitReady;
  for (const [set, version] of [
    [ASSET_PG_MIGRATIONS, 1],
    [AGENT_SESSION_PG_MIGRATIONS, 2],
    [AGENT_SESSION_MATERIAL_PG_MIGRATIONS, 1],
    [OWNER_MATERIAL_MIGRATIONS, 4],
  ] as const) {
    await applySchemaMigrations(db, {
      ...set,
      migrations: set.migrations.filter((m) => m.version <= version),
    });
  }
  await db.query(`INSERT INTO owner_material (id, owner_id, kind, bytes, oss_key, status, extraction, created_at)
    VALUES ('existing', 'owner', 'source', 42, 'original-key', 'ready', '{"status":"ready","resultKey":"parsed-key"}', 1)`);
  for (let boot = 0; boot < 2; boot++) {
    await ensureAssetSchema(db);
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    await ensureOwnerMaterialSchema(db);
    await ensureSessionMaterialLinkSchema(db);
  }
  const rows = await db.query(
    `SELECT oss_key, extraction, retention FROM owner_material WHERE id = 'existing'`,
  );
  expect(rows.rows).toEqual([
    {
      retention: 'temporary',
      oss_key: 'original-key',
      extraction: { status: 'ready', resultKey: 'parsed-key' },
    },
  ]);
  expect(
    (await listOwnerLibrary(db, 'owner', { withTextOnly: true })).map((row) => row.id),
  ).toEqual(['existing']);
  expect(await listOwnerLibrary(db, 'foreign')).toEqual([]);
  const existing = await getOwnerMaterial(db, 'owner', 'existing');
  const oldResult = { version: 1, text: 'already parsed before upgrade', images: [] };
  const get = vi.fn(async () => Buffer.from(JSON.stringify(oldResult)));
  expect(
    await readMaterialExtractionResult(existing!, {
      get,
      put: vi.fn(),
      delete: vi.fn(),
      deletePrefix: vi.fn(),
      list: vi.fn(),
    }),
  ).toEqual(oldResult);
  expect(get).toHaveBeenCalledExactlyOnceWith('parsed-key');
  const columns = await db.query<{
    table_name: string;
    column_name: string;
  }>(`SELECT table_name, column_name FROM information_schema.columns
    WHERE (table_name = 'agent_sessions' AND column_name = 'locale')
       OR (table_name = 'agent_session_materials' AND column_name = 'extraction_reason_code')
       OR (table_name = 'owner_material' AND column_name = 'asset_id')`);
  expect(columns.rows).toHaveLength(3);
  expect((await db.query(`SELECT * FROM asset_root_refs`)).rows).toEqual([]);
  expect((await db.query(`SELECT * FROM agent_session_material_links`)).rows).toEqual([]);
});

it('cleanup keeps all successful uploads regardless of historical retention', async () => {
  db = new PGlite();
  await db.waitReady;
  await ensureOwnerMaterialSchema(db);
  await db.query(`CREATE TABLE generation_runs (id TEXT, owner_id TEXT, input JSONB, state TEXT)`);
  for (const [id, retention] of [
    ['temp', 'temporary'],
    ['lib', 'library'],
  ] as const) {
    await db.query(
      `INSERT INTO owner_material
      (id, owner_id, kind, bytes, oss_key, status, extraction, created_at, retention)
      VALUES ($1, 'owner', 'source', 1, $1, 'ready', '{"status":"idle"}', 1, $2)`,
      [id, retention],
    );
  }
  expect((await listOwnerLibrary(db, 'owner')).map((row) => row.id)).toEqual(['temp', 'lib']);
  expect(
    (await startOwnerMaterialExtractions(db, 'owner', ['temp', 'lib'], ['idle'])).sort(),
  ).toEqual(['lib', 'temp'].sort());
  const deleteObjects = vi.fn(async () => {});
  expect(await sweepUnusedOwnerMaterials(db, { untouchedBefore: 2, deleteObjects })).toEqual({
    marked: 0,
    removed: 0,
  });
  expect(deleteObjects).not.toHaveBeenCalled();
  expect(await getOwnerMaterial(db, 'owner', 'lib')).toMatchObject({
    extraction: { status: 'extracting' },
  });
});
