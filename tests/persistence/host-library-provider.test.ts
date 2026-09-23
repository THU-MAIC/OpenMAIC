import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryListContext } from '@/lib/server/persistence-hooks/types';

/**
 * `GET /api/stages` with and without a host library provider, on the real
 * route, the real owner-bound store and an in-memory PostgreSQL.
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

const ALICE_COOKIE = '11111111-1111-4111-8111-111111111111';
const BOB_COOKIE = '22222222-2222-4222-8222-222222222222';
const ALICE = `anon:${ALICE_COOKIE}`;
const BOB = `anon:${BOB_COOKIE}`;
const NOW = 1_800_000_000_000;

function courseDocument(stageId: string) {
  return {
    stage: { id: stageId, name: `Course ${stageId}`, createdAt: NOW, updatedAt: NOW },
    scenes: [],
    outline: {
      outlines: [],
      requirement: stageId,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe('library provider', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://library-${randomUUID()}`);
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

    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const alice = await getOwnerScopedDocumentStore(ALICE);
    const bob = await getOwnerScopedDocumentStore(BOB);
    await alice.saveDocument(courseDocument('stage-alice-b') as never);
    await alice.saveDocument(courseDocument('stage-alice-a') as never);
    await alice.createFolder('folder-alice', 'Alice folder');
    await alice.moveDocumentToFolder('stage-alice-a', 'folder-alice');
    await bob.saveDocument(courseDocument('stage-bob-live') as never);
    await bob.createFolder('folder-bob', 'Bob folder');
    await bob.moveDocumentToFolder('stage-bob-live', 'folder-bob');
    await bob.saveDocument(courseDocument('stage-bob-deleted') as never);
    await bob.deleteDocument('stage-bob-deleted');
    // A document row nobody claimed: the read path refuses it ('unclaimed').
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       SELECT 'stage-unclaimed', name, created_at, updated_at, data
         FROM document_stages WHERE id = 'stage-bob-live'`,
    );
    // Seeding went through the stores, which sealed the (empty) registration;
    // each test registers its own, as a fresh process would.
    resetPersistenceHooksForTests();
  });

  afterEach(async () => {
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function listAsAlice(): Promise<{ status: number; body: { stages: unknown[] } }> {
    const { GET } = await import('@/app/api/stages/route');
    const response = await GET(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ALICE_COOKIE}` },
      }),
    );
    return { status: response.status, body: (await response.json()) as { stages: unknown[] } };
  }

  async function readAsAlice(stageId: string): Promise<number> {
    const { GET } = await import('@/app/api/stages/[id]/route');
    const response = await GET(
      new NextRequest(`http://localhost/api/stages/${stageId}`, {
        headers: { cookie: `anonymous_id=${ALICE_COOKIE}` },
      }),
      { params: Promise.resolve({ id: stageId }) },
    );
    return response.status;
  }

  it('lists the owner’s own live courses when no provider is registered', async () => {
    const { status, body } = await listAsAlice();
    expect(status).toBe(200);
    expect(body.stages).toEqual([
      expect.objectContaining({ id: 'stage-alice-a', folderId: 'folder-alice', sceneCount: 0 }),
      expect.objectContaining({ id: 'stage-alice-b', name: 'Course stage-alice-b' }),
    ]);
  });

  it('lists what the provider chooses, in its order, as the same list items', async () => {
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    const contexts: LibraryListContext[] = [];
    configurePersistenceHooks({
      name: 'test-host',
      library: {
        name: 'saved-courses',
        async list(context) {
          contexts.push(context);
          return ['stage-bob-live', ...(await context.ownedStageIds()), 'stage-bob-live'];
        },
      },
    });

    const { status, body } = await listAsAlice();
    expect(status).toBe(200);
    expect(contexts[0]!.principal.ownerId).toBe(ALICE);
    expect(body.stages).toEqual([
      {
        id: 'stage-bob-live',
        name: 'Course stage-bob-live',
        createdAt: NOW,
        updatedAt: NOW,
        sceneCount: 0,
      },
      expect.objectContaining({ id: 'stage-alice-a', folderId: 'folder-alice' }),
      expect.objectContaining({ id: 'stage-alice-b' }),
    ]);
    // Another owner's folder is not reported; the listed course is readable.
    expect(body.stages[0]).not.toHaveProperty('folderId');
    expect(await readAsAlice('stage-bob-live')).toBe(200);
  });

  it('never lists an id the read path would refuse', async () => {
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    configurePersistenceHooks({
      name: 'test-host',
      library: {
        name: 'leaky',
        list: async () => [
          'stage-bob-deleted',
          'stage-unclaimed',
          'stage-missing',
          'stage-alice-b',
        ],
      },
    });

    const { body } = await listAsAlice();
    expect(body.stages).toEqual([expect.objectContaining({ id: 'stage-alice-b' })]);
    for (const refused of ['stage-bob-deleted', 'stage-unclaimed', 'stage-missing']) {
      expect(await readAsAlice(refused)).toBe(404);
    }
  });

  it('drops ids the read path cannot address instead of failing the listing', async () => {
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    configurePersistenceHooks({
      name: 'test-host',
      library: {
        name: 'echoing',
        list: async () => ['', '.', '..', 'stage\u0000nul', 'lone-\ud800', 'stage-alice-b'],
      },
    });

    const { status, body } = await listAsAlice();
    expect(status).toBe(200);
    expect(body.stages).toEqual([expect.objectContaining({ id: 'stage-alice-b' })]);
  });

  it('refuses a provider answer over the documented limit', async () => {
    const { MAX_LIBRARY_STAGE_IDS } = await import('@/lib/persistence/library');
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    configurePersistenceHooks({
      name: 'test-host',
      library: {
        name: 'unbounded',
        list: async () =>
          Array.from({ length: MAX_LIBRARY_STAGE_IDS + 1 }, (_, index) => `stage-${index}`),
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('@/app/api/stages/route');
    const response = await GET(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ALICE_COOKIE}` },
      }),
    );
    expect(response.status).toBe(500);
  });

  it('answers 500 for a provider that does not return stage ids', async () => {
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    configurePersistenceHooks({
      name: 'test-host',
      library: { name: 'broken', list: async () => [42] as never },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('@/app/api/stages/route');
    const response = await GET(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ALICE_COOKIE}` },
      }),
    );
    expect(response.status).toBe(500);
  });
});
