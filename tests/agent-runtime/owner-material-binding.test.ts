/**
 * Owner-material binding integration -- the issue #1494 regression, under
 * attaching by link (RFC #1716 §4).
 *
 * Drives `bindOwnerMaterialsToSession` and the real session-creation route over
 * a PGlite-backed durable store. Before #1494's fix the second session's bind
 * hit the global `agent_session_materials` primary key and the route answered
 * 500. Binding no longer copies at all: each session gets one link to the
 * owner upload, both read it through the resolver, and a session that held a
 * copy from before links keeps it.
 */
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { PgAgentSessionStore, ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import type { Queryable } from '@openmaic/storage/asset/pg';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';

// Schema bootstrap is serialized by a PostgreSQL advisory lock on a dedicated
// connection; the fakes here have no connections, and the lock itself is
// exercised against a real server in schema-bootstrap-concurrency.pg.test.ts.
vi.mock('@/lib/persistence/schema-bootstrap-lock', () => ({
  SCHEMA_BOOTSTRAP_LOCK_KEY: 0,
  withSchemaBootstrapLock: <T>(pool: unknown, body: (queryable: never) => Promise<T>) =>
    body(pool as never),
}));

const mocks = vi.hoisted(() => ({
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
  scheduleConversationTitle: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/server/agent-runtime/skills', () => ({
  listSkills: async () => [],
  findSkill: async () => null,
  inferSkillIdFromPrompt: async () => undefined,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));
vi.mock('@/lib/server/agent-runtime/conversation-title-task', () => ({
  scheduleConversationTitle: mocks.scheduleConversationTitle,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

import { POST } from '@/app/api/agent/sessions/route';
import {
  bindOwnerMaterialsToSession,
  getSessionMaterial,
  listSessionMaterials,
} from '@/lib/server/agent-runtime/session-materials';
import {
  listSessionScopeMaterials,
  readResolvedMaterialRaw,
  resolveMaterial,
} from '@/lib/server/agent-runtime/material-resolver';
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import { PgAssetStore, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';

let dbCounter = 0;
let db: PGlite | undefined;

async function makeHost() {
  const instance = new PGlite();
  await instance.waitReady;
  await ensureAgentSessionSchema(instance);
  await ensureOwnerMaterialSchema(instance);
  // The session-material tables, as a database from before links has them:
  // the links table is NOT created here, so every test below relies on the
  // lazy bootstrap the code waits for, as an upgraded database does.
  await ensureAgentSessionMaterialSchema(instance);
  const bytes = new Map<string, Buffer>();
  const puts: string[] = [];
  setMaterialByteStoreForTests({
    put: async (key, body) => {
      bytes.set(key, Buffer.from(body as Uint8Array));
      puts.push(key);
    },
    get: async (key) => {
      const value = bytes.get(key);
      if (!value) throw new Error(`missing material bytes: ${key}`);
      return value;
    },
    delete: async (key) => void bytes.delete(key),
  });
  const sessionStore = new PgAgentSessionStore(instance, {
    withTransaction: (body) => instance.transaction((tx: Queryable) => body(tx)),
  });
  dbCounter += 1;
  vi.stubEnv('DATABASE_URL', `postgres://binding-${dbCounter}`);
  mocks.getAgentSessionStore.mockResolvedValue(sessionStore);
  mocks.getServerPersistenceProvider.mockResolvedValue({
    pool: instance,
    withTransaction: (body: (tx: Queryable) => Promise<unknown>) =>
      instance.transaction((tx: Queryable) => body(tx)),
  });
  mocks.resolveRequestOwnerId.mockImplementation((_request: NextRequest, headers: Headers) => {
    headers.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
    return 'owner-1';
  });
  db = instance;
  return { db: instance, bytes, puts, sessionStore };
}

/** A ready upload from before the pool, with the digest its upload recorded for `content`. */
async function seedOwnerMaterial(instance: PGlite, id: string, content = 'PDF') {
  await instance.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256, status, extraction,
        created_at)
     VALUES ($1, 'owner-1', 'source', 'application/pdf', 3, 'textbook.pdf', $2, $3, 'ready', NULL,
             $4)`,
    [id, `owner/${id}/raw`, createHash('sha256').update(content).digest('hex'), Date.now()],
  );
}

/** The deterministic object key the pre-upgrade binder copied owner bytes to. */
function legacyRawKey(
  sessionId: string,
  ownerMaterialId: string,
  mime = 'application/pdf',
): string {
  return `materials/${sessionId}/${ownerMaterialId}/raw.${Buffer.from(mime, 'utf8').toString(
    'base64url',
  )}`;
}

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  setMaterialByteStoreForTests(null);
});

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** The session's links, by material id. */
async function linksOf(instance: PGlite, sessionId: string): Promise<string[]> {
  const result = await instance.query<{ material_id: string }>(
    'SELECT material_id FROM agent_session_material_links WHERE session_id = $1 ORDER BY material_id',
    [sessionId],
  );
  return result.rows.map((row) => row.material_id);
}

/** What a consumer reads of a material the session reaches. */
async function readRaw(sessionId: string, materialId: string): Promise<string | null> {
  const material = await resolveMaterial(sessionId, materialId);
  if (!material) return null;
  return (await readResolvedMaterialRaw(sessionId, material))?.bytes.toString() ?? null;
}

describe('a database upgraded from before links', () => {
  it('creates the links table before the first attachment uses it', async () => {
    const { db: instance, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'cold-session', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'cold-material');

    const bound = await bindOwnerMaterialsToSession('cold-session', 'owner-1', ['cold-material']);
    expect(bound.map((item) => item.materialId)).toEqual(['cold-material']);
    expect(await linksOf(instance, 'cold-session')).toEqual(['cold-material']);
  });

  it('creates the links table before the first session listing reads it', async () => {
    const { sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'cold-list', ownerId: 'owner-1', prompt: 'p' });
    expect(await listSessionScopeMaterials('cold-list')).toEqual([]);
  });

  it('creates the links table before the first lookup through a link', async () => {
    const { sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'cold-lookup', ownerId: 'owner-1', prompt: 'p' });
    expect(await resolveMaterial('cold-lookup', 'mat_missing')).toBeNull();
  });
});

describe('owner-material binding across sessions', () => {
  it('links one owner upload into two sessions, copying nothing, and both read it', async () => {
    const { db: instance, bytes, puts, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-a', ownerId: 'owner-1', prompt: 'p' });
    await sessionStore.createSession({ id: 'session-b', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');
    bytes.set('owner/mat_owner/raw', Buffer.from('PDF'));

    const first = await bindOwnerMaterialsToSession('session-a', 'owner-1', ['mat_owner']);
    const second = await bindOwnerMaterialsToSession('session-b', 'owner-1', ['mat_owner']);

    // Both sessions know the upload by its own id; nothing was copied.
    expect(first).toEqual([
      { materialId: 'mat_owner', originalName: 'textbook.pdf', mime: 'application/pdf', bytes: 3 },
    ]);
    expect(second[0]!.materialId).toBe('mat_owner');
    expect(puts).toEqual([]);
    expect(await listSessionMaterials('session-a')).toEqual([]);
    expect(await linksOf(instance, 'session-a')).toEqual(['mat_owner']);
    expect(await linksOf(instance, 'session-b')).toEqual(['mat_owner']);
    expect(await readRaw('session-a', 'mat_owner')).toBe('PDF');
    expect(await readRaw('session-b', 'mat_owner')).toBe('PDF');

    // Rebinding the same upload into the same session changes nothing.
    await bindOwnerMaterialsToSession('session-a', 'owner-1', ['mat_owner']);
    expect(await linksOf(instance, 'session-a')).toEqual(['mat_owner']);
  });

  it('keeps reading a copy the session made before links, and links it elsewhere', async () => {
    const { db: instance, bytes, puts, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-legacy', ownerId: 'owner-1', prompt: 'p' });
    await sessionStore.createSession({ id: 'session-other', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');
    bytes.set('owner/mat_owner/raw', Buffer.from('PDF'));

    // Exactly what the pre-upgrade binder wrote: row id = owner upload id,
    // owner_material_id NULL, copied bytes at the deterministic legacy key,
    // and extraction already finished.
    const legacyKey = legacyRawKey('session-legacy', 'mat_owner');
    bytes.set(legacyKey, Buffer.from('PDF'));
    await instance.query(
      `INSERT INTO agent_session_materials
         (id, session_id, kind, title, owner_material_id, raw_asset_id, text_chars,
          extraction_status, extraction_attempts, extraction_stats, extractor_version, created_at)
       VALUES ('mat_owner', 'session-legacy', 'source', 'textbook.pdf', NULL, $1, 0,
               'done', 2, $2::jsonb, 'pdf@1', now())`,
      [legacyKey, JSON.stringify({ chars: 1234, pages: 2, imageCount: 0 })],
    );

    const rebound = await bindOwnerMaterialsToSession('session-legacy', 'owner-1', ['mat_owner']);

    // The copy is the session's: no link beside it, no second row, its
    // extraction state untouched.
    expect(rebound[0]!.materialId).toBe('mat_owner');
    expect(await linksOf(instance, 'session-legacy')).toEqual([]);
    expect(await listSessionMaterials('session-legacy')).toHaveLength(1);
    expect(await getSessionMaterial('session-legacy', 'mat_owner')).toMatchObject({
      rawAssetId: legacyKey,
      extraction: { status: 'done', attempts: 2, extractorVersion: 'pdf@1' },
    });
    expect((await resolveMaterial('session-legacy', 'mat_owner'))?.origin).toBe('session');

    // Another session gets a link, not a copy.
    await bindOwnerMaterialsToSession('session-other', 'owner-1', ['mat_owner']);
    expect(await linksOf(instance, 'session-other')).toEqual(['mat_owner']);
    expect(await listSessionMaterials('session-other')).toEqual([]);
    expect(puts).toEqual([]);
  });

  it('leaves one link when two binds of the same upload race into one session', async () => {
    const { db: instance, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-race', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');

    const [one, two] = await Promise.all([
      bindOwnerMaterialsToSession('session-race', 'owner-1', ['mat_owner']),
      bindOwnerMaterialsToSession('session-race', 'owner-1', ['mat_owner']),
    ]);
    expect(one[0]!.materialId).toBe('mat_owner');
    expect(two[0]!.materialId).toBe('mat_owner');
    expect(await linksOf(instance, 'session-race')).toEqual(['mat_owner']);
  });

  it('refuses another owner’s, a derivative, an unfinished upload and a deleted one, attaching nothing', async () => {
    const { db: instance, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-x', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');
    await seedOwnerMaterial(instance, 'mat_other');
    await instance.query(`UPDATE owner_material SET owner_id = 'owner-2' WHERE id = 'mat_other'`);
    await seedOwnerMaterial(instance, 'mat_image');
    await instance.query(
      `UPDATE owner_material SET kind = 'image', derived_from = 'mat_owner' WHERE id = 'mat_image'`,
    );
    await seedOwnerMaterial(instance, 'mat_uploading');
    await instance.query(
      `UPDATE owner_material SET status = 'uploading' WHERE id = 'mat_uploading'`,
    );
    await seedOwnerMaterial(instance, 'mat_deleted');
    await instance.query(`UPDATE owner_material SET deleted_at = 1 WHERE id = 'mat_deleted'`);

    for (const bad of ['mat_other', 'mat_image', 'mat_uploading', 'mat_deleted', 'missing']) {
      await expect(
        bindOwnerMaterialsToSession('session-x', 'owner-1', ['mat_owner', bad]),
      ).rejects.toThrow('unavailable');
    }
    expect(await linksOf(instance, 'session-x')).toEqual([]);
  });

  it('POST /api/agent/sessions returns 202 when a second session reuses the upload', async () => {
    const { db: instance, bytes } = await makeHost();
    await seedOwnerMaterial(instance, 'mat_owner');
    bytes.set('owner/mat_owner/raw', Buffer.from('PDF'));

    const first = await post({ prompt: 'Build a course', materialIds: ['mat_owner'] });
    expect(first.status).toBe(202);

    // The regression: before #1494's fix this second bind threw the
    // primary-key violation, and the response was 500.
    const second = await post({ prompt: 'Build the sequel', materialIds: ['mat_owner'] });
    expect(second.status).toBe(202);
  });

  it('reads an upload that exists only in the pool next to one from before it', async () => {
    const { db: instance, bytes, sessionStore } = await makeHost();
    await ensureAssetSchema(instance);
    const assetStore = new PgAssetStore(instance, {
      byteStore: new PgAssetByteStore(instance),
      withTransaction: (body) => instance.transaction((tx: Queryable) => body(tx)),
    });
    mocks.getServerPersistenceProvider.mockResolvedValue({
      pool: instance,
      assetStore,
      withTransaction: (body: (tx: Queryable) => Promise<unknown>) =>
        instance.transaction((tx: Queryable) => body(tx)),
    });
    await sessionStore.createSession({ id: 'session-mixed', ownerId: 'owner-1', prompt: 'p' });

    // A pre-pool upload, read by its object key.
    await seedOwnerMaterial(instance, 'mat_old', 'OLD');
    bytes.set('owner/mat_old/raw', Buffer.from('OLD'));
    // A pool-only upload: a pointer, no object key, nothing in the byte store.
    const assetId = await assetStore.put(
      assetPrincipalForOwner('owner-1'),
      new Blob([Buffer.from('NEW')], { type: 'application/pdf' }),
    );
    await instance.query(
      `INSERT INTO owner_material
         (id, owner_id, kind, mime, bytes, original_name, oss_key, asset_id, sha256, status,
          extraction, created_at)
       VALUES ('mat_new', 'owner-1', 'source', 'application/pdf', 3, 'new.pdf', '', $1, $2,
               'ready', NULL, $3)`,
      [assetId, createHash('sha256').update('NEW').digest('hex'), Date.now()],
    );

    await bindOwnerMaterialsToSession('session-mixed', 'owner-1', ['mat_old', 'mat_new']);

    expect(await readRaw('session-mixed', 'mat_old')).toBe('OLD');
    expect(await readRaw('session-mixed', 'mat_new')).toBe('NEW');
  });

  it('attaches an upload whose old object no longer matches its digest, which then reads as unavailable', async () => {
    const { db: instance, bytes, puts, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-damaged', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_damaged', 'PDF');
    bytes.set('owner/mat_damaged/raw', Buffer.from('PDX'));

    // Sending reads no bytes any more: the link is written...
    await bindOwnerMaterialsToSession('session-damaged', 'owner-1', ['mat_damaged']);
    expect(await linksOf(instance, 'session-damaged')).toEqual(['mat_damaged']);
    // ...and a consumer reading it finds the bytes unavailable, never others.
    expect(await readRaw('session-damaged', 'mat_damaged')).toBeNull();
    expect(puts).toEqual([]);
  });
});
