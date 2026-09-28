import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { BINDING_ENDPOINT, FENCED_ENDPOINTS } from '@/lib/legacy-browser-import/server';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import type { OwnerAuthMethod } from '@/lib/server/identity/types';

/**
 * The server side of the one-way legacy browser import, on the real routes
 * and an in-memory PostgreSQL: `POST /api/identity/legacy-import-binding`
 * binds a browser to the first owner (atomically), a claim carries the binding
 * to the account, and owner resolution refuses every importer request
 * (`X-OpenMAIC-Legacy-Import`) of an owner that does not hold the binding --
 * on every route the importer's clients reach.
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

const ANON_UUID = '9b1c9a8e-2b3f-4c4d-9e5f-6a7b8c9d0e1f';
const ANON = `anon:${ANON_UUID}`;
const ANON_COOKIE = `anonymous_id=${ANON_UUID}`;
const BROWSER = '0123456789abcdef0123456789abcdef';
const OTHER_BROWSER = 'fedcba9876543210fedcba9876543210';
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

const as = (user: string) => ({ 'x-test-session': user });

describe('the legacy import binding and its fence', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://legacy-binding-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('OWNER_CLAIM_TRIGGER', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [sessionMethod] });
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function bind(headers: Record<string, string>, browserId: unknown = BROWSER) {
    const { POST } = await import('@/app/api/identity/legacy-import-binding/route');
    return POST(
      new Request(`http://localhost${BINDING_ENDPOINT}`, {
        method: 'POST',
        headers: { ...SAME_ORIGIN_JSON, ...headers },
        body: JSON.stringify({ browserId }),
      }),
    );
  }

  async function bound(headers: Record<string, string>, browserId: unknown = BROWSER) {
    const response = await bind(headers, browserId);
    expect(response.status).toBe(200);
    return ((await response.json()) as { bound: boolean }).bound;
  }

  it('binds the browser to the first owner and tells every other owner no', async () => {
    expect(await bound(as('alice'))).toBe(true);
    expect(await bound(as('bob'))).toBe(false);
    expect(await bound(as('alice'))).toBe(true);
    expect(await bound(as('bob'), OTHER_BROWSER)).toBe(true);
    const rows = await pool.query(
      'SELECT browser_id, owner_id FROM legacy_import_bindings ORDER BY 1',
    );
    expect(rows.rows).toEqual([
      { browser_id: BROWSER, owner_id: 'user:alice' },
      { browser_id: OTHER_BROWSER, owner_id: 'user:bob' },
    ]);
  });

  it('decides a race of two owners with one winner', async () => {
    const answers = await Promise.all(
      ['alice', 'bob', 'carol', 'dave'].map((user) => bound(as(user))),
    );
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a malformed browser id, a cross-site request and an invalid credential', async () => {
    for (const id of ['', 'ABCDEF0123456789ABCDEF0123456789', '0123', 42, `${BROWSER}0`]) {
      expect((await bind(as('alice'), id)).status).toBe(400);
    }
    const { POST } = await import('@/app/api/identity/legacy-import-binding/route');
    const crossSite = await POST(
      new Request(`http://localhost${BINDING_ENDPOINT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ browserId: BROWSER }),
      }),
    );
    expect(crossSite.status).toBe(403);
    expect((await bind(as('bad'))).status).toBe(401);
  });

  it('carries the binding to the account when an anonymous owner is claimed', async () => {
    await createOwnerBoundDocumentStore({
      pool,
      ownerId: ANON,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).saveDocument({
      stage: { id: 'anon-course', name: 'x', createdAt: 1, updatedAt: 1 },
      scenes: [],
    } as never);
    expect(await bound({ cookie: ANON_COOKIE })).toBe(true);

    const { POST } = await import('@/app/api/identity/claim/route');
    const claimed = await POST(
      new Request('http://localhost/api/identity/claim', {
        method: 'POST',
        headers: { ...as('alice'), cookie: ANON_COOKIE, ...SAME_ORIGIN_JSON },
        body: '{}',
      }),
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      moved: { 'legacy-import-bindings': 1 },
    });

    expect(await bound(as('alice'))).toBe(true);
    expect(await bound(as('bob'))).toBe(false);
  });

  // ---- the fence -----------------------------------------------------------

  function concrete(path: string): string {
    return path
      .replace(':id', 'fence-course')
      .replace(':sceneId', 'fence-scene')
      .replace(':s', 'fence-course')
      .replace(':l', 'user%3Aalice');
  }

  async function send(
    endpoint: (typeof FENCED_ENDPOINTS)[number],
    headers: Record<string, string>,
  ): Promise<Response> {
    const url = `http://localhost${concrete(endpoint.path)}`;
    const hasBody = !['GET', 'HEAD'].includes(endpoint.method);
    // Bodies a route accepts, so every request gets as far as resolving its
    // owner (the folder routes validate the body first).
    const bodies: Record<string, unknown> = {
      'POST /api/folders': { name: 'Fence' },
      'POST /api/folders/members': { stageId: 'fence-course', folderId: null },
    };
    const body = bodies[`${endpoint.method} ${endpoint.path}`] ?? {};
    const request = new Request(url, {
      method: endpoint.method,
      headers: { ...SAME_ORIGIN_JSON, ...headers },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    if (endpoint.route === 'app/api/persistence/[...path]/route.ts') {
      const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
      return handlePersistenceRequest(request);
    }
    const modules: Record<string, () => Promise<Record<string, unknown>>> = {
      'app/api/stages/route.ts': () => import('@/app/api/stages/route'),
      'app/api/folders/route.ts': () => import('@/app/api/folders/route'),
      'app/api/folders/members/route.ts': () => import('@/app/api/folders/members/route'),
    };
    const load = modules[endpoint.route];
    if (!load) throw new Error(`No handler table entry for ${endpoint.route}`);
    const handler = (await load())[endpoint.method] as (request: Request) => Promise<Response>;
    return handler(request);
  }

  it.each(FENCED_ENDPOINTS.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint]))(
    '%s refuses an importer request of an owner that does not hold the browser',
    async (_label, endpoint) => {
      expect(await bound(as('alice'))).toBe(true);

      const foreign = await send(endpoint, {
        ...as('bob'),
        'x-openmaic-legacy-import': BROWSER,
      });
      expect(foreign.status).toBe(409);
      if (endpoint.method !== 'HEAD') {
        await expect(foreign.json()).resolves.toMatchObject({
          error: { code: 'LEGACY_IMPORT_NOT_BOUND' },
        });
      }
      const unbound = await send(endpoint, {
        ...as('alice'),
        'x-openmaic-legacy-import': OTHER_BROWSER,
      });
      expect(unbound.status).toBe(409);

      // The holder passes the fence (whatever the route then answers), and a
      // request without the header is not fenced at all.
      const holder = await send(endpoint, { ...as('alice'), 'x-openmaic-legacy-import': BROWSER });
      expect(holder.status).not.toBe(409);
      const plain = await send(endpoint, as('bob'));
      expect(plain.status).not.toBe(409);
    },
  );

  it('answers 400 for a malformed browser id in the header', async () => {
    const response = await send(FENCED_ENDPOINTS[0], {
      ...as('alice'),
      'x-openmaic-legacy-import': 'not-hex',
    });
    expect(response.status).toBe(400);
  });

  it('lists every route the importer clients reach', () => {
    const source = readFileSync(join(process.cwd(), 'lib/legacy-browser-import/server.ts'), 'utf8');
    const paths = new Set([...source.matchAll(/'(\/api\/[^']*)'/g)].map((match) => match[1]!));
    const fenced = FENCED_ENDPOINTS.map((endpoint) => endpoint.path);
    for (const path of paths) {
      if (path === BINDING_ENDPOINT) continue;
      expect(
        fenced.some((candidate) => candidate === path || candidate.startsWith(`${path}/`)),
        `${path} is reached by the importer but not in FENCED_ENDPOINTS`,
      ).toBe(true);
    }
    for (const endpoint of FENCED_ENDPOINTS) {
      expect(() => readFileSync(join(process.cwd(), endpoint.route))).not.toThrow();
    }
  });
});
