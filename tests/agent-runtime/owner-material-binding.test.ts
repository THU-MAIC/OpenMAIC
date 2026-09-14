/**
 * Owner-material binding integration — the issue #1494 regression.
 *
 * Drives `bindOwnerMaterialsToSession` and the real session-creation route over
 * a PGlite-backed durable store. Before the fix the second session's bind hit
 * the global `agent_session_materials` primary key and the route answered 500;
 * now each session gets its own row id while the shared owner upload id is
 * recorded for idempotency, so both sessions bind and read their own row.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { PgAgentSessionStore, ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureAgentSessionMaterialSchema } from '@openmaic/storage/material/pg';
import type { Queryable } from '@openmaic/storage/asset/pg';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';

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
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
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

let dbCounter = 0;
let db: PGlite | undefined;

async function makeHost() {
  const instance = new PGlite();
  await instance.waitReady;
  await ensureAgentSessionSchema(instance);
  await ensureOwnerMaterialSchema(instance);
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
  mocks.getServerPersistenceProvider.mockResolvedValue({ pool: instance });
  mocks.resolveRequestOwnerId.mockImplementation((_request: NextRequest, headers: Headers) => {
    headers.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
    return 'owner-1';
  });
  db = instance;
  return { db: instance, bytes, puts, sessionStore };
}

async function seedOwnerMaterial(instance: PGlite, id: string) {
  await instance.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, oss_key, status, extraction, created_at)
     VALUES ($1, 'owner-1', 'source', 'application/pdf', 3, 'textbook.pdf', $2, 'ready', NULL, $3)`,
    [id, `owner/${id}/raw`, Date.now()],
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

describe('owner-material binding across sessions', () => {
  it('binds one owner upload to two sessions and both can read their own row', async () => {
    const { db: instance, bytes, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-a', ownerId: 'owner-1', prompt: 'p' });
    await sessionStore.createSession({ id: 'session-b', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');
    bytes.set('owner/mat_owner/raw', Buffer.from('PDF'));

    const first = await bindOwnerMaterialsToSession('session-a', 'owner-1', ['mat_owner']);
    const second = await bindOwnerMaterialsToSession('session-b', 'owner-1', ['mat_owner']);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Both sessions got distinct session-side rows for the same owner upload.
    expect(first[0]!.materialId).not.toBe(second[0]!.materialId);

    const rowA = await getSessionMaterial('session-a', first[0]!.materialId);
    const rowB = await getSessionMaterial('session-b', second[0]!.materialId);
    expect(rowA).toMatchObject({
      id: first[0]!.materialId,
      sessionId: 'session-a',
      ownerMaterialId: 'mat_owner',
      title: 'textbook.pdf',
    });
    expect(rowB).toMatchObject({
      id: second[0]!.materialId,
      sessionId: 'session-b',
      ownerMaterialId: 'mat_owner',
      title: 'textbook.pdf',
    });
    // Reads stay session-scoped: neither session can read the other's row.
    expect(await getSessionMaterial('session-a', second[0]!.materialId)).toBeNull();
    expect(await getSessionMaterial('session-b', first[0]!.materialId)).toBeNull();

    // Rebinding the same owner upload into the same session is idempotent.
    const rebound = await bindOwnerMaterialsToSession('session-a', 'owner-1', ['mat_owner']);
    expect(rebound[0]!.materialId).toBe(first[0]!.materialId);
    expect(await listSessionMaterials('session-a')).toHaveLength(1);
  });

  it('reuses and backfills a pre-upgrade legacy owner-material binding', async () => {
    const { db: instance, bytes, puts, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-legacy', ownerId: 'owner-1', prompt: 'p' });
    await sessionStore.createSession({ id: 'session-other', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');
    bytes.set('owner/mat_owner/raw', Buffer.from('PDF'));

    // Exactly what the previous binder wrote: row id = owner upload id,
    // owner_material_id NULL, copied bytes at the deterministic legacy key,
    // and extraction already finished to prove the state must survive.
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
    const putsBefore = puts.length;

    const rebound = await bindOwnerMaterialsToSession('session-legacy', 'owner-1', ['mat_owner']);

    // The legacy row is reused, not duplicated or re-copied.
    expect(rebound).toHaveLength(1);
    expect(rebound[0]!.materialId).toBe('mat_owner');
    expect(await listSessionMaterials('session-legacy')).toHaveLength(1);
    expect(puts).toHaveLength(putsBefore);
    expect(bytes.get(legacyKey)).toEqual(Buffer.from('PDF'));

    const row = await getSessionMaterial('session-legacy', 'mat_owner');
    expect(row).toMatchObject({
      id: 'mat_owner',
      ownerMaterialId: 'mat_owner',
      title: 'textbook.pdf',
      rawAssetId: legacyKey,
      extraction: {
        status: 'done',
        attempts: 2,
        extractorVersion: 'pdf@1',
        stats: { chars: 1234, pages: 2, imageCount: 0 },
      },
    });

    // The backfill lets the next bind take the fast path without copying.
    const again = await bindOwnerMaterialsToSession('session-legacy', 'owner-1', ['mat_owner']);
    expect(again[0]!.materialId).toBe('mat_owner');
    expect(await listSessionMaterials('session-legacy')).toHaveLength(1);
    expect(puts).toHaveLength(putsBefore);

    // A different session is still a fresh row with its own byte copy.
    const other = await bindOwnerMaterialsToSession('session-other', 'owner-1', ['mat_owner']);
    expect(other[0]!.materialId).not.toBe('mat_owner');
    expect(await listSessionMaterials('session-other')).toHaveLength(1);
    expect(await getSessionMaterial('session-other', other[0]!.materialId)).toMatchObject({
      ownerMaterialId: 'mat_owner',
      rawAssetId: expect.any(String),
    });
    expect(puts).toHaveLength(putsBefore + 1);
  });

  it('removes the losing upload when a concurrent bind wins the same session', async () => {
    const { db: instance, sessionStore } = await makeHost();
    await sessionStore.createSession({ id: 'session-race', ownerId: 'owner-1', prompt: 'p' });
    await seedOwnerMaterial(instance, 'mat_owner');
    const ownerBytes = new Map<string, Buffer>([['owner/mat_owner/raw', Buffer.from('PDF')]]);
    const sessionBytes = new Map<string, Buffer>();
    let parkedLoser = true;
    let winner: Awaited<ReturnType<typeof bindOwnerMaterialsToSession>> | undefined;

    // The loser's upload of its own object is the pause point: the winner runs
    // to completion there, so the loser is guaranteed to lose the unique index
    // and must clean up the object it already stored.
    setMaterialByteStoreForTests({
      put: async (key, body) => {
        sessionBytes.set(key, Buffer.from(body as Uint8Array));
        if (parkedLoser) {
          parkedLoser = false;
          winner = await bindOwnerMaterialsToSession('session-race', 'owner-1', ['mat_owner']);
        }
      },
      get: async (key) => {
        const value = sessionBytes.get(key) ?? ownerBytes.get(key);
        if (!value) throw new Error(`missing material bytes: ${key}`);
        return value;
      },
      delete: async (key) => {
        sessionBytes.delete(key);
        ownerBytes.delete(key);
      },
    });

    const loser = await bindOwnerMaterialsToSession('session-race', 'owner-1', ['mat_owner']);

    expect(winner).toBeDefined();
    expect(loser).toHaveLength(1);
    expect(loser[0]!.materialId).toBe(winner![0]!.materialId);

    const rows = await listSessionMaterials('session-race');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerMaterialId).toBe('mat_owner');
    // Exactly one session byte object remains and it is the winner's.
    expect([...sessionBytes.keys()]).toEqual([rows[0]!.rawAssetId]);
    expect(ownerBytes.get('owner/mat_owner/raw')).toEqual(Buffer.from('PDF'));
  });

  it('POST /api/agent/sessions returns 202 when a second session reuses the upload', async () => {
    const { db: instance, bytes } = await makeHost();
    await seedOwnerMaterial(instance, 'mat_owner');
    bytes.set('owner/mat_owner/raw', Buffer.from('PDF'));

    const first = await post({ prompt: 'Build a course', materialIds: ['mat_owner'] });
    expect(first.status).toBe(202);

    // The regression: before the fix this second bind threw the primary-key
    // violation, `withRequestOwnerId` swallowed it, and the response was 500.
    const second = await post({ prompt: 'Build the sequel', materialIds: ['mat_owner'] });
    expect(second.status).toBe(202);
  });
});
