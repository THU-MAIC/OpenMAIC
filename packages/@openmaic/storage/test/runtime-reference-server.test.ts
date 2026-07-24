import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test, vi } from 'vitest';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import { HttpRuntimeStore } from '../src/runtime/http.js';
import type { RuntimePayloadValidator, RuntimeStore } from '../src/runtime/types.js';
import { createRuntimeHttpHandler } from '../src/server/index.js';
import {
  createReferenceRuntimeServer,
  type ConnectableQueryable,
} from '../src/server/reference.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

const BASE_URL = 'http://runtime-reference.invalid';

function handlerFetch(
  handler: RequestListener,
  authorizationFor: (request: Request) => Promise<string | undefined>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = await authorizationFor(request);
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    if (authorization !== undefined) headers.authorization = authorization;

    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;

    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let responseHeaders: Record<string, string> = {};
      let responseBody: string | undefined;
      let headersSent = false;
      const fakeResponse = {
        get headersSent() {
          return headersSent;
        },
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          responseHeaders = nextHeaders ?? {};
          headersSent = true;
          return this;
        },
        end(chunk?: string | Buffer) {
          responseBody = chunk === undefined ? undefined : chunk.toString();
          resolve(
            new Response(status === 204 ? null : responseBody, {
              status,
              headers: responseHeaders,
            }),
          );
          return this;
        },
        destroy(error?: Error) {
          reject(error ?? new Error('response destroyed'));
          return this;
        },
      } as unknown as ServerResponse;

      try {
        handler(fakeRequest, fakeResponse);
      } catch (error) {
        reject(error);
      }
    });
  };
}

function bearerLearner(req: IncomingMessage): { learnerKey: string } | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined;
  const learnerKey = authorization.slice('Bearer '.length);
  return learnerKey === '' ? undefined : { learnerKey };
}

async function contractCredential(request: Request, store: RuntimeStore): Promise<string> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'POST' && path === '/runtime/sessions') {
    const body = (await request.clone().json()) as { learnerKey: string };
    return `Bearer ${body.learnerKey || 'invalid-envelope'}`;
  }
  const listedLearner = path.match(/^\/runtime\/stages\/[^/]+\/learners\/([^/]+)/)?.[1];
  if (listedLearner !== undefined) return `Bearer ${decodeURIComponent(listedLearner)}`;
  const sessionId = path.match(/^\/runtime\/sessions\/([^/]+)/)?.[1];
  if (sessionId !== undefined) {
    const session = await store.getSession(decodeURIComponent(sessionId));
    if (session !== undefined) return `Bearer ${session.learnerKey}`;
  }
  return 'Bearer contract-operator';
}

runRuntimeStoreContract('reference HTTP handler', () => {
  const backingStore = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
  const handler = createRuntimeHttpHandler(backingStore, {
    authenticate: async (req) => bearerLearner(req),
    authorizeMerge: async () => true,
    // The shared contract includes deleteAllRuntime, so this explicitly grants
    // its test-only operator principal access to the admin route.
    authorizeAdmin: async () => true,
  });
  return new HttpRuntimeStore({
    baseUrl: BASE_URL,
    fetch: handlerFetch(handler, (request) => contractCredential(request, backingStore)),
  });
});

describe('reference HTTP handler records-route existence concealment', () => {
  function makeHarness() {
    const backingStore = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(backingStore, {
      authenticate: async (req) => bearerLearner(req),
    });
    const fetchAs = (authorization: string) => handlerFetch(handler, async () => authorization);
    return { backingStore, fetchAs };
  }

  test('absent and foreign sessions answer the records route identically', async () => {
    const { backingStore, fetchAs } = makeHarness();
    await backingStore.createSession(
      makeSession({ id: 'victim-session', learnerKey: 'learner-victim' }),
    );

    const absent = await fetchAs('Bearer learner-probe')(
      `${BASE_URL}/runtime/sessions/no-such-session/records`,
    );
    const foreign = await fetchAs('Bearer learner-probe')(
      `${BASE_URL}/runtime/sessions/victim-session/records`,
    );

    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(((await absent.json()) as { error: { code: string } }).error.code).toBe(
      ((await foreign.json()) as { error: { code: string } }).error.code,
    );
  });

  test('the client restores empty-list semantics for the concealed 404', async () => {
    const { fetchAs } = makeHarness();
    const client = new HttpRuntimeStore({
      baseUrl: BASE_URL,
      fetch: fetchAs('Bearer learner-probe'),
    });

    await expect(client.listRecords('no-such-session')).resolves.toEqual([]);
  });
});

describe('reference HTTP handler DELETE /runtime authorization', () => {
  function makeHarness() {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async (req) => bearerLearner(req),
      authorizeAdmin: async (principal) => principal.learnerKey === 'admin',
    });
    const request = (authorization?: string) =>
      handlerFetch(handler, async () => authorization)(`${BASE_URL}/runtime`, {
        method: 'DELETE',
      });
    return { request, store };
  }

  test('denies a learner credential with 403', async () => {
    const { request } = makeHarness();
    const response = await request('Bearer learner-1');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_ADMIN' },
    });
  });

  test('denies a missing credential with 401', async () => {
    const { request } = makeHarness();
    const response = await request();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    });
  });

  test('allows an admin credential and empties the runtime store', async () => {
    const { request, store } = makeHarness();
    await store.createSession(makeSession({ id: 'stage-1-session' }));
    await store.appendRecord(makeRecordInit('stage-1-session'));
    await store.createSession(makeSession({ id: 'stage-2-session', stageId: 'stage-2' }));

    const response = await request('Bearer admin');

    expect(response.status).toBe(204);
    expect(await store.getSession('stage-1-session')).toBeUndefined();
    expect(await store.getSession('stage-2-session')).toBeUndefined();
    expect(await store.listRecords('stage-1-session')).toEqual([]);
  });
});

describe('reference HTTP handler principal capabilities', () => {
  test('allows admin-only and merge-only principals without a fabricated learnerKey', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({}),
      authorizeAdmin: async () => true,
      authorizeMerge: async () => true,
    });
    const request = handlerFetch(handler, async () => 'Bearer capability-only');

    const adminResponse = await request(`${BASE_URL}/runtime`, { method: 'DELETE' });
    expect(adminResponse.status).toBe(204);

    const mergeResponse = await request(`${BASE_URL}/runtime/learners/merge`, {
      method: 'POST',
      body: JSON.stringify({ fromLearnerKey: 'learner-a', toLearnerKey: 'learner-b' }),
    });
    expect(mergeResponse.status).toBe(200);
  });

  test('reference factory stays unbound and applies authorization overrides', async () => {
    const statements: string[] = [];
    const query = async (text: string) => {
      statements.push(text);
      return { rows: [] };
    };
    const pool = {
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as unknown as ConnectableQueryable;
    const server = await createReferenceRuntimeServer(pool, {
      authenticate: async () => ({}),
      authorizeAdmin: async () => true,
      authorizeMerge: async () => true,
      payloadValidators: {},
      maxBodyBytes: 64,
    });
    const handler = server.listeners('request')[0] as RequestListener;

    expect(server.listening).toBe(false);
    const response = await handlerFetch(handler, async () => 'Bearer capability-only')(
      `${BASE_URL}/runtime`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(204);
    expect(statements).toContain('DELETE FROM runtime_sessions');

    const oversized = await handlerFetch(handler, async () => 'Bearer capability-only')(
      `${BASE_URL}/runtime/learners/merge`,
      {
        method: 'POST',
        body: JSON.stringify({ padding: 'x'.repeat(100) }),
      },
    );
    expect(oversized.status).toBe(413);
  });

  test('returns 403 FORBIDDEN_LEARNER on learner routes without learnerKey', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, { authenticate: async () => ({}) });
    const response = await handlerFetch(
      handler,
      async () => 'Bearer admin-only',
    )(`${BASE_URL}/runtime/stages/stage-1/learners/learner-a/sessions`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN_LEARNER' },
    });
  });
});

describe('reference HTTP handler validation boundary', () => {
  test('rejects an oversized request body with 413 and accepts an under-limit body', async () => {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'anon:device-1' }),
      maxBodyBytes: 256,
    });
    const request = handlerFetch(handler, async () => 'Bearer anon:device-1');

    const oversized = await request(`${BASE_URL}/runtime/sessions`, {
      method: 'POST',
      body: JSON.stringify({ padding: 'x'.repeat(300) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });

    const accepted = await request(`${BASE_URL}/runtime/sessions`, {
      method: 'POST',
      body: JSON.stringify(makeSession({ id: 'under-limit' })),
    });
    expect(accepted.status).toBe(201);
  });

  test.each([
    ['session id with NUL', makeSession({ id: 'bad\u0000session' })],
    ['session stageId with a lone surrogate', makeSession({ stageId: 'bad\ud800stage' })],
  ])('rejects a non-JSON-domain %s before calling the store', async (_label, init) => {
    let createCalled = false;
    const store = {
      getSession: async () => undefined,
      createSession: async () => {
        createCalled = true;
        throw new Error('must not be called');
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'anon:device-1' }),
    });
    const response = await handlerFetch(handler, async () => 'Bearer anon:device-1')(
      `${BASE_URL}/runtime/sessions`,
      { method: 'POST', body: JSON.stringify(init) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(createCalled).toBe(false);
  });

  test.each([
    ['record id with NUL', { id: 'bad\u0000record' }],
    ['record sceneId with a lone surrogate', { sceneId: 'bad\ud800scene' }],
  ])('rejects a non-JSON-domain %s before calling the store', async (_label, overrides) => {
    const session = { ...makeSession(), runtimeDslVersion: RUNTIME_DSL_VERSION };
    let appendCalled = false;
    const store = {
      getSession: async () => session,
      appendRecord: async () => {
        appendCalled = true;
        throw new Error('must not be called');
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: session.learnerKey }),
    });
    const response = await handlerFetch(handler, async () => `Bearer ${session.learnerKey}`)(
      `${BASE_URL}/runtime/sessions/${session.id}/records`,
      {
        method: 'POST',
        body: JSON.stringify(makeRecordInit(session.id, overrides)),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(appendCalled).toBe(false);
  });

  test('uses the same whole-table payload validator replacement as the injected store', async () => {
    const payloadValidators: Record<string, RuntimePayloadValidator> = {
      chat: (payload) =>
        typeof payload === 'object' && payload !== null && 'custom' in payload
          ? { valid: true }
          : { valid: false, errors: [{ path: '/payload', message: 'expected custom payload' }] },
    };
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators,
    });
    await store.createSession(makeSession());
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'anon:device-1' }),
      payloadValidators,
    });
    const response = await handlerFetch(handler, async () => 'Bearer anon:device-1')(
      `${BASE_URL}/runtime/sessions/sess-1/records`,
      {
        method: 'POST',
        body: JSON.stringify(makeRecordInit('sess-1', { payload: { custom: true } })),
      },
    );

    expect(response.status).toBe(201);
  });
});

describe('reference HTTP handler error disclosure', () => {
  test('returns a generic INTERNAL_ERROR and logs the underlying store error server-side', async () => {
    const secret = 'postgres password=do-not-reflect';
    const underlying = new Error(secret);
    const store = {
      getSession: async () => {
        throw underlying;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await handlerFetch(
        handler,
        async () => 'Bearer learner-a',
      )(`${BASE_URL}/runtime/sessions/session-a`);
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: '@openmaic/storage: internal server error',
        },
      });
      expect(consoleError).toHaveBeenCalledWith(
        '@openmaic/storage: Runtime HTTP handler internal error',
        underlying,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('reference HTTP handler future-version semantics', () => {
  const futureSession = {
    ...makeSession({ id: 'future-session', learnerKey: 'learner-a', stageId: 'stage-1' }),
    runtimeDslVersion: '999.0.0',
  };

  test('passes future-stamped session and record reads through unchanged', async () => {
    const record = { ...makeRecordInit(futureSession.id), seq: 0 };
    const store = {
      getSession: async () => futureSession,
      listRecords: async () => [record],
      listSessions: async () => [futureSession],
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
    });
    const request = handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`);

    const sessionResponse = await request(`${BASE_URL}/runtime/sessions/${futureSession.id}`);
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toEqual(futureSession);

    const recordsResponse = await request(
      `${BASE_URL}/runtime/sessions/${futureSession.id}/records`,
    );
    expect(recordsResponse.status).toBe(200);
    await expect(recordsResponse.json()).resolves.toEqual([record]);

    const sessionsResponse = await request(
      `${BASE_URL}/runtime/stages/${futureSession.stageId}/learners/${futureSession.learnerKey}/sessions`,
    );
    expect(sessionsResponse.status).toBe(200);
    await expect(sessionsResponse.json()).resolves.toEqual([futureSession]);
  });

  test.each([
    ['session', `/runtime/sessions/${futureSession.id}`, 'deleteSession'],
    [
      'learner partition',
      `/runtime/stages/${futureSession.stageId}/learners/${futureSession.learnerKey}`,
      'deleteLearnerRuntime',
    ],
    ['stage', `/runtime/stages/${futureSession.stageId}`, 'deleteStageRuntime'],
    ['all runtime', '/runtime', 'deleteAllRuntime'],
  ] as const)('keeps the %s delete version-independent', async (_label, path, methodName) => {
    const calls: string[] = [];
    const store = {
      getSession: async () => futureSession,
      deleteSession: async () => calls.push('deleteSession'),
      deleteLearnerRuntime: async () => calls.push('deleteLearnerRuntime'),
      deleteStageRuntime: async () => calls.push('deleteStageRuntime'),
      deleteAllRuntime: async () => calls.push('deleteAllRuntime'),
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
      authorizeAdmin: async () => true,
    });
    const response = await handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`)(
      `${BASE_URL}${path}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(204);
    expect(calls).toEqual([methodName]);
  });

  test.each([
    {
      operation: 'appendRecord',
      invoke: (request: typeof globalThis.fetch) =>
        request(`${BASE_URL}/runtime/sessions/${futureSession.id}/records`, {
          method: 'POST',
          body: JSON.stringify(makeRecordInit(futureSession.id)),
        }),
    },
    {
      operation: 'setSessionStatus',
      invoke: (request: typeof globalThis.fetch) =>
        request(`${BASE_URL}/runtime/sessions/${futureSession.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }),
        }),
    },
  ])('$operation keeps the 409 FUTURE_VERSION write guard', async ({ operation, invoke }) => {
    const called: string[] = [];
    const store = {
      getSession: async () => futureSession,
      appendRecord: async () => called.push('appendRecord'),
      setSessionStatus: async () => {
        called.push('setSessionStatus');
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
    });
    const response = await invoke(
      handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FUTURE_VERSION' },
    });
    expect(called).not.toContain(operation);
  });

  test('mergeLearner returns 409 only after a structured future-session re-fetch', async () => {
    const storeError = new Error(
      `@openmaic/storage: session ${JSON.stringify(futureSession.id)} was written at runtime DSL ` +
        `version ${JSON.stringify(futureSession.runtimeDslVersion)}, newer than this client's ` +
        RUNTIME_DSL_VERSION,
    );
    const store = {
      getSession: async () => futureSession,
      mergeLearner: async () => {
        throw storeError;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: futureSession.learnerKey }),
      authorizeMerge: async () => true,
    });
    const response = await handlerFetch(handler, async () => `Bearer ${futureSession.learnerKey}`)(
      `${BASE_URL}/runtime/learners/merge`,
      {
        method: 'POST',
        body: JSON.stringify({
          fromLearnerKey: futureSession.learnerKey,
          toLearnerKey: 'learner-b',
        }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FUTURE_VERSION' },
    });
  });
});

describe('reference HTTP handler concurrent session-write classification', () => {
  const operations = [
    {
      name: 'appendRecord',
      invoke: (request: typeof globalThis.fetch, sessionId: string) =>
        request(`${BASE_URL}/runtime/sessions/${sessionId}/records`, {
          method: 'POST',
          body: JSON.stringify(makeRecordInit(sessionId)),
        }),
    },
    {
      name: 'setSessionStatus',
      invoke: (request: typeof globalThis.fetch, sessionId: string) =>
        request(`${BASE_URL}/runtime/sessions/${sessionId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }),
        }),
    },
  ];

  test.each(operations)(
    '$name returns 404 when the session is deleted before the write',
    async ({ name, invoke }) => {
      const session = {
        ...makeSession({ id: `race-${name}` }),
        runtimeDslVersion: RUNTIME_DSL_VERSION,
      };
      const underlying = new Error('session does not exist');
      let reads = 0;
      const store = {
        getSession: async () => (++reads === 1 ? session : undefined),
        appendRecord: async () => {
          throw underlying;
        },
        setSessionStatus: async () => {
          throw underlying;
        },
      } as unknown as RuntimeStore;
      const handler = createRuntimeHttpHandler(store, {
        authenticate: async () => ({ learnerKey: session.learnerKey }),
      });
      const response = await invoke(
        handlerFetch(handler, async () => `Bearer ${session.learnerKey}`),
        session.id,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'SESSION_NOT_FOUND' },
      });
      expect(reads).toBe(2);
    },
  );

  test.each(operations)(
    '$name returns 400 with the current status when the session completes before the write',
    async ({ name, invoke }) => {
      const session = {
        ...makeSession({ id: `race-${name}` }),
        runtimeDslVersion: RUNTIME_DSL_VERSION,
      };
      const completed = { ...session, status: 'completed' as const };
      const underlying = new Error('session not active');
      let reads = 0;
      const store = {
        getSession: async () => (++reads === 1 ? session : completed),
        appendRecord: async () => {
          throw underlying;
        },
        setSessionStatus: async () => {
          throw underlying;
        },
      } as unknown as RuntimeStore;
      const handler = createRuntimeHttpHandler(store, {
        authenticate: async () => ({ learnerKey: session.learnerKey }),
      });
      const response = await invoke(
        handlerFetch(handler, async () => `Bearer ${session.learnerKey}`),
        session.id,
      );
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.message).toContain("current status is 'completed'");
      expect(reads).toBe(2);
    },
  );

  test.each(operations)(
    '$name preserves 500 for an unclassified store failure',
    async ({ name, invoke }) => {
      const session = {
        ...makeSession({ id: `race-${name}` }),
        runtimeDslVersion: RUNTIME_DSL_VERSION,
      };
      const underlying = new Error('unexpected write failure');
      let reads = 0;
      const store = {
        getSession: async () => {
          reads += 1;
          return session;
        },
        appendRecord: async () => {
          throw underlying;
        },
        setSessionStatus: async () => {
          throw underlying;
        },
      } as unknown as RuntimeStore;
      const handler = createRuntimeHttpHandler(store, {
        authenticate: async () => ({ learnerKey: session.learnerKey }),
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const response = await invoke(
          handlerFetch(handler, async () => `Bearer ${session.learnerKey}`),
          session.id,
        );

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'INTERNAL_ERROR' },
        });
        expect(reads).toBe(2);
        expect(consoleError).toHaveBeenCalledWith(
          '@openmaic/storage: Runtime HTTP handler internal error',
          underlying,
        );
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});

describe('reference HTTP handler cross-learner rejection matrix', () => {
  function makeCrossLearnerHarness() {
    const store = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
      authorizeMerge: async (principal, fromKey) => principal.learnerKey === fromKey,
    });
    const request = handlerFetch(handler, async () => 'Bearer learner-a');
    return { store, request };
  }

  const cases: {
    route: string;
    expectedStatus: 403 | 404;
    expectedCode: 'FORBIDDEN_LEARNER' | 'SESSION_NOT_FOUND';
    invoke(request: typeof globalThis.fetch): Promise<Response>;
  }[] = [
    {
      route: 'get session',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) => request(`${BASE_URL}/runtime/sessions/session-b`),
    },
    {
      route: 'list records',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) => request(`${BASE_URL}/runtime/sessions/session-b/records`),
    },
    {
      route: 'append record',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/sessions/session-b/records`, {
          method: 'POST',
          body: JSON.stringify(makeRecordInit('session-b')),
        }),
    },
    {
      route: 'set session status',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/sessions/session-b/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed', updatedAt: '2026-01-01T00:02:00.000Z' }),
        }),
    },
    {
      route: 'delete session',
      expectedStatus: 404,
      expectedCode: 'SESSION_NOT_FOUND',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/sessions/session-b`, {
          method: 'DELETE',
        }),
    },
    {
      route: 'list stage learner sessions',
      expectedStatus: 403,
      expectedCode: 'FORBIDDEN_LEARNER',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/stages/stage-1/learners/learner-b/sessions`),
    },
    {
      route: 'delete stage learner runtime',
      expectedStatus: 403,
      expectedCode: 'FORBIDDEN_LEARNER',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/stages/stage-1/learners/learner-b`, {
          method: 'DELETE',
        }),
    },
    {
      route: 'merge learner',
      expectedStatus: 403,
      expectedCode: 'FORBIDDEN_LEARNER',
      invoke: (request) =>
        request(`${BASE_URL}/runtime/learners/merge`, {
          method: 'POST',
          body: JSON.stringify({ fromLearnerKey: 'learner-b', toLearnerKey: 'learner-a' }),
        }),
    },
  ];

  test.each(cases)('$route returns $expectedStatus $expectedCode', async (testCase) => {
    const { store, request } = makeCrossLearnerHarness();
    await store.createSession(
      makeSession({ id: 'session-b', learnerKey: 'learner-b', stageId: 'stage-1' }),
    );
    await store.appendRecord(makeRecordInit('session-b'));

    const response = await testCase.invoke(request);

    expect(response.status).toBe(testCase.expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: testCase.expectedCode },
    });
  });
});

describe('reference HTTP handler ownership ordering', () => {
  test('returns concealed 404 before classifying another learner future-version session', async () => {
    const futureSession = {
      ...makeSession({ id: 'future-b', learnerKey: 'learner-b' }),
      runtimeDslVersion: '999.0.0',
    };
    const store = { getSession: async () => futureSession } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: 'learner-a' }),
    });
    const response = await handlerFetch(
      handler,
      async () => 'Bearer learner-a',
    )(`${BASE_URL}/runtime/sessions/future-b`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
  });

  test('re-checks ownership immediately before delete and rejects a concurrent merge', async () => {
    const owned = { ...makeSession({ id: 'moving' }), runtimeDslVersion: RUNTIME_DSL_VERSION };
    const moved = { ...owned, learnerKey: 'learner-b' };
    let reads = 0;
    let deleted = false;
    const store = {
      getSession: async () => (++reads === 1 ? owned : moved),
      deleteSession: async () => {
        deleted = true;
      },
    } as unknown as RuntimeStore;
    const handler = createRuntimeHttpHandler(store, {
      authenticate: async () => ({ learnerKey: owned.learnerKey }),
    });
    const response = await handlerFetch(handler, async () => `Bearer ${owned.learnerKey}`)(
      `${BASE_URL}/runtime/sessions/moving`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(404);
    expect(reads).toBe(2);
    expect(deleted).toBe(false);
  });
});
