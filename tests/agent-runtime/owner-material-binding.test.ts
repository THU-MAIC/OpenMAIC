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
  const bytes = new Map<string, Buffer>();
  setMaterialByteStoreForTests({
    put: async (key, body) => void bytes.set(key, Buffer.from(body as Uint8Array)),
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
  return { db: instance, bytes, sessionStore };
}

async function seedOwnerMaterial(instance: PGlite, id: string) {
  await instance.query(
    `INSERT INTO owner_material
       (id, owner_id, kind, mime, bytes, original_name, oss_key, status, extraction, created_at)
     VALUES ($1, 'owner-1', 'source', 'application/pdf', 3, 'textbook.pdf', $2, 'ready', NULL, $3)`,
    [id, `owner/${id}/raw`, Date.now()],
  );
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
