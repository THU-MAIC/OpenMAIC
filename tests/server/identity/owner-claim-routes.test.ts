import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';

/**
 * Claiming anonymous work through the routes, end to end: the trusted-proxy
 * built-in selected by environment, a real (in-memory) database, and the
 * explicit trigger (`POST /api/identity/claim`), the automatic one
 * (`OWNER_CLAIM_TRIGGER=auto`) and the runtime contract's learner merge.
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

const SECRET = 'owner-claim-route-secret-0123456789abcdef';
const ANON_UUID = '5d1c9a8e-2b3f-4c4d-9e5f-6a7b8c9d0e1f';
const ANON = `anon:${ANON_UUID}`;
const ALICE = 'proxy:alice';
const ANON_COOKIE = `anonymous_id=${ANON_UUID}`;

function gateway(user: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-openmaic-proxy-secret': SECRET, 'x-forwarded-user': user, ...extra };
}

/** What a same-origin `fetch(..., { method: 'POST', body: JSON })` from the app sends. */
const SAME_ORIGIN_JSON = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

function courseDocument(id: string) {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name: id, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: id,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function clearsAnonymousCookie(response: Response): boolean {
  return setCookies(response).some(
    (cookie) => cookie.startsWith('anonymous_id=;') && /Max-Age=0/.test(cookie),
  );
}

describe('claiming anonymous work through the routes', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://owner-claim-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('OWNER_CLAIM_TRIGGER', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
    vi.stubEnv('TRUSTED_PROXY_SECRET', SECRET);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    // Work done before signing in.
    await createOwnerBoundDocumentStore({
      pool,
      ownerId: ANON,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).saveDocument(courseDocument('anon-course'));
  });

  afterEach(async () => {
    const { resetOwnerAuthenticatorForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticatorForTests();
    await pool.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function claim(headers: Record<string, string>) {
    const { POST } = await import('@/app/api/identity/claim/route');
    return POST(
      new Request('http://localhost/api/identity/claim', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    );
  }

  async function ownerOf(stageId: string): Promise<string | undefined> {
    const result = await pool.query('SELECT owner_id FROM stage_meta WHERE stage_id = $1', [
      stageId,
    ]);
    return (result.rows[0] as { owner_id?: string } | undefined)?.owner_id;
  }

  it('claims the anonymous cookie owner into the gateway user and drops the cookie', async () => {
    const response = await claim(gateway('alice', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'claimed',
      moved: { courses: 1 },
    });
    expect(clearsAnonymousCookie(response)).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await ownerOf('anon-course')).toBe(ALICE);

    // A retry (the cookie was not dropped yet, a second tab) succeeds idempotently.
    const again = await claim(gateway('alice', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }));
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ status: 'already-claimed' });
    expect(clearsAnonymousCookie(again)).toBe(true);

    // Another account presenting the same cookie cannot have it, and is told
    // to drop it.
    const other = await claim(gateway('mallory', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }));
    expect(other.status).toBe(409);
    await expect(other.json()).resolves.toMatchObject({
      error: { code: 'ALREADY_CLAIMED_ELSEWHERE' },
    });
    expect(clearsAnonymousCookie(other)).toBe(true);
    expect(await ownerOf('anon-course')).toBe(ALICE);
  });

  it('refuses a request with nothing to claim', async () => {
    const response = await claim(gateway('alice', SAME_ORIGIN_JSON));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'NO_PENDING_CLAIM' } });
    expect(setCookies(response)).toEqual([]);
    expect(await ownerOf('anon-course')).toBe(ANON);
  });

  it('refuses an anonymous claimant', async () => {
    vi.stubEnv('OWNER_AUTHENTICATOR', '');
    vi.stubEnv('TRUSTED_PROXY_SECRET', '');
    const response = await claim({ cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TARGET_ANONYMOUS' } });
    expect(await ownerOf('anon-course')).toBe(ANON);
  });

  it('refuses a request whose gateway credential is invalid', async () => {
    const response = await claim({
      ...gateway('alice', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }),
      'x-openmaic-proxy-secret': 'wrong',
    });
    expect(response.status).toBe(401);
    expect(await ownerOf('anon-course')).toBe(ANON);
  });

  it.each([
    ['a cross-site fetch', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }],
    ['a same-site sibling', { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }],
    ['a form post', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['a text/plain post', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }],
    ['a foreign Origin', { 'content-type': 'application/json', origin: 'https://evil.example' }],
  ])('refuses %s (CSRF) and changes nothing', async (_label, headers) => {
    const response = await claim(gateway('alice', { cookie: ANON_COOKIE, ...headers }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CROSS_ORIGIN_REFUSED' },
    });
    expect(setCookies(response)).toEqual([]);
    expect(await ownerOf('anon-course')).toBe(ANON);
  });

  it('accepts a JSON request whose Origin is this host when no Sec-Fetch-Site is sent', async () => {
    const response = await claim(
      gateway('alice', {
        cookie: ANON_COOKIE,
        'content-type': 'application/json; charset=utf-8',
        origin: 'http://localhost',
        host: 'localhost',
      }),
    );
    expect(response.status).toBe(200);
    expect(await ownerOf('anon-course')).toBe(ALICE);
  });

  it('claims on the first request under OWNER_CLAIM_TRIGGER=auto, and not by default', async () => {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const learnerKey = () =>
      handlePersistenceRequest(
        new Request('http://localhost/api/persistence/learner-key', {
          headers: gateway('alice', { cookie: ANON_COOKIE }),
        }),
        { poolFactory: () => pool as never },
      );

    const explicit = await learnerKey();
    expect(explicit.status).toBe(200);
    expect(setCookies(explicit)).toEqual([]);
    expect(await ownerOf('anon-course')).toBe(ANON);

    vi.stubEnv('OWNER_CLAIM_TRIGGER', 'auto');
    const auto = await learnerKey();
    expect(auto.status).toBe(200);
    await expect(auto.json()).resolves.toEqual({ learnerKey: ALICE });
    expect(clearsAnonymousCookie(auto)).toBe(true);
    expect(await ownerOf('anon-course')).toBe(ALICE);
  });

  it('under OWNER_CLAIM_TRIGGER=auto the explicit routes still report their claim as a success', async () => {
    vi.stubEnv('OWNER_CLAIM_TRIGGER', 'auto');
    const response = await claim(gateway('alice', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'claimed' });
    expect(clearsAnonymousCookie(response)).toBe(true);
    expect(await ownerOf('anon-course')).toBe(ALICE);

    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const merge = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/runtime/learners/merge', {
        method: 'POST',
        headers: gateway('alice', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }),
        body: JSON.stringify({ fromLearnerKey: ANON, toLearnerKey: ALICE }),
      }),
      { poolFactory: () => pool as never },
    );
    expect(merge.status).toBe(200);
    await expect(merge.json()).resolves.toEqual({ moved: 0 });
  });

  it('drops a retired anonymous cookie with every OWNER_RETIRED, so the browser recovers', async () => {
    const { createUserSkill } = await import('@/lib/server/agent-runtime/user-skills');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const skill = await createUserSkill(ANON, {
      name: 'my-early',
      title: 'Early',
      description: 'Written before signing in',
      content: 'Early.',
    });
    const claimed = await claim(gateway('alice', { cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON }));
    expect(claimed.status).toBe(200);

    // The browser never applied the claim's Set-Cookie and still presents
    // the retired anonymous cookie, to a deployment that admits anonymous
    // requests.
    vi.stubEnv('OWNER_AUTHENTICATOR', '');
    vi.stubEnv('TRUSTED_PROXY_SECRET', '');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const save = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/stale-course', {
        method: 'PUT',
        headers: { cookie: ANON_COOKIE, 'content-type': 'application/json' },
        body: JSON.stringify(courseDocument('stale-course')),
      }),
      { poolFactory: () => pool as never },
    );
    expect(save.status).toBe(403);
    await expect(save.json()).resolves.toMatchObject({ error: { code: 'OWNER_RETIRED' } });
    expect(clearsAnonymousCookie(save)).toBe(true);

    // A write by id to a row that moved says the same, not "not found".
    const { DELETE } = await import('@/app/api/agent/skills/[id]/route');
    const { NextRequest } = await import('next/server');
    const removed = await DELETE(
      new NextRequest(`http://localhost/api/agent/skills/${skill.id}`, {
        method: 'DELETE',
        headers: { cookie: ANON_COOKIE },
      }),
      { params: Promise.resolve({ id: skill.id }) },
    );
    expect(removed.status).toBe(403);
    await expect(removed.json()).resolves.toMatchObject({ error: { code: 'OWNER_RETIRED' } });
    expect(clearsAnonymousCookie(removed)).toBe(true);

    // Without the cookie, the next request is a fresh anonymous owner.
    const fresh = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/learner-key'),
      { poolFactory: () => pool as never },
    );
    const { learnerKey } = (await fresh.json()) as { learnerKey: string };
    expect(learnerKey).not.toBe(ANON);
  });

  it.each(['OWNER_WRITE_LOCK_WAIT_MS', 'OWNER_CLAIM_LOCK_WAIT_MS'])(
    'refuses a malformed %s at boot, and accepts a well-formed one',
    async (variable) => {
      const { validateOwnerIdentityConfiguration } = await import('@/lib/server/identity/registry');
      for (const bad of ['5s', '0', '-1', '1.5', 'abc']) {
        vi.stubEnv(variable, bad);
        expect(() => validateOwnerIdentityConfiguration()).toThrow(variable);
      }
      vi.stubEnv(variable, '2500');
      expect(() => validateOwnerIdentityConfiguration()).not.toThrow();
    },
  );

  it('refuses an unknown OWNER_CLAIM_TRIGGER at boot', async () => {
    vi.stubEnv('OWNER_CLAIM_TRIGGER', 'sometimes');
    const { validateOwnerIdentityConfiguration } = await import('@/lib/server/identity/registry');
    expect(() => validateOwnerIdentityConfiguration()).toThrow(/OWNER_CLAIM_TRIGGER/);
  });

  it("routes the runtime contract's learner merge through the claim, for the pending claim only", async () => {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const merge = (body: unknown, headers: Record<string, string> = SAME_ORIGIN_JSON) =>
      handlePersistenceRequest(
        new Request('http://localhost/api/persistence/runtime/learners/merge', {
          method: 'POST',
          headers: gateway('alice', { cookie: ANON_COOKIE, ...headers }),
          body: JSON.stringify(body),
        }),
        { poolFactory: () => pool as never },
      );

    // Someone else's learner, or into someone else: refused, nothing moves.
    const foreign = await merge({ fromLearnerKey: 'anon:someone-else', toLearnerKey: ALICE });
    expect(foreign.status).toBe(403);
    const elsewhere = await merge({ fromLearnerKey: ANON, toLearnerKey: 'proxy:bob' });
    expect(elsewhere.status).toBe(403);
    const crossSite = await merge(
      { fromLearnerKey: ANON, toLearnerKey: ALICE },
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    );
    expect(crossSite.status).toBe(403);
    expect(await ownerOf('anon-course')).toBe(ANON);

    const merged = await merge({ fromLearnerKey: ANON, toLearnerKey: ALICE });
    expect(merged.status).toBe(200);
    await expect(merged.json()).resolves.toEqual({ moved: 0 });
    expect(clearsAnonymousCookie(merged)).toBe(true);
    // The whole claim ran, not a runtime-only re-key.
    expect(await ownerOf('anon-course')).toBe(ALICE);
  });
});
