/**
 * The importer against the real app routes and a real PostgreSQL: the
 * persistence endpoint (documents, runtime, assets), the library listing and
 * the folder routes, each resolving the owner from the anonymous cookie. The
 * browser side is fake-indexeddb; every request the importer and the app
 * seams send is routed in-process to the route handlers.
 *
 * Runs when `PG_CONTRACT_URL` is set, in a schema of its own.
 */
import 'fake-indexeddb/auto';

import { HttpAssetStore, HttpDocumentStore } from '@openmaic/storage';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { freshStageId } from '@/lib/legacy-browser-import/ids';
import { ledgerKey } from '@/lib/legacy-browser-import/ledger';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { MemoryStorage, NOW, course, dumpLegacyDatabases, freshBrowser } from './harness';
import { DOCS_COURSE, GEN_IMAGE, NARRATION, TABLES_COURSE, seedLatestBrowser } from './fixtures';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_legacy_browser_import_test';
const COOKIE_A = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
const COOKIE_B = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
const OWNER_A = `anon:${COOKIE_A}`;

describe.skipIf(!contractUrl)('the legacy browser importer against the app routes', () => {
  let admin: Pool;
  let pool: Pool;
  let cookie = COOKIE_A;
  let storage: MemoryStorage;
  const realFetch = globalThis.fetch;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  /** Route an app request to its handler, as the browser would send it with the owner cookie. */
  async function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!raw.startsWith('/') && !raw.startsWith('http://localhost')) return realFetch(input, init);
    const url = new URL(raw, 'http://localhost');
    const headers = new Headers(init?.headers);
    headers.set('cookie', `anonymous_id=${cookie}`);
    // Same-origin, as a browser request to its own origin is.
    headers.set('origin', 'http://localhost');
    const request = new Request(url, { ...init, headers });
    const path = url.pathname;
    const method = request.method;
    if (path.startsWith('/api/persistence')) {
      const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
      return handlePersistenceRequest(request, { poolFactory: () => pool });
    }
    if (path === '/api/stages') {
      const route = await import('@/app/api/stages/route');
      return route.GET(request as never);
    }
    if (path === '/api/folders') {
      const route = await import('@/app/api/folders/route');
      return method === 'POST' ? route.POST(request as never) : route.GET(request as never);
    }
    if (path === '/api/folders/members') {
      const route = await import('@/app/api/folders/members/route');
      return route.POST(request as never);
    }
    throw new Error(`No route for ${method} ${path}`);
  }

  async function call(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return routedFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
  }

  async function libraryIds(): Promise<string[]> {
    const body = (await (await call('/api/stages')).json()) as { stages: { id: string }[] };
    return body.stages.map((stage) => stage.id).sort();
  }

  async function assetText(id: string): Promise<string> {
    const response = await call(`/api/persistence/assets/${encodeURIComponent(id)}/content`);
    expect(response.status).toBe(200);
    return Buffer.from(await response.arrayBuffer()).toString();
  }

  async function configureHttpSeams(): Promise<void> {
    const documentConfig = await import('@/lib/document-store/config');
    const runtimeConfig = await import('@/lib/runtime/config');
    const assetConfig = await import('@/lib/media/asset-pool-config');
    documentConfig.resetDocumentStorageForTests();
    runtimeConfig.resetRuntimeStorageForTests();
    assetConfig.resetAssetPoolStorageForTests();
    // What the client bootstrap configures, with requests routed in-process.
    documentConfig.configureDocumentStorage({
      store: new HttpDocumentStore({
        baseUrl: '/api/persistence',
        fetch: routedFetch,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      }),
    });
    runtimeConfig.configureRuntimeStorage({
      store: new HttpRuntimeStore({ baseUrl: '/api/persistence', fetch: routedFetch }),
      learnerKey: async () => {
        const body = (await (await call('/api/persistence/learner-key')).json()) as {
          learnerKey: string;
        };
        return body.learnerKey;
      },
    });
    assetConfig.configureAssetPoolStorage({
      store: () => new HttpAssetStore({ baseUrl: '/api/persistence', fetch: routedFetch }),
    });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=legacy-browser-import`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    // Prime the provider for this URL so the library and folder routes use
    // this schema's pool too.
    await getServerPersistenceProvider(databaseUrl, () => pool);
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query(
      `DO $$ DECLARE r record; BEGIN
         FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${TEST_SCHEMA}' LOOP
           EXECUTE 'TRUNCATE ' || quote_ident(r.tablename) || ' CASCADE';
         END LOOP;
       END $$;`,
    );
    await freshBrowser();
    cookie = COOKIE_A;
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
    vi.stubGlobal('fetch', routedFetch);
    await configureHttpSeams();
  });

  afterEach(async () => {
    const { clearAssetPool } = await import('@/lib/media/asset-pool');
    await clearAssetPool();
    vi.unstubAllGlobals();
  });

  it('imports a browser-only browser: library, media, runtime, chat and folders', async () => {
    await seedLatestBrowser(storage);
    const legacyBefore = await dumpLegacyDatabases();

    const outcome = await runLegacyBrowserImport({ storage, locks: null, now: () => NOW });

    expect(outcome.status).toBe('complete');
    expect(outcome.ownerId).toBe(OWNER_A);
    expect(await libraryIds()).toEqual([DOCS_COURSE, TABLES_COURSE]);

    const docs = (await (await call(`/api/persistence/documents/${DOCS_COURSE}`)).json()) as {
      scenes: {
        content: { canvas: { elements: { src: string }[] } };
        actions?: { audioId?: string }[];
      }[];
    };
    const srcs = docs.scenes.flatMap((scene) => scene.content.canvas.elements.map((e) => e.src));
    expect(srcs[0]).toMatch(/^ast_/);
    expect(await assetText(srcs[1]!)).toBe(Buffer.from(await GEN_IMAGE.arrayBuffer()).toString());
    expect(srcs[2]).toBe('gen_img_2');
    const audioId = docs.scenes[1]!.actions![0]!.audioId!;
    expect(await assetText(audioId)).toBe(Buffer.from(await NARRATION.arrayBuffer()).toString());

    // Runtime, as the runtime contract serves it to this learner.
    const sessions = (await (
      await call(
        `/api/persistence/runtime/stages/${DOCS_COURSE}/learners/${encodeURIComponent(OWNER_A)}/sessions`,
      )
    ).json()) as { kind: string }[];
    expect(sessions.map((session) => session.kind).sort()).toEqual(['quizAttempt', 'whiteboard']);

    // Folders and membership, as the library lists them.
    const folders = (await (await call('/api/folders')).json()) as {
      folders: { id: string; name: string }[];
    };
    expect(folders.folders.map((folder) => folder.name).sort()).toEqual(['Empty', 'Physics']);
    const listing = (await (await call('/api/stages')).json()) as {
      stages: { id: string; folderId?: string }[];
    };
    const physics = folders.folders.find((folder) => folder.name === 'Physics')!;
    expect(listing.stages.find((stage) => stage.id === TABLES_COURSE)?.folderId).toBe(physics.id);

    expect(await dumpLegacyDatabases()).toEqual(legacyBefore);

    // Nothing twice, even with the ledger gone.
    const assetCount = async () =>
      Number((await pool.query('SELECT count(*)::int AS n FROM asset_entries')).rows[0].n);
    const before = await assetCount();
    storage.removeItem(ledgerKey(OWNER_A));
    expect((await runLegacyBrowserImport({ storage, locks: null, now: () => NOW })).status).toBe(
      'complete',
    );
    expect(await libraryIds()).toEqual([DOCS_COURSE, TABLES_COURSE]);
    expect(await assetCount()).toBe(before);
  });

  it('imports under a fresh id when another owner holds the course id', async () => {
    cookie = COOKIE_B;
    expect(
      (
        await call(
          `/api/persistence/documents/${DOCS_COURSE}`,
          'PUT',
          course(DOCS_COURSE, [{ id: 'theirs', order: 0 }]),
        )
      ).status,
    ).toBeLessThan(300);
    cookie = COOKIE_A;
    await seedLatestBrowser(storage);

    const outcome = await runLegacyBrowserImport({ storage, locks: null, now: () => NOW });

    expect(outcome.status).toBe('complete');
    const fresh = freshStageId(DOCS_COURSE, OWNER_A);
    expect(await libraryIds()).toEqual([fresh, TABLES_COURSE].sort());
    cookie = COOKIE_B;
    const theirs = (await (await call(`/api/persistence/documents/${DOCS_COURSE}`)).json()) as {
      scenes: { id: string }[];
    };
    expect(theirs.scenes.map((scene) => scene.id)).toEqual(['theirs']);
  });

  it('leaves a course this owner deleted on the server deleted', async () => {
    expect(
      (
        await call(
          `/api/persistence/documents/${DOCS_COURSE}`,
          'PUT',
          course(DOCS_COURSE, [{ id: 'mine', order: 0 }]),
        )
      ).status,
    ).toBeLessThan(300);
    expect((await call(`/api/persistence/documents/${DOCS_COURSE}`, 'DELETE')).status).toBeLessThan(
      300,
    );
    await seedLatestBrowser(storage);

    const outcome = await runLegacyBrowserImport({ storage, locks: null, now: () => NOW });

    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'skipped',
      reason: 'deleted on the server',
    });
    expect(await libraryIds()).toEqual([TABLES_COURSE]);
  });

  it('keeps an existing server course and fills in its media only', async () => {
    const synced = course(DOCS_COURSE, [{ id: 'docs-scene-2', order: 0, imageRef: 'gen_img_1' }]);
    synced.stage.name = 'Kept';
    expect(
      (await call(`/api/persistence/documents/${DOCS_COURSE}`, 'PUT', synced)).status,
    ).toBeLessThan(300);
    await seedLatestBrowser(storage);

    await runLegacyBrowserImport({ storage, locks: null, now: () => NOW });

    const after = (await (await call(`/api/persistence/documents/${DOCS_COURSE}`)).json()) as {
      stage: { name: string };
      scenes: { content: { canvas: { elements: { src: string }[] } } }[];
    };
    expect(after.stage.name).toBe('Kept');
    const src = after.scenes[0]!.content.canvas.elements[0]!.src;
    expect(await assetText(src)).toBe(Buffer.from(await GEN_IMAGE.arrayBuffer()).toString());
  });
});
