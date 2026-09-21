// The server half of the KV HTTP contract. `http-kv-store.test.ts` runs the
// CLIENT against a test-only conformance harness; this file runs the same
// shared contract against the REAL handler over the real backend, so the two
// halves are proven to meet. The harness explicitly says it "must not quietly
// become" the server-side backend — this is the file that keeps that promise.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { BrowserKVStore } from '../src/kv/browser.js';
import { HttpKVStore } from '../src/kv/http.js';
import { PgKVStore, ensureKVSchema } from '../src/kv/pg.js';
import { createKVHttpHandler } from '../src/server/kv.js';
import type { Queryable } from '../src/runtime/pg.js';
import { runKVStoreContract } from './kv-contract.js';
import { MemoryStorage } from './setup.js';

const OWNER_HEADER = 'x-test-owner';

let db: PGlite;
let server: Server;
let baseUrl: string;
let owners = 0;

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.transaction((tx: Queryable) => ensureKVSchema(tx));
  const store = new PgKVStore({
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  });
  const handler = createKVHttpHandler(store, {
    authenticate: (req) => {
      const owner = req.headers[OWNER_HEADER];
      return typeof owner === 'string' && owner !== '' ? { owner } : undefined;
    },
  });
  server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

/** One client bound to its own owner — the contract suite must not collide. */
function makeStore(owner = `owner-${owners++}`): HttpKVStore {
  return new HttpKVStore({
    baseUrl,
    deviceStore: new BrowserKVStore({ storage: new MemoryStorage() }),
    headers: () => ({ [OWNER_HEADER]: owner }),
  });
}

runKVStoreContract('real KV handler over PostgreSQL', () => makeStore());

describe('KV handler refuses what the contract forbids', () => {
  test('a device scope on the wire is refused, never silently discarded', async () => {
    const res = await fetch(`${baseUrl}/kv/entries/settings?scope=device`, {
      method: 'PUT',
      headers: { [OWNER_HEADER]: 'owner-scope', 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status, 'device scope crossed the network boundary').toBe(400);
  });

  test('a scope path segment is refused', async () => {
    const res = await fetch(`${baseUrl}/kv/device/keys`, {
      method: 'GET',
      headers: { [OWNER_HEADER]: 'owner-scope' },
    });
    expect(res.status, 'device scope crossed the network boundary').toBe(400);
  });

  test('a scope field in a write body is refused', async () => {
    const res = await fetch(`${baseUrl}/kv/entries/settings`, {
      method: 'PUT',
      headers: { [OWNER_HEADER]: 'owner-scope', 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1, scope: 'device' }),
    });
    expect(res.status, 'device scope crossed the network boundary').toBe(400);
  });

  test('the account partition never leaks across owners', async () => {
    const a = makeStore('owner-alpha');
    await a.set('settings', { voice: 'a' });
    const b = makeStore('owner-beta');
    expect(await b.get('settings'), 'account partition leaked across owners').toBeNull();
    expect(await a.get('settings')).toEqual({ voice: 'a' });
  });

  test('an unauthenticated request never reaches the store', async () => {
    const res = await fetch(`${baseUrl}/kv/entries/settings`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
