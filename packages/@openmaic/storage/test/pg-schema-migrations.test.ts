import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AGENT_SESSION_PG_MIGRATIONS, ensureAgentSessionSchema } from '../src/agent-session/pg.js';
import { ASSET_PG_MIGRATIONS, ensureAssetSchema } from '../src/asset/pg.js';
import { DOCUMENT_PG_MIGRATIONS, ensureDocumentSchema } from '../src/document/pg.js';
import {
  AGENT_SESSION_MATERIAL_PG_MIGRATIONS,
  ensureAgentSessionMaterialSchema,
} from '../src/material/pg.js';
import {
  SchemaMigrationChecksumError,
  SchemaVersionAheadError,
  applySchemaMigrations,
  schemaMigrationChecksum,
  splitSqlStatements,
  type MigrationQueryable,
  type SchemaMigrationSet,
} from '../src/pg-migrations.js';
import { RUNTIME_PG_MIGRATIONS, ensureSchema } from '../src/runtime/pg.js';
import { USER_SKILL_PG_MIGRATIONS, ensureUserSkillSchema } from '../src/skill/pg.js';
import { provisionRelease11Storage } from './schema-release-1-1.js';

/** Every package store, in the order a host provisions them. */
const STORES = [
  { set: RUNTIME_PG_MIGRATIONS, ensure: ensureSchema },
  { set: DOCUMENT_PG_MIGRATIONS, ensure: ensureDocumentSchema },
  { set: ASSET_PG_MIGRATIONS, ensure: ensureAssetSchema },
  { set: AGENT_SESSION_PG_MIGRATIONS, ensure: ensureAgentSessionSchema },
  { set: AGENT_SESSION_MATERIAL_PG_MIGRATIONS, ensure: ensureAgentSessionMaterialSchema },
  { set: USER_SKILL_PG_MIGRATIONS, ensure: ensureUserSkillSchema },
];

async function ensureAll(queryable: MigrationQueryable): Promise<void> {
  for (const { ensure } of STORES) await ensure(queryable);
}

interface RecordRow extends Record<string, unknown> {
  store: string;
  version: number;
  name: string;
  checksum: string;
}

async function records(db: PGlite, store?: string): Promise<RecordRow[]> {
  const result = await db.query<RecordRow>(
    `SELECT store, version, name, checksum FROM openmaic_schema_migrations
      ${store === undefined ? '' : 'WHERE store = $1'}
      ORDER BY store, version`,
    store === undefined ? [] : [store],
  );
  return result.rows;
}

async function columnExists(db: PGlite, table: string, column: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column],
  );
  return result.rows[0]?.present === true;
}

describe('schema migrations with PGlite', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await db.close();
  });

  test('a fresh database gets every migration of every store, recorded with its checksum', async () => {
    await ensureAll(db);

    const expected: RecordRow[] = [];
    for (const { set } of STORES) {
      for (const migration of set.migrations) {
        expected.push({
          store: set.store,
          version: migration.version,
          name: migration.name,
          checksum: await schemaMigrationChecksum(migration),
        });
      }
    }
    const byKey = (row: RecordRow) => `${row.store}\u0000${row.version}`;
    expect((await records(db)).map(byKey).sort()).toEqual(expected.map(byKey).sort());
    expect(await records(db)).toEqual(
      expect.arrayContaining(expected.map((row) => expect.objectContaining(row))),
    );
  });

  test('a later start applies nothing and issues no schema statement', async () => {
    await ensureAll(db);
    const statements: string[] = [];
    const recording: MigrationQueryable = {
      query: (text, params) => {
        statements.push(text);
        return db.query(text, params);
      },
    };

    await ensureAll(recording);

    // Per store: the lock, the record table, the version read, the unlock.
    expect(statements).toHaveLength(STORES.length * 4);
    expect(statements.every((sql) => /pg_advisory|openmaic_schema_migrations/.test(sql))).toBe(
      true,
    );
  });

  test('upgrades a database a 1.1.x start provisioned, keeping its rows', async () => {
    await provisionRelease11Storage(db);
    await db.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ('legacy', 'Legacy', 1, 1, 'owner-a', '{"id":"legacy"}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO agent_owner_session_events (owner_id, id, ts, session_id, type, data)
       VALUES ('owner-a', 1, 1, 's', 'session_title', '{}'::jsonb)`,
    );

    await ensureAll(db);

    expect((await records(db, 'document')).map((row) => row.version)).toEqual([1, 2]);
    // The retired column stays for one release, nullable; its indexes are gone.
    expect(await columnExists(db, 'document_stages', 'owner_id')).toBe(true);
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'document_stages' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'document_stages_folder_idx',
      'document_stages_pkey',
    ]);
    const stages = await db.query('SELECT id, owner_id FROM document_stages');
    expect(stages.rows).toEqual([{ id: 'legacy', owner_id: 'owner-a' }]);
    expect((await db.query('SELECT 1 FROM agent_owner_session_events')).rows).toHaveLength(1);
  });

  test('a one-time migration runs exactly once across restarts', async () => {
    const runs = vi.fn(async (queryable: MigrationQueryable) => {
      await queryable.query('INSERT INTO probe_runs DEFAULT VALUES');
    });
    const set: SchemaMigrationSet = {
      store: 'probe',
      migrations: [
        {
          version: 1,
          name: 'baseline',
          up: 'CREATE TABLE IF NOT EXISTS probe_runs (at TIMESTAMPTZ DEFAULT now())',
        },
        { version: 2, name: 'backfill', up: runs },
      ],
    };

    await expect(applySchemaMigrations(db, set)).resolves.toEqual([1, 2]);
    await expect(applySchemaMigrations(db, set)).resolves.toEqual([]);
    await expect(applySchemaMigrations(db, set)).resolves.toEqual([]);

    expect(runs).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT 1 FROM probe_runs')).rows).toHaveLength(1);
  });

  test('applies only the migrations a database is missing, in order', async () => {
    const v1: SchemaMigrationSet = {
      store: 'probe',
      migrations: [{ version: 1, name: 'baseline', up: 'CREATE TABLE probe (id TEXT)' }],
    };
    const v3: SchemaMigrationSet = {
      store: 'probe',
      migrations: [
        ...v1.migrations,
        { version: 2, name: 'add_a', up: 'ALTER TABLE probe ADD COLUMN a TEXT' },
        { version: 3, name: 'add_b', up: 'ALTER TABLE probe ADD COLUMN b TEXT' },
      ],
    };

    await expect(applySchemaMigrations(db, v1)).resolves.toEqual([1]);
    await expect(applySchemaMigrations(db, v3)).resolves.toEqual([2, 3]);
    expect(await columnExists(db, 'probe', 'b')).toBe(true);
  });

  test('refuses to run against a database a newer release upgraded', async () => {
    await ensureDocumentSchema(db);
    await db.query(
      `INSERT INTO openmaic_schema_migrations (store, version, name, checksum)
       VALUES ('document', 3, 'from_a_newer_release', 'x')`,
    );

    const refusal = ensureDocumentSchema(db);
    await expect(refusal).rejects.toBeInstanceOf(SchemaVersionAheadError);
    await expect(refusal).rejects.toMatchObject({
      store: 'document',
      recordedVersion: 3,
      knownVersion: 2,
      message: expect.stringMatching(/schema version 3 of "document".*refusing to start/),
    });
    // The refusal released the lock: the next call is not blocked behind it.
    await expect(ensureSchema(db)).resolves.toBeUndefined();
  });

  test('an edited applied migration fails a development or test start', async () => {
    await ensureSchema(db);
    const edited: SchemaMigrationSet = {
      store: 'runtime',
      migrations: [
        { version: 1, name: 'baseline', up: 'CREATE TABLE IF NOT EXISTS other (id TEXT)' },
      ],
    };

    vi.stubEnv('NODE_ENV', 'test');
    await expect(applySchemaMigrations(db, edited)).rejects.toBeInstanceOf(
      SchemaMigrationChecksumError,
    );
    vi.stubEnv('NODE_ENV', 'development');
    await expect(applySchemaMigrations(db, edited)).rejects.toBeInstanceOf(
      SchemaMigrationChecksumError,
    );
  });

  test('an edited applied migration only warns in production, and is not run again', async () => {
    await ensureSchema(db);
    const edited: SchemaMigrationSet = {
      store: 'runtime',
      migrations: [
        { version: 1, name: 'baseline', up: 'CREATE TABLE IF NOT EXISTS other (id TEXT)' },
      ],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.stubEnv('NODE_ENV', 'production');
    await expect(applySchemaMigrations(db, edited)).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/migration 1 of "runtime".*edited/));
    const other = await db.query(`SELECT to_regclass('other') IS NOT NULL AS present`);
    expect(other.rows).toEqual([{ present: false }]);
  });

  test('a failing migration rolls back with its record and names itself', async () => {
    const set: SchemaMigrationSet = {
      store: 'probe',
      migrations: [
        { version: 1, name: 'baseline', up: 'CREATE TABLE probe (id TEXT)' },
        {
          version: 2,
          name: 'broken',
          up: 'ALTER TABLE probe ADD COLUMN a TEXT; ALTER TABLE missing ADD COLUMN b TEXT',
        },
      ],
    };

    await expect(applySchemaMigrations(db, set)).rejects.toThrow(
      /schema migration 2 \(broken\) of "probe" failed: .*missing/,
    );

    expect((await records(db, 'probe')).map((row) => row.version)).toEqual([1]);
    expect(await columnExists(db, 'probe', 'a')).toBe(false);
  });

  test('a migration that opts out of the transaction keeps what ran and stays unrecorded', async () => {
    const set: SchemaMigrationSet = {
      store: 'probe',
      migrations: [
        {
          version: 1,
          name: 'outside',
          transaction: false,
          up: 'CREATE TABLE IF NOT EXISTS probe (id TEXT); ALTER TABLE missing ADD COLUMN b TEXT',
        },
      ],
    };

    await expect(applySchemaMigrations(db, set)).rejects.toThrow(/outside/);

    expect(await records(db, 'probe')).toEqual([]);
    expect(await columnExists(db, 'probe', 'id')).toBe(true);
  });

  test('refuses a set that is not numbered 1, 2, 3, ...', async () => {
    await expect(
      applySchemaMigrations(db, {
        store: 'probe',
        migrations: [
          { version: 1, name: 'baseline', up: 'SELECT 1' },
          { version: 3, name: 'skipped', up: 'SELECT 1' },
        ],
      }),
    ).rejects.toThrow(/numbered 1, 2, 3/);
  });

  test('overridden table names are a store of their own, with the declared checksums', async () => {
    await ensureUserSkillSchema(db);
    await ensureUserSkillSchema(db, { skills: 'custom_skill' });

    const custom = await records(db, 'user-skill:custom_skill');
    expect(custom).toEqual([
      expect.objectContaining({
        version: 1,
        checksum: await schemaMigrationChecksum(USER_SKILL_PG_MIGRATIONS.migrations[0]!),
      }),
    ]);
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('agent_user_skill', 'custom_skill') ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(['agent_user_skill', 'custom_skill']);
  });

  test('checks a single connection out of a pool for the whole run', async () => {
    const released = vi.fn();
    const viaPool = vi.fn();
    const pool = {
      query: viaPool,
      connect: async () => ({
        query: (text: string, params?: unknown[]) => db.query(text, params),
        release: released,
      }),
    };

    await ensureSchema(pool as unknown as MigrationQueryable);

    expect(viaPool).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
    expect((await records(db, 'runtime')).map((row) => row.version)).toEqual([1]);
  });

  test('the splitter keeps a last statement that has no semicolon', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(splitSqlStatements('SELECT 1;\n')).toEqual(['SELECT 1']);
  });
});
