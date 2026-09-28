import { createHash, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import type { OwnerAuthMethod } from '@/lib/server/identity/types';

/**
 * `GET /api/identity/merged-from`: whether a claim merged into the requesting
 * owner an owner with a given salted digest. Real routes, an in-memory
 * database, and a fake host auth method ahead of the anonymous fallback (the
 * same setup as the claim-route tests).
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

const ANON_UUID = '7a1c9a8e-2b3f-4c4d-9e5f-6a7b8c9d0e1f';
const ANON = `anon:${ANON_UUID}`;
const ANON_COOKIE = `anonymous_id=${ANON_UUID}`;
const SALT = '0123456789abcdef0123456789abcdef';
const SAME_ORIGIN_JSON = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

const sessionMethod: OwnerAuthMethod = {
  name: 'test-session',
  authenticate: async (req) => {
    const user = req.headers.get('x-test-session');
    if (!user) return { status: 'not-applicable' };
    if (user === 'bad') return { status: 'invalid', reason: 'unknown session' };
    return {
      status: 'authenticated',
      principal: {
        ownerId: `user:${user}`,
        kind: 'user',
        roles: new Set(['course:publish']),
        assurance: 'verified',
      },
    };
  },
};

function digestOf(ownerId: string, salt = SALT): string {
  return createHash('sha256').update(`${salt}\u0000${ownerId}`).digest('hex');
}

describe('GET /api/identity/merged-from', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://merged-from-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('OWNER_CLAIM_TRIGGER', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [sessionMethod] });
    await createOwnerBoundDocumentStore({
      pool,
      ownerId: ANON,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).saveDocument({
      stage: { id: 'anon-course', name: 'x', createdAt: 1, updatedAt: 1 },
      scenes: [],
    } as never);
    // Alice signs in and claims the anonymous work.
    const { POST } = await import('@/app/api/identity/claim/route');
    const claimed = await POST(
      new Request('http://localhost/api/identity/claim', {
        method: 'POST',
        headers: { 'x-test-session': 'alice', cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON },
        body: '{}',
      }),
    );
    expect(claimed.status).toBe(200);
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function ask(headers: Record<string, string>, query: string): Promise<Response> {
    const { GET } = await import('@/app/api/identity/merged-from/route');
    return GET(new Request(`http://localhost/api/identity/merged-from?${query}`, { headers }));
  }

  const query = (digest: string, salt = SALT) => `salt=${salt}&digest=${digest}`;

  it('confirms to the claimant that it absorbed the owner with that digest', async () => {
    const response = await ask({ 'x-test-session': 'alice' }, query(digestOf(ANON)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ merged: true });
  });

  it('answers false to a different owner asking about the same digest', async () => {
    const response = await ask({ 'x-test-session': 'bob' }, query(digestOf(ANON)));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ merged: false });
  });

  it('answers false to an anonymous owner, and for another digest or salt', async () => {
    const anonymous = await ask({}, query(digestOf(ANON)));
    await expect(anonymous.json()).resolves.toEqual({ merged: false });
    const other = await ask({ 'x-test-session': 'alice' }, query(digestOf('anon:someone-else')));
    await expect(other.json()).resolves.toEqual({ merged: false });
    const salted = await ask(
      { 'x-test-session': 'alice' },
      query(digestOf(ANON), 'ffffffffffffffffffffffffffffffff'),
    );
    await expect(salted.json()).resolves.toEqual({ merged: false });
  });

  it('refuses an invalid credential like every owner-scoped route', async () => {
    const response = await ask({ 'x-test-session': 'bad' }, query(digestOf(ANON)));
    expect(response.status).toBe(401);
  });

  it('refuses a malformed query', async () => {
    expect((await ask({ 'x-test-session': 'alice' }, 'salt=zz&digest=00')).status).toBe(400);
    expect((await ask({ 'x-test-session': 'alice' }, `salt=${SALT}`)).status).toBe(400);
  });
});
