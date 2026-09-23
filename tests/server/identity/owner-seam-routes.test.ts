import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import type { AuthOutcome, OwnerAuthenticator } from '@/lib/server/identity/types';

/**
 * The seam end to end: real routes, a real (in-memory) database, no mocked
 * owner resolution. One half registers a host authenticator and checks that it
 * alone decides who owns what across the persistence route, `/api/stages` and
 * publish; the other half pins that the built-ins still decide publish exactly
 * as before — refused for an anonymous cookie owner, allowed for the shared
 * owner.
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

const INVALID: AuthOutcome = { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };

/**
 * `x-test-user: <name>` is a signed-in user who may publish, `x-test-user: bad`
 * an invalid credential. No anonymous fallback: a missing header is refused too.
 */
const headerAuthenticator: OwnerAuthenticator = {
  name: 'test-header',
  authenticate: async (req): Promise<AuthOutcome> => {
    const user = req.headers.get('x-test-user');
    if (!user || user === 'bad') return INVALID;
    return {
      ok: true,
      principal: {
        ownerId: `user:${user}`,
        kind: 'user',
        roles: new Set(['course:publish']),
        assurance: 'verified',
      },
    };
  },
};

const OWNER_COOKIE = '11111111-1111-4111-8111-111111111111';

describe('owner identity seam through the routes', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://owner-seam-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
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

  async function persistence(path: string, user: string, init: RequestInit = {}) {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        ...init,
        headers: { 'x-test-user': user, 'content-type': 'application/json' },
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

  it('lets a configured authenticator decide ownership for persistence, /api/stages and publish', async () => {
    const { configureOwnerAuthenticator } = await import('@/lib/server/identity');
    configureOwnerAuthenticator(headerAuthenticator);
    const stageId = 'stage-seam-host';

    const created = await persistence(`/documents/${stageId}`, 'alice', {
      method: 'PUT',
      body: JSON.stringify(courseDocument(stageId)),
    });
    expect(created.status).toBeLessThan(300);
    // No anonymous identity is minted for a host-authenticated request.
    expect(created.headers.has('set-cookie')).toBe(false);

    const foreignWrite = await persistence(`/documents/${stageId}`, 'bob', {
      method: 'PUT',
      body: JSON.stringify(courseDocument(stageId, 'Foreign edit')),
    });
    expect(foreignWrite.status).toBe(403);

    await expect((await listStages({ 'x-test-user': 'alice' })).json()).resolves.toMatchObject({
      stages: [expect.objectContaining({ id: stageId })],
    });
    await expect((await listStages({ 'x-test-user': 'bob' })).json()).resolves.toEqual({
      stages: [],
    });

    expect((await publish(stageId, { 'x-test-user': 'bob' })).status).toBe(403);
    const published = await publish(stageId, { 'x-test-user': 'alice' });
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({ success: true });
  });

  it('answers an invalid credential with 401 on every surface, never as an anonymous owner', async () => {
    const { configureOwnerAuthenticator } = await import('@/lib/server/identity');
    configureOwnerAuthenticator(headerAuthenticator);
    const stageId = 'stage-seam-invalid';
    await ownerStore(pool, 'user:alice').saveDocument(courseDocument(stageId));

    const responses = [
      await persistence(`/documents/${stageId}`, 'bad'),
      await persistence(`/documents/${stageId}`, 'bad', {
        method: 'PUT',
        body: JSON.stringify(courseDocument(stageId, 'Hijack')),
      }),
      await listStages({ 'x-test-user': 'bad' }),
      await publish(stageId, { 'x-test-user': 'bad' }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.has('set-cookie')).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_CREDENTIAL' },
      });
    }
  });

  it('keeps refusing publish for an anonymous cookie owner (built-in anonymousCookie)', async () => {
    const stageId = 'stage-seam-anonymous';
    await ownerStore(pool, `anon:${OWNER_COOKIE}`).saveDocument(courseDocument(stageId));

    const response = await publish(stageId, { cookie: `anonymous_id=${OWNER_COOKIE}` });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'login_required' });
  });

  it('keeps allowing publish for the shared owner (built-in sharedTeam)', async () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    const stageId = 'stage-seam-shared';
    await ownerStore(pool, 'team-alpha').saveDocument(courseDocument(stageId));

    const response = await publish(stageId, { cookie: `anonymous_id=${OWNER_COOKIE}` });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(response.headers.has('set-cookie')).toBe(false);
  });
});
