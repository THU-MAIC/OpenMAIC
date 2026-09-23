import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type {
  DocumentActor,
  PersistenceHooks,
  Queryable,
} from '@/lib/server/persistence-hooks/types';

/**
 * The document creation hooks, end to end: the real persistence and
 * `/api/stages` routes, the real owner-bound store on an in-memory PostgreSQL,
 * and the built-in anonymous cookie authenticator.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const COOKIE = '11111111-1111-4111-8111-111111111111';
const OWNER = `anon:${COOKIE}`;
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

const HOST_TABLE = 'CREATE TABLE host_library (owner_id TEXT NOT NULL, stage_id TEXT NOT NULL)';

describe('host document creation hooks', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://create-hooks-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await pool.query(HOST_TABLE);
  });

  afterEach(async () => {
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function configure(hooks: Omit<PersistenceHooks, 'name'>) {
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    configurePersistenceHooks({ name: 'test-host', ...hooks });
  }

  async function putDocument(stageId: string, name?: string): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, {
        method: 'PUT',
        headers: { cookie: `anonymous_id=${COOKIE}`, 'content-type': 'application/json' },
        body: JSON.stringify(courseDocument(stageId, name)),
      }),
      { poolFactory: () => pool as never },
    );
  }

  async function postStage(name = 'New course'): Promise<Response> {
    const { POST } = await import('@/app/api/stages/route');
    return POST(
      new NextRequest('http://localhost/api/stages', {
        method: 'POST',
        headers: { cookie: `anonymous_id=${COOKIE}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  }

  async function rowCounts(stageId: string) {
    const count = async (sql: string) =>
      Number(((await pool.query(sql, [stageId])).rows[0] as { n: number | string }).n);
    return {
      stages: await count('SELECT COUNT(*) AS n FROM document_stages WHERE id = $1'),
      meta: await count('SELECT COUNT(*) AS n FROM stage_meta WHERE stage_id = $1'),
      host: await count('SELECT COUNT(*) AS n FROM host_library WHERE stage_id = $1'),
    };
  }

  it('creates exactly as before when no hook is registered', async () => {
    const response = await putDocument('stage-default');
    expect(response.status).toBe(204);
    await expect(rowCounts('stage-default')).resolves.toEqual({ stages: 1, meta: 1, host: 0 });
  });

  it('runs authorizeCreate then onCreate once, inside the create transaction, with the request principal', async () => {
    const calls: Array<{ hook: string; actor: DocumentActor; stageId: string }> = [];
    await configure({
      authorizeCreate: async (tx, actor, stageId) => {
        calls.push({ hook: 'authorizeCreate', actor, stageId });
        // Inside the transaction: the course rows written by it are visible.
        const own = await tx.query<{ owner_id: string }>(
          'SELECT owner_id FROM stage_meta WHERE stage_id = $1',
          [stageId],
        );
        expect(own.rows[0]?.owner_id).toBe(actor.ownerId);
        return { allow: true };
      },
      onCreate: async (tx, actor, stageId) => {
        calls.push({ hook: 'onCreate', actor, stageId });
        await tx.query('INSERT INTO host_library (owner_id, stage_id) VALUES ($1, $2)', [
          actor.ownerId,
          stageId,
        ]);
      },
    });

    expect((await putDocument('stage-hooked')).status).toBe(204);
    expect(calls.map((call) => call.hook)).toEqual(['authorizeCreate', 'onCreate']);
    for (const call of calls) {
      expect(call.stageId).toBe('stage-hooked');
      expect(call.actor.ownerId).toBe(OWNER);
      expect(call.actor.source).toBe('request');
      const principal = call.actor.principal as OwnerPrincipal;
      expect(principal.ownerId).toBe(OWNER);
      expect(principal.kind).toBe('anonymous');
    }
    await expect(rowCounts('stage-hooked')).resolves.toEqual({ stages: 1, meta: 1, host: 1 });
  });

  it('does not call the create hooks when an existing course is saved again or edited', async () => {
    const hook = vi.fn(async () => ({ allow: true as const }));
    const onCreate = vi.fn(async () => {});
    await configure({ authorizeCreate: hook, onCreate });
    expect((await putDocument('stage-existing')).status).toBe(204);
    expect(onCreate).toHaveBeenCalledTimes(1);
    hook.mockClear();
    onCreate.mockClear();

    expect((await putDocument('stage-existing', 'Renamed')).status).toBe(204);
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const stagePut = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/stage-existing/stage', {
        method: 'PUT',
        headers: { cookie: `anonymous_id=${COOKIE}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'stage-existing',
          name: 'Again',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      }),
      { poolFactory: () => pool as never },
    );
    expect(stagePut.status).toBe(204);
    expect(hook).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('rolls the whole create back when onCreate throws: no course, no ownership row, no host row', async () => {
    await configure({
      onCreate: async (tx, actor, stageId) => {
        await tx.query('INSERT INTO host_library (owner_id, stage_id) VALUES ($1, $2)', [
          actor.ownerId,
          stageId,
        ]);
        throw new Error('host library unavailable');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await putDocument('stage-atomic');
    expect(response.status).toBe(500);
    await expect(rowCounts('stage-atomic')).resolves.toEqual({ stages: 0, meta: 0, host: 0 });
  });

  it('answers 403 CREATE_REFUSED on the persistence route and writes nothing', async () => {
    const onCreate = vi.fn(async () => {});
    await configure({
      authorizeCreate: async () => ({ allow: false, message: 'this account was merged' }),
      onCreate,
    });

    const response = await putDocument('stage-refused');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CREATE_REFUSED', message: 'this account was merged' },
    });
    expect(onCreate).not.toHaveBeenCalled();
    await expect(rowCounts('stage-refused')).resolves.toEqual({ stages: 0, meta: 0, host: 0 });
  });

  it('answers 403 CREATE_REFUSED on POST /api/stages and writes nothing', async () => {
    await configure({ authorizeCreate: async () => ({ allow: false }) });

    const response = await postStage();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'CREATE_REFUSED' });
    const stages = await pool.query('SELECT COUNT(*) AS n FROM document_stages');
    expect(Number((stages.rows[0] as { n: number }).n)).toBe(0);
  });

  it('passes the request principal to the hooks from POST /api/stages', async () => {
    const actors: DocumentActor[] = [];
    await configure({
      onCreate: async (_tx, actor) => {
        actors.push(actor);
      },
    });

    const response = await postStage();
    expect(response.status).toBe(201);
    expect(actors).toHaveLength(1);
    expect(actors[0]!.source).toBe('request');
    expect(actors[0]!.principal?.ownerId).toBe(OWNER);
  });

  it('treats a malformed authorizeCreate answer as a failure that rolls back', async () => {
    await configure({ authorizeCreate: async () => 'yes' as never });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await putDocument('stage-malformed')).status).toBe(500);
    await expect(rowCounts('stage-malformed')).resolves.toEqual({ stages: 0, meta: 0, host: 0 });
  });

  it('gives a background run (owner id only) an actor without a principal', async () => {
    const actors: DocumentActor[] = [];
    await configure({
      onCreate: async (_tx, actor) => {
        actors.push(actor);
      },
    });
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const store = await getOwnerScopedDocumentStore(OWNER);
    await store.saveDocument(courseDocument('stage-agent') as never);

    expect(actors).toEqual([{ source: 'background', ownerId: OWNER }]);
  });

  it('carries a fixed refusal message on background writes, never the host text', async () => {
    await configure({
      authorizeCreate: async () => ({ allow: false, message: 'host-only detail' }),
    });
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const { BACKGROUND_CREATE_REFUSED_MESSAGE } =
      await import('@/lib/persistence/owner-bound-document-store');
    const store = await getOwnerScopedDocumentStore(OWNER);

    const failure = store.saveDocument(courseDocument('stage-agent-refused') as never);
    await expect(failure).rejects.toMatchObject({
      name: 'DocumentWriteRefusedError',
      code: 'CREATE_REFUSED',
      message: BACKGROUND_CREATE_REFUSED_MESSAGE,
    });
    await expect(rowCounts('stage-agent-refused')).resolves.toEqual({
      stages: 0,
      meta: 0,
      host: 0,
    });
  });

  it('refuses a principal that does not match the store owner', async () => {
    const { createOwnerBoundDocumentStore } =
      await import('@/lib/persistence/owner-bound-document-store');
    expect(() =>
      createOwnerBoundDocumentStore({
        pool,
        ownerId: OWNER,
        principal: {
          ownerId: 'someone-else',
          kind: 'user',
          roles: new Set(),
          assurance: 'verified',
        },
        validateScene: () => ({ valid: true }),
        validateStage: () => ({ valid: true }),
      }),
    ).toThrow(/principal does not match/);
  });

  it('runs the create hooks once when the same new id is saved twice', async () => {
    const onCreate = vi.fn(async (_tx: Queryable) => {});
    await configure({ onCreate });
    const first = await putDocument('stage-once');
    const second = await putDocument('stage-once');
    expect([first.status, second.status]).toEqual([204, 204]);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('gates concurrent operations on one shared store by their own operation', async () => {
    // One store instance, as an agent run shares with all of its tools. A
    // create running beside a read on it must still be gated as a create:
    // ownership row claimed, hooks run for its own stage id.
    const { createOwnerBoundDocumentStore } =
      await import('@/lib/persistence/owner-bound-document-store');
    const { validateAppScene, validateAppStage } = await import('@/lib/document-store/validators');
    const onCreate = vi.fn(async (_tx: Queryable, _actor: DocumentActor, _stageId: string) => {});
    const shared = createOwnerBoundDocumentStore({
      pool,
      ownerId: OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      createHooks: { name: 'host', onCreate },
    });
    await shared.saveDocument(courseDocument('stage-read') as never);
    onCreate.mockClear();

    await Promise.all([
      shared.saveDocument(courseDocument('stage-a') as never),
      shared.loadDocument('stage-read'),
      shared.saveDocument(courseDocument('stage-b') as never),
      shared.loadDocument('stage-missing'),
    ]);

    await expect(rowCounts('stage-a')).resolves.toMatchObject({ stages: 1, meta: 1 });
    await expect(rowCounts('stage-b')).resolves.toMatchObject({ stages: 1, meta: 1 });
    expect(onCreate.mock.calls.map((call) => call[2]).sort()).toEqual(['stage-a', 'stage-b']);
  });

  it('warns, with a count, when the boot backfill adopts owned courses without hooks', async () => {
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ('stage-legacy', 'Legacy', 1, 1, $1, '{}'::jsonb)`,
      [OWNER],
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');

    await ensureStageMetaSchema(pool as never);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adopted 1 owned course\(s\)/));
    await expect(rowCounts('stage-legacy')).resolves.toMatchObject({ meta: 1 });

    warn.mockClear();
    await ensureStageMetaSchema(pool as never);
    expect(warn).not.toHaveBeenCalled();
  });
});
