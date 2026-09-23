/**
 * The document creation hooks on a real PostgreSQL, where transactions run on
 * separate connections: a host write is atomic with the course, a
 * transaction-scoped host lock is released with it, and concurrent creates of
 * one id by one owner run the hooks exactly once.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { PersistenceHooks } from '@/lib/server/persistence-hooks/types';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_host_create_hooks_test';
const OWNER = 'user:alice';
const NOW = 1_800_000_000_000;

function courseDocument(stageId: string, name = stageId) {
  return {
    stage: { id: stageId, name, createdAt: NOW, updatedAt: NOW },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe.skipIf(!contractUrl)('host create hooks on PostgreSQL', () => {
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
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${TEST_SCHEMA}`,
      max: 6,
    });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=host-create-hooks`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    await getServerPersistenceProvider(databaseUrl, () => pool);
    await pool.query('CREATE TABLE host_library (owner_id TEXT NOT NULL, stage_id TEXT NOT NULL)');
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE host_library');
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

  function store(createHooks: Pick<PersistenceHooks, 'name' | 'authorizeCreate' | 'onCreate'>) {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId: OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      createHooks,
    });
  }

  async function counts(stageId: string) {
    const one = async (sql: string) =>
      Number((await pool.query<{ n: string }>(sql, [stageId])).rows[0]!.n);
    return {
      stages: await one('SELECT COUNT(*) AS n FROM document_stages WHERE id = $1'),
      meta: await one('SELECT COUNT(*) AS n FROM stage_meta WHERE stage_id = $1'),
      host: await one('SELECT COUNT(*) AS n FROM host_library WHERE stage_id = $1'),
    };
  }

  const recordHostRow: PersistenceHooks['onCreate'] = async (tx, actor, stageId) => {
    await tx.query('INSERT INTO host_library (owner_id, stage_id) VALUES ($1, $2)', [
      actor.ownerId,
      stageId,
    ]);
  };

  it('commits the host row with the course, and rolls both back when onCreate throws', async () => {
    await store({ name: 'host', onCreate: recordHostRow }).saveDocument(
      courseDocument('stage-pg-ok'),
    );
    await expect(counts('stage-pg-ok')).resolves.toEqual({ stages: 1, meta: 1, host: 1 });

    const failing = store({
      name: 'host',
      onCreate: async (tx, actor, stageId) => {
        await recordHostRow!(tx, actor, stageId);
        throw new Error('host write failed');
      },
    });
    await expect(failing.saveDocument(courseDocument('stage-pg-fail'))).rejects.toThrow(
      'host write failed',
    );
    await expect(counts('stage-pg-fail')).resolves.toEqual({ stages: 0, meta: 0, host: 0 });
  });

  it('runs the hooks once for concurrent creates of one id, under a per-owner host lock', async () => {
    const onCreate = vi.fn(recordHostRow!);
    const hooks: Pick<PersistenceHooks, 'name' | 'authorizeCreate' | 'onCreate'> = {
      name: 'host',
      // A host-level per-owner lock, released with the create transaction.
      authorizeCreate: async (tx, actor) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.ownerId]);
        return { allow: true };
      },
      onCreate,
    };

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        store(hooks).saveDocument(courseDocument('stage-pg-race', `Attempt ${index}`)),
      ),
    );
    // Every attempt succeeds: one creates, the others commit as updates.
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(onCreate).toHaveBeenCalledTimes(1);
    await expect(counts('stage-pg-race')).resolves.toEqual({ stages: 1, meta: 1, host: 1 });

    // The lock is transaction-scoped: nothing is left held.
    const held = await pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted",
    );
    expect(Number(held.rows[0]!.n)).toBe(0);
  });

  it('gates concurrent operations on one shared store instance by their own operation', async () => {
    const onCreate = vi.fn(recordHostRow!);
    // One instance for every call, as an agent run shares one store with all
    // of its tools; each call runs on its own pooled connection.
    const shared = store({ name: 'host', onCreate });
    await shared.saveDocument(courseDocument('stage-pg-shared-read'));
    onCreate.mockClear();

    const results = await Promise.allSettled([
      shared.saveDocument(courseDocument('stage-pg-shared-a')),
      shared.loadDocument('stage-pg-shared-read'),
      shared.saveDocument(courseDocument('stage-pg-shared-b')),
      shared.loadDocument('stage-pg-shared-missing'),
      shared.saveDocument(courseDocument('stage-pg-shared-c')),
    ]);

    expect(results.map((result) => result.status)).toEqual(Array(5).fill('fulfilled'));
    for (const id of ['stage-pg-shared-a', 'stage-pg-shared-b', 'stage-pg-shared-c']) {
      await expect(counts(id)).resolves.toEqual({ stages: 1, meta: 1, host: 1 });
    }
    expect(onCreate.mock.calls.map((call) => call[2]).sort()).toEqual([
      'stage-pg-shared-a',
      'stage-pg-shared-b',
      'stage-pg-shared-c',
    ]);
  });
});
