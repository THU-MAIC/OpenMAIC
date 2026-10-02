import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { AssetAllocateRequest } from '@/lib/server/persistence-hooks/types';

/**
 * Upload admission (`beforeAssetAllocate`) and the host byte store
 * (`configureAssetByteStore`), on the real persistence route and PostgreSQL
 * registry over an in-memory database.
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

const COOKIE = '11111111-1111-4111-8111-111111111111';
const OWNER = `anon:${COOKIE}`;

function assetForm(bytes: number[]): FormData {
  const form = new FormData();
  form.append('meta', new Blob([JSON.stringify({})], { type: 'application/json' }), 'meta');
  form.append('bytes', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'bytes');
  return form;
}

/** An object store in memory: bytes outside the registry database. */
function memoryByteStore(options: { sign?: boolean } = {}) {
  const bytes = new Map<string, Uint8Array>();
  return {
    bytes,
    store: {
      write: async (hash: string, value: Uint8Array) => void bytes.set(hash, value),
      read: async (hash: string) => bytes.get(hash) ?? null,
      delete: async (hash: string) => void bytes.delete(hash),
      writesOutsideRegistryDatabase: true as const,
      ...(options.sign
        ? { signReadUrl: async (hash: string) => `https://objects.example.org/${hash}?sig=1` }
        : {}),
    },
  };
}

describe('host asset hooks', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://asset-hooks-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('ASSET_BYTE_EGRESS', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  /** Bring the provider up, after whatever the test registered. */
  async function startProvider() {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  }

  async function call(
    path: string,
    init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        method: init.method ?? 'GET',
        headers: { cookie: `anonymous_id=${COOKIE}`, ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
      }),
      { poolFactory: () => pool as never },
    );
  }

  async function countRows(table: string): Promise<number> {
    const result = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number((result.rows[0] as { n: number | string }).n);
  }

  describe('beforeAssetAllocate', () => {
    it('allocates exactly as before when no hook is registered', async () => {
      await startProvider();
      const response = await call('/assets', { method: 'POST', body: assetForm([1, 2, 3]) });
      expect(response.status).toBe(201);
      expect(await countRows('asset_entries')).toBe(1);
    });

    it('answers with the host Response and stores nothing when it refuses', async () => {
      const seen: Array<{ principal: OwnerPrincipal; req: AssetAllocateRequest }> = [];
      const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
      configurePersistenceHooks({
        name: 'test-host',
        beforeAssetAllocate: async (principal, req) => {
          seen.push({ principal, req });
          return Response.json({ error: { code: 'UPLOAD_BUDGET' } }, { status: 429 });
        },
      });
      await startProvider();

      const response = await call('/assets', {
        method: 'POST',
        body: assetForm([1, 2, 3]),
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({ error: { code: 'UPLOAD_BUDGET' } });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.principal.ownerId).toBe(OWNER);
      expect(seen[0]!.req.operation).toBe('create');
      expect(seen[0]!.req.assetId).toBeUndefined();
      expect(seen[0]!.req.method).toBe('POST');
      expect(seen[0]!.req.url).toBe('http://localhost/api/persistence/assets');
      expect(seen[0]!.req.headers.get('x-forwarded-for')).toBe('203.0.113.7');
      // Refused before the body was read: no entry, no bytes, nothing counted.
      expect(await countRows('asset_entries')).toBe(0);
      expect(await countRows('asset_blobs')).toBe(0);
    });

    it('is decided by the storage handler’s own routing, so no path spelling allocates past it', async () => {
      const hook = vi.fn(async () => new Response(null, { status: 429 }));
      const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
      configurePersistenceHooks({ name: 'test-host', beforeAssetAllocate: hook });
      await startProvider();

      // The hook runs inside the handler's asset authorization step, after it
      // matched POST on the collection route. A spelling the handler does not
      // route there allocates nothing and needs no admission; one it does is
      // admitted by the hook.
      for (const path of ['/%61ssets', '/assets/', '/assets?x=1']) {
        const response = await call(path, { method: 'POST', body: assetForm([4]) });
        expect(response.status, path).not.toBe(201);
      }
      expect(await countRows('asset_entries')).toBe(0);
      const refused = await call('/assets', { method: 'POST', body: assetForm([4]) });
      expect(refused.status).toBe(429);
      expect(hook).toHaveBeenCalledOnce();
    });

    it('lets the upload proceed on undefined, and is not consulted for reads', async () => {
      const hook = vi.fn(async () => undefined);
      const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
      configurePersistenceHooks({ name: 'test-host', beforeAssetAllocate: hook });
      await startProvider();

      const created = await call('/assets', { method: 'POST', body: assetForm([5, 6]) });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const read = await call(`/assets/${id}/content`);
      expect(read.status).toBe(200);
      expect(hook).toHaveBeenCalledOnce();
    });

    it('gates a replace too: refused before the new bytes are stored or counted', async () => {
      const seen: AssetAllocateRequest[] = [];
      const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
      configurePersistenceHooks({
        name: 'test-host',
        beforeAssetAllocate: async (_principal, req) => {
          seen.push(req);
          return req.operation === 'replace'
            ? Response.json({ error: { code: 'UPLOADS_FROZEN' } }, { status: 423 })
            : undefined;
        },
      });
      await startProvider();

      const created = await call('/assets', { method: 'POST', body: assetForm([1, 1]) });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const blobsBefore = await countRows('asset_blobs');

      // Percent-encoded id: the hook sees it decoded, as the handler routes it.
      const encoded = encodeURIComponent(id).replace(/-/g, '%2D');
      const replaced = await call(`/assets/${encoded}/content`, {
        method: 'PUT',
        body: assetForm([2, 2, 2]),
      });
      expect(replaced.status).toBe(423);
      expect(seen.map((req) => req.operation)).toEqual(['create', 'replace']);
      expect(seen[1]!.assetId).toBe(id);
      expect(await countRows('asset_blobs')).toBe(blobsBefore);
      const read = await call(`/assets/${id}/content`);
      expect(read.headers.get('x-asset-revision')).toBe('1');
      expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([1, 1]);
    });

    it('answers 500 for a hook that resolves something other than a Response', async () => {
      const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
      configurePersistenceHooks({
        name: 'test-host',
        beforeAssetAllocate: async () => 'no' as never,
      });
      await startProvider();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await call('/assets', { method: 'POST', body: assetForm([7]) });
      expect(response.status).toBe(500);
      expect(await countRows('asset_entries')).toBe(0);
    });
  });

  describe('configureAssetByteStore', () => {
    it('degrades to direct bytes when a store declared to sign cannot, and the collector still builds it', async () => {
      vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
      const memory = memoryByteStore();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { configureAssetByteStore } = await import('@/lib/server/persistence-hooks');
      configureAssetByteStore({
        name: 'claims-to-sign',
        create: () => memory.store,
        signsReadUrls: true,
      });
      await startProvider();

      const created = await call('/assets', { method: 'POST', body: assetForm([6, 6]) });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const read = await call(`/assets/${id}/content`);
      expect(read.status).toBe(200);
      expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([6, 6]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/declares signsReadUrls but has no/));

      const { resolveConfiguredAssetByteStore } =
        await import('@/lib/persistence/asset-byte-store');
      await expect(resolveConfiguredAssetByteStore(pool as never)).resolves.toBe(memory.store);
    });

    it('stores and serves bytes through the host store instead of the PostgreSQL column', async () => {
      const memory = memoryByteStore();
      const create = vi.fn((_context: unknown) => memory.store);
      const { configureAssetByteStore } = await import('@/lib/server/persistence-hooks');
      configureAssetByteStore({ name: 'memory', create });
      await startProvider();

      const created = await call('/assets', { method: 'POST', body: assetForm([9, 8, 7]) });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(memory.bytes.size).toBe(1);
      const blobBytes = await pool.query(
        'SELECT COUNT(*) AS n FROM asset_blobs WHERE bytes IS NOT NULL',
      );
      expect(Number((blobBytes.rows[0] as { n: number }).n)).toBe(0);

      const read = await call(`/assets/${id}/content`);
      expect(read.status).toBe(200);
      expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([9, 8, 7]);
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0]).toEqual({ queryable: pool });
    });

    it('builds the collector’s store from the same registration', async () => {
      const create = vi.fn((_context: unknown) => memoryByteStore().store);
      const { configureAssetByteStore } = await import('@/lib/server/persistence-hooks');
      configureAssetByteStore({ name: 'memory', create });
      const { resolveConfiguredAssetByteStore } =
        await import('@/lib/persistence/asset-byte-store');
      const collectorQueryable = { query: vi.fn() };

      const store = await resolveConfiguredAssetByteStore(collectorQueryable as never);
      expect(store.writesOutsideRegistryDatabase).toBe(true);
      expect(create).toHaveBeenCalledExactlyOnceWith({ queryable: collectorQueryable });
    });

    it('fails asset requests only, and retries, when the host store is not usable', async () => {
      let attempt = 0;
      const { configureAssetByteStore } = await import('@/lib/server/persistence-hooks');
      configureAssetByteStore({
        name: 'in-database',
        create: () => {
          attempt += 1;
          // Missing writesOutsideRegistryDatabase: would deadlock the registry.
          const { writesOutsideRegistryDatabase: _omitted, ...store } = memoryByteStore().store;
          return store as never;
        },
      });
      await startProvider();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const upload = await call('/assets', { method: 'POST', body: assetForm([1]) });
      expect(upload.status).toBe(500);
      const again = await call('/assets', { method: 'POST', body: assetForm([1]) });
      expect(again.status).toBe(500);
      expect(attempt).toBe(2);
      // Documents are untouched by an asset misconfiguration.
      expect((await call('/documents/stage-anything')).status).toBe(404);
    });

    it('redirects byte reads to the host store’s signed URL under ASSET_BYTE_EGRESS=redirect', async () => {
      vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
      const memory = memoryByteStore({ sign: true });
      const { configureAssetByteStore } = await import('@/lib/server/persistence-hooks');
      configureAssetByteStore({ name: 'signing', create: () => memory.store, signsReadUrls: true });
      await startProvider();

      const created = await call('/assets', { method: 'POST', body: assetForm([3, 3]) });
      const { id } = (await created.json()) as { id: string };
      const read = await call(`/assets/${id}/content`);
      expect(read.status).toBe(302);
      expect(read.headers.get('location')).toMatch(/^https:\/\/objects\.example\.org\//);
    });
  });
});
