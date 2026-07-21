import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import type { RuntimePayload, RuntimeRecord, RuntimeRecordInit } from '@openmaic/dsl';
import { HttpRuntimeStore, HttpRuntimeStoreError } from '../src/runtime/http.js';
import type { RuntimeSessionInit } from '../src/runtime/types.js';
import { runRuntimeStoreContract } from './runtime-contract.js';
import {
  startHttpConformanceServer,
  type HttpConformanceServer,
} from './http-conformance-server.js';

const T0 = '2026-01-01T00:00:00.000Z';
let server: HttpConformanceServer;
let namespace = 0;

function makeSession(id: string, overrides: Partial<RuntimeSessionInit> = {}): RuntimeSessionInit {
  return {
    id,
    kind: 'playback',
    stageId: 'stage-1',
    learnerKey: 'learner-1',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeRecord(sessionId: string, payload: unknown = { value: 'ok' }): RuntimeRecordInit {
  return {
    id: `record-${namespace++}`,
    sessionId,
    createdAt: T0,
    payload: payload as RuntimePayload,
  };
}

function fakeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeAll(async () => {
  server = await startHttpConformanceServer({ listen: false });
});

afterAll(async () => {
  await server.close();
});

runRuntimeStoreContract('HTTP', () => {
  const storeId = `contract-${namespace++}`;
  return new HttpRuntimeStore({
    baseUrl: server.baseUrl,
    fetch: server.fetch,
    headers: () => ({ 'x-runtime-store-id': storeId }),
  });
});

describe('HttpRuntimeStore error mapping', () => {
  test.each([
    ['empty', undefined],
    ['unparseable', '{'],
    ['null', 'null'],
  ])('maps a %s JSON request body to a 400 validation failure', async (_name, body) => {
    const response = await server.fetch(`${server.baseUrl}/runtime/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  test('reconstitutes a 400 validation failure as an Error with its code and message', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': `errors-${namespace++}` }),
    });

    const failure = store.createSession({
      id: 'invalid',
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: '',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    });

    await expect(failure).rejects.toMatchObject({
      name: 'HttpRuntimeStoreError',
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(failure).rejects.toThrow(/learnerKey/);
  });

  test('reconstitutes a 404 missing-session response with browser-store semantics', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': `errors-${namespace++}` }),
    });

    const failure = store.setSessionStatus('ghost', 'completed', T0);
    await expect(failure).rejects.toMatchObject({
      name: 'HttpRuntimeStoreError',
      status: 404,
      code: 'SESSION_NOT_FOUND',
    });
    await expect(failure).rejects.toThrow(/no session/i);
  });

  test('reconstitutes a 409 future-version response with fail-loud semantics', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'FUTURE_VERSION',
            message:
              '@openmaic/storage: session "future" was written at runtime DSL version "99.0.0", newer than this client\'s 1.0.0',
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    const store = new HttpRuntimeStore({ baseUrl: 'https://runtime.invalid', fetch });

    const failure = store.setSessionStatus('future', 'completed', T0);
    await expect(failure).rejects.toBeInstanceOf(HttpRuntimeStoreError);
    await expect(failure).rejects.toMatchObject({ status: 409, code: 'FUTURE_VERSION' });
    await expect(failure).rejects.toThrow(/newer than this client's/);
  });

  test('maps concurrent duplicate session creation to one success and one 409', async () => {
    const storeId = `duplicate-race-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });

    const results = await Promise.allSettled([
      store.createSession(makeSession('duplicate-race')),
      store.createSession(makeSession('duplicate-race')),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({
        status: 409,
        code: 'SESSION_ALREADY_EXISTS',
      }),
    });
  });

  test('maps invalid kind-specific append payloads to 400 validation failures', async () => {
    const storeId = `payload-gate-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(makeSession('chat-session', { kind: 'chat' }));
    await store.createSession(makeSession('quiz-session', { kind: 'quizAttempt' }));

    await expect(
      store.appendRecord(makeRecord('chat-session', { role: 'tool', content: 'invalid' })),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(
      store.appendRecord(makeRecord('quiz-session', { phase: 'graded', answers: {} })),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  test('maps empty merge learner keys to 400 validation failures', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': `merge-validation-${namespace++}` }),
    });

    await expect(store.mergeLearner('', 'learner-2')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(store.mergeLearner('learner-1', '')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  test.each([
    ['createSession id', '/runtime/sessions', makeSession('.')],
    ['createSession stageId', '/runtime/sessions', makeSession('dot-stage', { stageId: '..' })],
    [
      'createSession learnerKey',
      '/runtime/sessions',
      makeSession('dot-learner', { learnerKey: '.' }),
    ],
    [
      'mergeLearner target',
      '/runtime/learners/merge',
      { fromLearnerKey: 'learner-1', toLearnerKey: '..' },
    ],
  ])('maps a dot-only %s body field to a 400 validation failure', async (_name, path, body) => {
    const response = await server.fetch(`${server.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.stringContaining('URL path segment must not be'),
      },
    });
  });

  test.each([
    ['NUL', 'from\u0000learner', 'to-learner'],
    ['unpaired surrogate', 'from-learner', '\uD800'],
  ])(
    'maps a merge learner key containing %s to a 400 validation failure',
    async (_name, fromLearnerKey, toLearnerKey) => {
      const response = await server.fetch(`${server.baseUrl}/runtime/learners/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromLearnerKey, toLearnerKey }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    },
  );
});

describe('HttpRuntimeStore HTTP hardening', () => {
  test('rejects payload values that cannot be represented faithfully by JSON', async () => {
    const storeId = `json-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(makeSession('json-session'));

    const sparse = [, 'present'];
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const symbolKeyed = { [Symbol('k')]: 1 };
    const nonEnumerable = Object.defineProperty({}, 'k', { value: 1, enumerable: false });
    const arrayWithExtraProperty = Object.assign([1, 2], { meta: 'x' });
    const enumerableAccessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'x',
    });
    const ArraySubclass = class extends Array {};
    const arraySubclass = Object.assign(new ArraySubclass(), { 0: 'x', length: 1 });
    const fakeDense = Object.setPrototypeOf([, 1], { 0: 'x' });
    const rejected: [string, unknown][] = [
      ['Map', new Map([['key', 'value']])],
      ['Set', new Set(['value'])],
      ['Date', new Date(T0)],
      ['NaN', Number.NaN],
      ['negative zero', -0],
      ['nested undefined', { nested: undefined }],
      ['bigint', (globalThis as unknown as { BigInt(value: number): unknown }).BigInt(1)],
      ['NUL', `before\u0000after`],
      ['NUL object key', { 'bad key\u0000': 1 }],
      ['unpaired surrogate string', '\uD800'],
      ['unpaired surrogate object key', { ['\uD800']: 1 }],
      ['symbol key', symbolKeyed],
      ['non-enumerable property', nonEnumerable],
      ['array extra own property', arrayWithExtraProperty],
      ['enumerable accessor property', enumerableAccessor],
      ['Array subclass', arraySubclass],
      ['prototype-provided array index', fakeDense],
      ['circular reference', circular],
    ];

    await expect(store.appendRecord(makeRecord('json-session', sparse))).rejects.toThrow(
      /sparse array hole/,
    );

    for (const [name, payload] of rejected) {
      await expect(store.appendRecord(makeRecord('json-session', payload)), name).rejects.toThrow(
        /not a plain JSON value/,
      );
    }
  });

  test('accepts JSON strings containing line and paragraph separators', async () => {
    const storeId = `json-separators-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(makeSession('json-separators'));

    await expect(
      store.appendRecord(makeRecord('json-separators', `before\u2028after`)),
    ).resolves.toMatchObject({ payload: `before\u2028after` });
    await expect(
      store.appendRecord(makeRecord('json-separators', `before\u2029after`)),
    ).resolves.toMatchObject({ payload: `before\u2029after` });
  });

  test('accepts a valid surrogate pair string', async () => {
    const storeId = `json-surrogate-pair-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(makeSession('json-surrogate-pair'));

    await expect(store.appendRecord(makeRecord('json-surrogate-pair', '𐀀'))).resolves.toMatchObject(
      { payload: '𐀀' },
    );
  });

  test('rejects non-JSON properties and NUL ids across full write envelopes', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });
    const sessionWithDate = Object.assign(makeSession('session-date'), { extra: new Date(T0) });
    const recordWithDate = Object.assign(makeRecord('session'), { extra: new Date(T0) });

    await expect(store.createSession(sessionWithDate)).rejects.toThrow(/not a plain JSON value/);
    await expect(store.appendRecord(recordWithDate)).rejects.toThrow(/not a plain JSON value/);
    await expect(store.createSession(makeSession('bad\u0000session'))).rejects.toThrow(
      /not a plain JSON value/,
    );
    await expect(
      store.appendRecord({ ...makeRecord('session'), id: 'bad\u0000record' }),
    ).rejects.toThrow(/not a plain JSON value/);
  });

  test('rejects dot-only path segments before URL construction', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

    await expect(store.getSession('.')).rejects.toThrow(/must not be ['"]\.['"]/);
    await expect(store.getSession('..')).rejects.toThrow(/must not be ['"]\.\.['"]/);
  });

  test.each([
    ['session id', (store: HttpRuntimeStore) => store.createSession(makeSession('.'))],
    [
      'stage id',
      (store: HttpRuntimeStore) => store.createSession(makeSession('dot-stage', { stageId: '..' })),
    ],
    [
      'session learner key',
      (store: HttpRuntimeStore) =>
        store.createSession(makeSession('dot-learner', { learnerKey: '.' })),
    ],
    ['merge target learner key', (store: HttpRuntimeStore) => store.mergeLearner('from', '..')],
  ])('rejects a dot-only %s body field before sending a request', async (_name, operation) => {
    const store = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

    await expect(operation(store)).rejects.toThrow(/URL path segment must not be/);
  });

  test.each([
    ['from NUL', 'from\u0000learner', 'to-learner'],
    ['to NUL', 'from-learner', 'to\u0000learner'],
    ['from unpaired surrogate', '\uD800', 'to-learner'],
    ['to unpaired surrogate', 'from-learner', '\uD800'],
  ])(
    'rejects a merge learner key containing %s before sending a request',
    async (_name, fromLearnerKey, toLearnerKey) => {
      const store = new HttpRuntimeStore({
        baseUrl: 'https://runtime.invalid',
        fetch: async () => {
          throw new Error('fetch must not be called');
        },
      });

      await expect(store.mergeLearner(fromLearnerKey, toLearnerKey)).rejects.toThrow(
        /not a plain JSON value/,
      );
    },
  );

  test('treats a top-level undefined record anchor identically to an omitted anchor', async () => {
    const storeId = `undefined-anchor-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(makeSession('undefined-anchor'));

    const explicit = await store.appendRecord({
      ...makeRecord('undefined-anchor', { source: 'explicit' }),
      sceneId: undefined,
    });
    const omitted = await store.appendRecord(makeRecord('undefined-anchor', { source: 'omitted' }));

    expect('sceneId' in explicit).toBe(false);
    expect('sceneId' in omitted).toBe(false);
    await expect(store.listRecords('undefined-anchor')).resolves.toEqual([explicit, omitted]);
  });

  test('rejects an unknown top-level record field that is explicitly undefined', async () => {
    const storeId = `undefined-ext-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(makeSession('undefined-ext'));

    await expect(
      store.appendRecord({
        ...makeRecord('undefined-ext', { source: 'extension' }),
        ext: undefined,
      } as never),
    ).rejects.toThrow(/undefined member/);
  });

  test('maps non-array list response containers to malformed-response errors', async () => {
    const sessionsStore = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse({ sessions: [] }, 206),
    });
    const recordsStore = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse({ records: [] }, 202),
    });

    await expect(sessionsStore.listSessions('stage', 'learner')).rejects.toMatchObject({
      status: 206,
      code: 'MALFORMED_RESPONSE',
    });
    await expect(recordsStore.listRecords('session')).rejects.toMatchObject({
      status: 202,
      code: 'MALFORMED_RESPONSE',
    });
  });

  test.each([
    ['non-numeric', '1'],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['negative', -3],
    ['fractional', 2.5],
  ])('maps a %s merge moved field to a malformed-response error', async (_name, moved) => {
    const store = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse({ moved }, 201),
    });

    await expect(store.mergeLearner('from', 'to')).rejects.toMatchObject({
      status: 201,
      code: 'MALFORMED_RESPONSE',
    });
  });

  test('validates append responses and every listed record, including seq', async () => {
    const baseRecord = {
      id: 'record',
      sessionId: 'session',
      createdAt: T0,
      payload: null,
    };
    const invalidRecords: unknown[] = [
      { ...baseRecord, seq: -1 },
      { ...baseRecord, seq: Number.NaN },
      { ...baseRecord, seq: 0.5 },
      baseRecord,
    ];

    for (const invalid of invalidRecords) {
      const store = new HttpRuntimeStore({
        baseUrl: 'https://runtime.invalid',
        fetch: async () => fakeJsonResponse(invalid, 201),
      });
      await expect(store.appendRecord(makeRecord('session', null))).rejects.toThrow(/seq/);
    }

    const listStore = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse([{ ...baseRecord, seq: 1 }, invalidRecords[0]]),
    });
    await expect(listStore.listRecords('session')).rejects.toThrow(/seq/);
  });

  test('reports null session and record response bodies as readable storage errors', async () => {
    const nullStore = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse(null),
    });
    const nullListStore = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse([null]),
    });
    const operations: [string, () => Promise<unknown>][] = [
      ['session', () => nullStore.getSession('session')],
      ['session', () => nullStore.createSession(makeSession('session'))],
      ['record', () => nullStore.appendRecord(makeRecord('session'))],
      ['record', () => nullListStore.listRecords('session')],
    ];

    for (const [kind, operation] of operations) {
      const error = await operation().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message: expect.stringContaining(`invalid stored runtime ${kind}`),
      });
    }
  });

  test('sorts validated listRecords responses by seq ascending', async () => {
    const records: RuntimeRecord[] = [
      { id: 'two', sessionId: 'session', seq: 2, createdAt: T0, payload: null },
      { id: 'zero', sessionId: 'session', seq: 0, createdAt: T0, payload: null },
      { id: 'one', sessionId: 'session', seq: 1, createdAt: T0, payload: null },
    ];
    const store = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch: async () => fakeJsonResponse(records),
    });

    await expect(store.listRecords('session')).resolves.toMatchObject([
      { seq: 0 },
      { seq: 1 },
      { seq: 2 },
    ]);
  });

  test('normalizes a Headers instance without consulting the global Headers constructor', async () => {
    const HeadersConstructor = globalThis.Headers;
    const suppliedHeaders = new HeadersConstructor([['X-Test-Header', 'present']]);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Headers');
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      expect(init?.headers).toEqual({ 'x-test-header': 'present' });
      return fakeJsonResponse(undefined, 204);
    };
    const store = new HttpRuntimeStore({
      baseUrl: 'https://runtime.invalid',
      fetch,
      headers: () => suppliedHeaders,
    });

    Reflect.deleteProperty(globalThis, 'Headers');
    try {
      await store.deleteStageRuntime('stage');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'Headers', descriptor);
    }
  });

  test('caller-controlled error substrings do not hijack structured status classification', async () => {
    const storeId = `malicious-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    const maliciousId = `no session already exists newer than this client's`;

    const failure = store.createSession(makeSession(maliciousId, { learnerKey: '' }));
    await expect(failure).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  test('preserves empty segments and keeps empty-key deletes idempotent and route-local', async () => {
    const storeId = `empty-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    await store.createSession(
      makeSession('route-sentinel', { stageId: 'learners', learnerKey: 'sentinel' }),
    );

    await expect(store.getSession('')).resolves.toBeUndefined();
    await expect(store.deleteSession('')).resolves.toBeUndefined();
    await expect(store.deleteLearnerRuntime('', '')).resolves.toBeUndefined();
    await expect(store.getSession('route-sentinel')).resolves.toMatchObject({
      id: 'route-sentinel',
    });
  });

  test('ignores client-submitted runtimeDslVersion and seq in favor of store values', async () => {
    const storeId = `assigned-${namespace++}`;
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': storeId }),
    });
    const session = await store.createSession({
      ...makeSession('assigned-session'),
      runtimeDslVersion: '99.0.0',
    } as RuntimeSessionInit);
    const record = await store.appendRecord({
      ...makeRecord('assigned-session'),
      seq: 99,
    } as RuntimeRecordInit);

    expect(session.runtimeDslVersion).toBe(RUNTIME_DSL_VERSION);
    expect(record.seq).toBe(0);
  });
});

test('real fetch reaches the listening conformance server over loopback', async ({ skip }) => {
  let networkServer: HttpConformanceServer;
  try {
    networkServer = await startHttpConformanceServer();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      skip('sandbox does not permit binding a 127.0.0.1 listener');
    }
    throw error;
  }
  try {
    const store = new HttpRuntimeStore({
      baseUrl: networkServer.baseUrl,
      headers: () => ({ 'x-runtime-store-id': 'real-network' }),
    });
    await store.createSession(makeSession('network-session'));
    await store.appendRecord(makeRecord('network-session'));
    await expect(store.listRecords('network-session')).resolves.toMatchObject([
      { sessionId: 'network-session', seq: 0 },
    ]);
  } finally {
    await networkServer.close();
  }
});
