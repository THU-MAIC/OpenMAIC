import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';

/**
 * The trusted-proxy built-in end to end: real routes, a real (in-memory)
 * database, the authenticator selected by environment exactly as a deployment
 * selects it. A gateway user owns what they write, lists it, and may publish;
 * a client that forges the gateway's user header without the secret is a 401
 * on every surface and is never given an anonymous identity instead.
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

function courseDocument(id: string, name = 'Seam course') {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function ownerStore(pool: PGlitePool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

const SECRET = 'trusted-proxy-route-secret-0123456789abcdef';

function asGateway(user: string): Record<string, string> {
  return { 'x-openmaic-proxy-secret': SECRET, 'x-forwarded-user': user };
}

describe('trusted-proxy authenticator through the routes', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://trusted-proxy-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
    vi.stubEnv('TRUSTED_PROXY_SECRET', SECRET);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    vi.restoreAllMocks();
  });

  async function persistence(
    path: string,
    headers: Record<string, string>,
    init: RequestInit = {},
  ) {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        ...init,
        headers: { ...headers, 'content-type': 'application/json' },
      }),
      { poolFactory: () => pool as never },
    );
  }

  async function listStages(headers: Record<string, string>) {
    const { GET } = await import('@/app/api/stages/route');
    return GET(new NextRequest('http://localhost/api/stages', { headers }));
  }

  async function publish(stageId: string, headers: Record<string, string>) {
    const { POST } = await import('@/app/api/stages/[id]/publish/route');
    return POST(
      new NextRequest(`http://localhost/api/stages/${stageId}/publish`, {
        method: 'POST',
        headers,
      }),
      { params: Promise.resolve({ id: stageId }) },
    );
  }

  function learnerKey(headers: Record<string, string>) {
    return persistence('/learner-key', headers);
  }

  it('lets a gateway user write, list and publish their own course', async () => {
    const stageId = 'stage-proxy-alice';

    const created = await persistence(`/documents/${stageId}`, asGateway('alice'), {
      method: 'PUT',
      body: JSON.stringify(courseDocument(stageId)),
    });
    expect(created.status).toBeLessThan(300);
    expect(created.headers.has('set-cookie')).toBe(false);

    const foreignWrite = await persistence(`/documents/${stageId}`, asGateway('bob'), {
      method: 'PUT',
      body: JSON.stringify(courseDocument(stageId, 'Foreign edit')),
    });
    expect(foreignWrite.status).toBe(403);

    await expect((await listStages(asGateway('alice'))).json()).resolves.toMatchObject({
      stages: [expect.objectContaining({ id: stageId })],
    });
    await expect((await listStages(asGateway('bob'))).json()).resolves.toEqual({ stages: [] });
    // Case is kept, so a differently cased user is a different owner.
    await expect((await listStages(asGateway('Alice'))).json()).resolves.toEqual({ stages: [] });

    expect((await publish(stageId, asGateway('bob'))).status).toBe(403);
    const published = await publish(stageId, asGateway('alice'));
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({ success: true });
    expect(published.headers.has('set-cookie')).toBe(false);
  });

  async function piChat(headers: Record<string, string>) {
    const { POST } = await import('@/app/api/chat/pi/route');
    // An empty body: a resolved owner gets past identity and stops at body
    // validation (400) before any model work; a refused one never gets there.
    return POST(
      new NextRequest('http://localhost/api/chat/pi', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
  }

  it('refuses /api/chat/pi without the gateway secret', async () => {
    vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');

    const forged = await piChat({ 'x-forwarded-user': 'alice' });
    expect(forged.status).toBe(401);
    expect(forged.headers.has('set-cookie')).toBe(false);
    expect((await piChat({ 'x-openmaic-proxy-secret': SECRET })).status).toBe(401);

    const gateway = await piChat(asGateway('alice'));
    expect(gateway.status).toBe(400);
    await expect(gateway.json()).resolves.toMatchObject({ errorCode: 'MISSING_REQUIRED_FIELD' });
  });

  it('leaves /api/chat/pi open to anonymous visitors under the default authenticator', async () => {
    vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');
    vi.stubEnv('OWNER_AUTHENTICATOR', '');
    vi.stubEnv('TRUSTED_PROXY_SECRET', '');

    // No cookie at all, and a malformed one: anonymous resolution always succeeds.
    expect((await piChat({})).status).toBe(400);
    expect((await piChat({ cookie: 'anonymous_id=not-a-uuid' })).status).toBe(400);
  });

  it('keys runtime data by the gateway user', async () => {
    const response = await learnerKey(asGateway('alice'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ learnerKey: 'proxy:alice' });
  });

  it('refuses a forged user header without the secret on every surface', async () => {
    const stageId = 'stage-proxy-spoofed';
    await ownerStore(pool, 'proxy:alice').saveDocument(courseDocument(stageId));
    // What a client that bypassed the gateway would send, with an old
    // anonymous cookie for good measure: none of it may identify anyone.
    const forged = {
      'x-forwarded-user': 'alice',
      cookie: 'anonymous_id=11111111-1111-4111-8111-111111111111',
    };
    const wrongSecret = { ...forged, 'x-openmaic-proxy-secret': 'x'.repeat(SECRET.length) };

    const responses = [
      await persistence(`/documents/${stageId}`, forged),
      await persistence(`/documents/${stageId}`, forged, {
        method: 'PUT',
        body: JSON.stringify(courseDocument(stageId, 'Hijack')),
      }),
      await listStages(forged),
      await listStages(wrongSecret),
      await publish(stageId, forged),
      await publish(stageId, wrongSecret),
      await learnerKey(forged),
      await listStages({ 'x-openmaic-proxy-secret': SECRET }),
      await listStages({ ...asGateway('alice'), 'x-forwarded-user': 'alice, bob' }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.has('set-cookie')).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_CREDENTIAL' },
      });
    }
    // The course is untouched.
    const stored = await ownerStore(pool, 'proxy:alice').loadDocument(stageId);
    expect(stored?.stage.name).toBe('Seam course');
  });
});
