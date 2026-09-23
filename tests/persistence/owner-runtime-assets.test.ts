import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Runtime sessions and assets under the owner identity seam, end to end: the
 * real persistence route, the real storage handler and PostgreSQL stores (on
 * an in-memory database), and the built-in anonymous cookie authenticator. Two
 * cookies are two owners.
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
const ISO = new Date(NOW).toISOString();

type Who = 'alice' | 'bob';

function cookieOf(who: Who): string {
  return `anonymous_id=${who === 'alice' ? ALICE_COOKIE : BOB_COOKIE}`;
}

function imageScene(stageId: string, sceneId: string, assetId: string) {
  return {
    id: sceneId,
    stageId,
    order: 1,
    title: sceneId,
    type: 'slide',
    createdAt: NOW,
    updatedAt: NOW,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${sceneId}`,
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#2563eb'],
          fontColor: '#111827',
          fontName: 'Inter',
        },
        elements: [
          {
            id: `${sceneId}-image`,
            type: 'image',
            src: assetId,
            left: 0,
            top: 0,
            width: 100,
            height: 100,
          },
        ],
      },
    },
  };
}

function courseDocument(stageId: string, assetIds: string[] = []) {
  return {
    stage: { id: stageId, name: stageId, createdAt: NOW, updatedAt: NOW },
    scenes: assetIds.map((assetId, index) => imageScene(stageId, `scene-${index}`, assetId)),
    outline: {
      outlines: [],
      requirement: stageId,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function sessionInit(id: string, stageId: string, learnerKey: string) {
  return {
    id,
    stageId,
    learnerKey,
    kind: 'chat',
    status: 'active',
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function recordInit(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    createdAt: ISO,
    payload: { role: 'user', content: 'hello' },
  };
}

function assetForm(bytes: number[]): FormData {
  const form = new FormData();
  form.append('meta', new Blob([JSON.stringify({})], { type: 'application/json' }), 'meta');
  form.append('bytes', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'bytes');
  return form;
}

describe('runtime and assets are keyed by the resolved owner', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://owner-runtime-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    const { resetOwnerAuthenticatorForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticatorForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function call(
    who: Who,
    path: string,
    init: {
      method?: string;
      json?: unknown;
      body?: BodyInit;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const headers: Record<string, string> = { cookie: cookieOf(who), ...init.headers };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      }),
      { poolFactory: () => pool as never },
    );
  }

  async function saveCourse(who: Who, stageId: string, assetIds: string[] = []) {
    const response = await call(who, `/documents/${stageId}`, {
      method: 'PUT',
      json: courseDocument(stageId, assetIds),
    });
    expect(response.status).toBeLessThan(300);
  }

  async function allocate(who: Who, bytes: number[] = [1, 2, 3]): Promise<string> {
    const response = await call(who, '/assets', { method: 'POST', body: assetForm(bytes) });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  describe('runtime learner key', () => {
    it('tells the browser its learner key: the owner id, never a client-chosen value', async () => {
      const response = await call('alice', '/learner-key', {
        headers: { 'x-learner-key': BOB },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      await expect(response.json()).resolves.toEqual({ learnerKey: ALICE });

      const refused = await call('alice', '/learner-key', { method: 'POST' });
      expect(refused.status).toBe(405);
    });

    it('mints and returns the same identity for a browser without an owner cookie', async () => {
      const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
      const response = await handlePersistenceRequest(
        new Request('http://localhost/api/persistence/learner-key'),
        { poolFactory: () => pool as never },
      );
      const cookie = response.headers.get('set-cookie') ?? '';
      const minted = /anonymous_id=([^;]+)/.exec(cookie)?.[1];
      expect(minted).toBeDefined();
      await expect(response.json()).resolves.toEqual({ learnerKey: `anon:${minted}` });
    });

    it('works without any development token and ignores one that is sent', async () => {
      const created = await call('alice', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-no-token', 'stage-runtime', ALICE),
      });
      expect(created.status).toBe(201);

      // The retired development credential grants nothing: it is not read.
      vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'retired-token');
      const withToken = await call('bob', '/runtime/sessions/session-no-token', {
        headers: { authorization: 'Bearer retired-token', 'x-learner-key': ALICE },
      });
      expect(withToken.status).toBe(404);
    });

    it('keeps one owner out of another owner’s sessions whatever x-learner-key says', async () => {
      const created = await call('alice', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-alice', 'stage-runtime', ALICE),
      });
      expect(created.status).toBe(201);
      const appended = await call('alice', '/runtime/sessions/session-alice/records', {
        method: 'POST',
        json: recordInit('record-alice-1', 'session-alice'),
      });
      expect(appended.status).toBe(201);

      // Bob presents Alice's learner key the way the old client header did.
      const asAlice = { 'x-learner-key': ALICE };
      const read = await call('bob', '/runtime/sessions/session-alice', { headers: asAlice });
      expect(read.status).toBe(404);
      const records = await call('bob', '/runtime/sessions/session-alice/records', {
        headers: asAlice,
      });
      expect(records.status).toBe(404);
      const listed = await call('bob', `/runtime/stages/stage-runtime/learners/${ALICE}/sessions`, {
        headers: asAlice,
      });
      expect(listed.status).toBe(403);
      const write = await call('bob', '/runtime/sessions/session-alice/records', {
        method: 'POST',
        json: recordInit('record-bob-1', 'session-alice'),
        headers: asAlice,
      });
      expect(write.status).toBe(404);
      const status = await call('bob', '/runtime/sessions/session-alice/status', {
        method: 'PATCH',
        json: { status: 'completed', updatedAt: ISO },
        headers: asAlice,
      });
      expect(status.status).toBe(404);
      const impersonatedCreate = await call('bob', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-bob-as-alice', 'stage-runtime', ALICE),
        headers: asAlice,
      });
      expect(impersonatedCreate.status).toBe(403);
      const wipe = await call('bob', `/runtime/stages/stage-runtime/learners/${ALICE}`, {
        method: 'DELETE',
        headers: asAlice,
      });
      expect(wipe.status).toBe(403);

      // Alice's data is untouched and still hers.
      const own = await call('alice', `/runtime/stages/stage-runtime/learners/${ALICE}/sessions`);
      expect(own.status).toBe(200);
      await expect(own.json()).resolves.toMatchObject([{ id: 'session-alice', status: 'active' }]);
      const ownRecords = await call('alice', '/runtime/sessions/session-alice/records');
      await expect(ownRecords.json()).resolves.toMatchObject([{ id: 'record-alice-1' }]);
    });

    it('keeps learner merge refused (claims are a later phase)', async () => {
      const merge = await call('alice', '/runtime/learners/merge', {
        method: 'POST',
        json: { fromLearnerKey: BOB, toLearnerKey: ALICE },
      });
      expect(merge.status).toBe(403);
    });
  });

  describe('runtime of a deleted course', () => {
    it('reads as absent and refuses writes once the course is tombstoned', async () => {
      const stageId = 'stage-tombstoned';
      await saveCourse('alice', stageId);
      await call('alice', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-t', stageId, ALICE),
      });
      await call('alice', '/runtime/sessions/session-t/records', {
        method: 'POST',
        json: recordInit('record-t-1', 'session-t'),
      });
      expect((await call('alice', '/runtime/sessions/session-t')).status).toBe(200);

      const deleted = await call('alice', `/documents/${stageId}`, { method: 'DELETE' });
      expect(deleted.status).toBeLessThan(300);

      expect((await call('alice', '/runtime/sessions/session-t')).status).toBe(404);
      expect((await call('alice', '/runtime/sessions/session-t/records')).status).toBe(404);
      const listed = await call('alice', `/runtime/stages/${stageId}/learners/${ALICE}/sessions`);
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toEqual([]);

      const append = await call('alice', '/runtime/sessions/session-t/records', {
        method: 'POST',
        json: recordInit('record-t-2', 'session-t'),
      });
      expect(append.status).toBe(404);
      const status = await call('alice', '/runtime/sessions/session-t/status', {
        method: 'PATCH',
        json: { status: 'completed', updatedAt: ISO },
      });
      expect(status.status).toBe(404);
      const created = await call('alice', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-t-2', stageId, ALICE),
      });
      expect(created.status).toBe(404);
      await expect(created.json()).resolves.toMatchObject({ error: { code: 'STAGE_NOT_FOUND' } });

      // Nothing was written behind the refusals.
      const rows = await pool.query(
        'SELECT id FROM runtime_records WHERE session_id = $1 ORDER BY seq',
        ['session-t'],
      );
      expect(rows.rows).toEqual([{ id: 'record-t-1' }]);
    });

    it.each(['/runtime/%73essions', '/runtime/sess%69ons', '/%72untime/sessions'])(
      'refuses a new session on a deleted course however the path is spelled (%s)',
      async (spelling) => {
        const stageId = 'stage-tombstoned-encoded';
        await saveCourse('alice', stageId);
        await call('alice', `/documents/${stageId}`, { method: 'DELETE' });

        const created = await call('alice', spelling, {
          method: 'POST',
          json: sessionInit('session-encoded', stageId, ALICE),
        });

        expect(created.status).toBe(404);
        await expect(created.json()).resolves.toMatchObject({
          error: { code: 'STAGE_NOT_FOUND' },
        });
        const rows = await pool.query('SELECT id FROM runtime_sessions WHERE stage_id = $1', [
          stageId,
        ]);
        expect(rows.rows).toEqual([]);
      },
    );

    it('answers a taken id with 409 even when its session is hidden by a tombstone', async () => {
      const stageId = 'stage-tombstoned-collision';
      await saveCourse('alice', stageId);
      await call('alice', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-hidden', stageId, ALICE),
      });
      await call('alice', `/documents/${stageId}`, { method: 'DELETE' });
      expect((await call('alice', '/runtime/sessions/session-hidden')).status).toBe(404);

      for (const who of ['alice', 'bob'] as const) {
        const created = await call(who, '/runtime/sessions', {
          method: 'POST',
          json: sessionInit(
            'session-hidden',
            'stage-live-elsewhere',
            who === 'alice' ? ALICE : BOB,
          ),
        });
        expect(created.status).toBe(409);
        await expect(created.json()).resolves.toMatchObject({
          error: { code: 'SESSION_ALREADY_EXISTS' },
        });
      }
    });

    it('leaves runtime of a course this server never stored alone', async () => {
      const created = await call('alice', '/runtime/sessions', {
        method: 'POST',
        json: sessionInit('session-local', 'stage-local-only', ALICE),
      });
      expect(created.status).toBe(201);
      expect((await call('alice', '/runtime/sessions/session-local')).status).toBe(200);
    });
  });

  describe('per-owner assets', () => {
    async function principalOf(assetId: string): Promise<string | undefined> {
      const result = await pool.query('SELECT principal FROM asset_entries WHERE id = $1', [
        assetId,
      ]);
      return (result.rows[0] as { principal?: string } | undefined)?.principal;
    }

    it('allocates in the caller’s own partition', async () => {
      const id = await allocate('alice');
      expect(await principalOf(id)).toBe(`owner:${ALICE}`);
    });

    it('keeps a pending allocation private, and serves it to viewers once a live course names it', async () => {
      const id = await allocate('alice');
      expect((await call('alice', `/assets/${id}/content`)).status).toBe(200);
      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
      expect((await call('bob', `/assets/${id}/content`, { method: 'HEAD' })).status).toBe(404);

      await saveCourse('alice', 'stage-media', [id]);
      const viewed = await call('bob', `/assets/${id}/content`);
      expect(viewed.status).toBe(200);
      expect(new Uint8Array(await viewed.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect((await call('bob', `/assets/${id}/content`, { method: 'HEAD' })).status).toBe(200);

      // Deleting the course withdraws its claim, and viewers lose the media.
      await call('alice', '/documents/stage-media', { method: 'DELETE' });
      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
      expect((await call('alice', `/assets/${id}/content`)).status).toBe(200);
    });

    it('lets only the owner replace or delete, even a media a viewer can read', async () => {
      const id = await allocate('alice');
      await saveCourse('alice', 'stage-owned-media', [id]);

      const foreignPut = await call('bob', `/assets/${id}/content`, {
        method: 'PUT',
        body: assetForm([9]),
      });
      expect(foreignPut.status).toBe(404);
      const foreignDelete = await call('bob', `/assets/${id}`, { method: 'DELETE' });
      expect(foreignDelete.status).toBe(204);
      const afterForeign = await call('bob', `/assets/${id}/content`);
      expect(new Uint8Array(await afterForeign.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const ownPut = await call('alice', `/assets/${id}/content`, {
        method: 'PUT',
        body: assetForm([7, 7]),
      });
      expect(ownPut.status).toBe(204);
      const replaced = await call('bob', `/assets/${id}/content`);
      expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(new Uint8Array([7, 7]));

      const ownDelete = await call('alice', `/assets/${id}`, { method: 'DELETE' });
      expect(ownDelete.status).toBe(204);
      expect(await principalOf(id)).toBeUndefined();
    });

    it('accounts quota per owner', async () => {
      vi.stubEnv('ASSET_QUOTA_BYTES', '4');
      // The provider reads the quota when it is built; build a fresh one.
      vi.stubEnv('DATABASE_URL', `postgres://owner-quota-${randomUUID()}`);
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);

      await allocate('alice', [1, 2, 3, 4]);
      const over = await call('alice', '/assets', { method: 'POST', body: assetForm([5]) });
      expect(over.status).toBe(507);
      // Alice filling her quota does not fill Bob's.
      await allocate('bob', [5, 6, 7, 8]);
    });
  });

  describe('references are the owner’s own', () => {
    async function lifecycle(assetId: string) {
      const result = await pool.query(
        'SELECT committed_at, expires_at, unreferenced_at FROM asset_entries WHERE id = $1',
        [assetId],
      );
      return result.rows[0] as
        | { committed_at: unknown; expires_at: unknown; unreferenced_at: unknown }
        | undefined;
    }

    async function refStages(assetId: string): Promise<string[]> {
      const result = await pool.query(
        'SELECT stage_id FROM document_asset_refs WHERE asset_id = $1 ORDER BY stage_id',
        [assetId],
      );
      return (result.rows as { stage_id: string }[]).map((row) => row.stage_id);
    }

    it('does not let another owner’s course commit, expose or pin a pending allocation', async () => {
      const id = await allocate('alice', [1, 2, 3, 4]);

      await saveCourse('bob', 'stage-bob-claims', [id]);

      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
      expect((await call('bob', `/assets/${id}/content`, { method: 'HEAD' })).status).toBe(404);
      expect(await refStages(id)).toEqual([]);
      const row = await lifecycle(id);
      expect(row?.committed_at).toBeNull();
      expect(row?.expires_at).not.toBeNull();

      // Alice's own course is what commits it.
      await saveCourse('alice', 'stage-alice-owns', [id]);
      expect(await refStages(id)).toEqual(['stage-alice-owns']);
      expect((await lifecycle(id))?.committed_at).not.toBeNull();
    });

    it('does not let another owner’s course keep a committed entry alive or readable', async () => {
      const id = await allocate('alice');
      await saveCourse('alice', 'stage-alice-media', [id]);
      await saveCourse('bob', 'stage-bob-copies', [id]);
      expect(await refStages(id)).toEqual(['stage-alice-media']);

      await call('alice', '/documents/stage-alice-media', { method: 'DELETE' });

      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
      // Released on schedule: Bob's course naming it does not hold it.
      expect((await lifecycle(id))?.unreferenced_at).not.toBeNull();
    });

    it('keeps a referenced but uncommitted entry private', async () => {
      const id = await allocate('alice');
      await saveCourse('alice', 'stage-alice-uncommitted');
      // A reference row without the commit a document write would make: the
      // normal lifecycle never leaves this state, so it is built directly.
      await pool.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         VALUES ('stage-alice-uncommitted', 'scene', 'scene-x', $1)`,
        [id],
      );
      expect((await lifecycle(id))?.committed_at).toBeNull();

      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
    });

    it('keeps an entry private once its only course is tombstoned, even with rows left', async () => {
      const id = await allocate('alice');
      await saveCourse('alice', 'stage-alice-stale', [id]);
      expect((await call('bob', `/assets/${id}/content`)).status).toBe(200);
      // A tombstone whose reference rows were not withdrawn (the product's
      // delete withdraws them in the same transaction).
      await pool.query(`UPDATE stage_meta SET deleted_at = now() WHERE stage_id = $1`, [
        'stage-alice-stale',
      ]);
      expect(await refStages(id)).toEqual(['stage-alice-stale']);

      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
    });

    it('ignores a reference row from a course that is not the entry owner’s', async () => {
      const id = await allocate('alice');
      await saveCourse('alice', 'stage-alice-gone', [id]);
      await call('alice', '/documents/stage-alice-gone', { method: 'DELETE' });
      await saveCourse('bob', 'stage-bob-row');
      // A row the scoped document writes would never produce, restored out of band.
      await pool.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         VALUES ('stage-bob-row', 'scene', 'scene-x', $1)`,
        [id],
      );

      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
    });
  });

  describe('legacy shared-partition assets', () => {
    async function legacyEntry(bytes: string): Promise<string> {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      const { LEGACY_SHARED_ASSET_PRINCIPAL } = await import('@/lib/persistence/owner-assets');
      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL!);
      return provider.assetStore.put({ key: LEGACY_SHARED_ASSET_PRINCIPAL }, new Blob([bytes]), {
        contentType: 'image/png',
      });
    }

    it('stays readable by id to every owner, as before', async () => {
      const id = await legacyEntry('legacy');
      expect((await call('alice', `/assets/${id}/content`)).status).toBe(200);
      expect((await call('bob', `/assets/${id}/content`)).status).toBe(200);
    });

    it('can be replaced and deleted by the owner of every course that names it, and nobody else', async () => {
      const id = await legacyEntry('legacy-owned');
      await saveCourse('alice', 'stage-legacy', [id]);

      const foreignPut = await call('bob', `/assets/${id}/content`, {
        method: 'PUT',
        body: assetForm([9]),
      });
      expect(foreignPut.status).toBe(404);
      await call('bob', `/assets/${id}`, { method: 'DELETE' });
      expect((await call('alice', `/assets/${id}/content`)).status).toBe(200);

      const ownPut = await call('alice', `/assets/${id}/content`, {
        method: 'PUT',
        body: assetForm([4, 2]),
      });
      expect(ownPut.status).toBe(204);
      const replaced = await call('bob', `/assets/${id}/content`);
      expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(new Uint8Array([4, 2]));

      expect((await call('alice', `/assets/${id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await call('bob', `/assets/${id}/content`)).status).toBe(404);
    });

    it('cannot be mutated by anyone while courses of two owners name it', async () => {
      const id = await legacyEntry('legacy-shared-by-two');
      await saveCourse('alice', 'stage-legacy-a', [id]);
      await saveCourse('bob', 'stage-legacy-b', [id]);

      for (const who of ['alice', 'bob'] as const) {
        const put = await call(who, `/assets/${id}/content`, {
          method: 'PUT',
          body: assetForm([9]),
        });
        expect(put.status).toBe(404);
        await call(who, `/assets/${id}`, { method: 'DELETE' });
      }
      const intact = await call('alice', `/assets/${id}/content`);
      expect(await intact.text()).toBe('legacy-shared-by-two');
    });

    it('cannot be mutated when no course names it', async () => {
      const id = await legacyEntry('legacy-orphan');
      const put = await call('alice', `/assets/${id}/content`, {
        method: 'PUT',
        body: assetForm([9]),
      });
      expect(put.status).toBe(404);
    });
  });
});
