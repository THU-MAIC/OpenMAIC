import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ContentHash } from '../src/asset/blob.js';
import { HttpAssetStore } from '../src/asset/http.js';
import { __setAssetIdFactoryForTesting, type AssetId } from '../src/asset/id.js';
import { PgAssetByteStore } from '../src/asset/pg-bytes.js';
import type { Queryable } from '../src/asset/pg.js';
import { createAssetHttpHandler } from '../src/server/asset.js';
import type { AssetPrincipal, AssetStore } from '../src/asset/types.js';
import {
  FOREIGN_IDS,
  commonDigestEncodings,
  expectNoDigestSubstring,
  runAssetStoreContract,
} from './asset-contract.js';
import {
  startAssetConformanceServer,
  type AssetConformanceServer,
  type AssetConformanceServerOptions,
} from './asset-conformance-server.js';
import { blobForObjectUrl, objectUrlCount } from './setup.js';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

let server: AssetConformanceServer;
let namespace = 0;
const stores: HttpAssetStore[] = [];

const blob = (value: string, type = 'text/plain'): Blob => new Blob([value], { type });

function makeStore(principal = 'principal-a', storeId = `asset-${namespace++}`): HttpAssetStore {
  const store = new HttpAssetStore({
    baseUrl: server.baseUrl,
    fetch: server.fetch,
    headers: () => ({
      'x-asset-store-id': storeId,
      'x-asset-principal': principal,
    }),
  });
  stores.push(store);
  return store;
}

function rawRequest(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Promise<RawResponse> {
  const url = new URL(server.baseUrl);
  const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body;
  const headers = {
    ...(options.headers ?? {}),
    ...(body === undefined ? {} : { 'content-length': String(body.byteLength) }),
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: options.method,
        path: options.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

interface Part {
  name: string;
  value: string | Uint8Array;
  contentType?: string;
  filename?: string | null;
  extraHeaders?: Record<string, string>;
}

function multipart(parts: readonly Part[], boundary = 'asset-test-boundary'): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename =
      part.filename === undefined
        ? part.name === 'meta'
          ? 'metadata.json'
          : part.name === 'bytes'
            ? 'asset'
            : undefined
        : part.filename;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename === null || filename === undefined ? '' : `; filename="${filename}"`}\r\n`,
      ),
    );
    if (part.contentType !== undefined) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    for (const [name, value] of Object.entries(part.extraHeaders ?? {})) {
      chunks.push(Buffer.from(`${name}: ${value}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'), Buffer.from(part.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function multipartHeaders(
  storeId: string,
  principal = 'principal-a',
  boundary = 'asset-test-boundary',
): Record<string, string> {
  return {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-asset-store-id': storeId,
    'x-asset-principal': principal,
  };
}

function comparable(response: RawResponse): unknown {
  return {
    status: response.status,
    headers: Object.fromEntries(
      Object.entries(response.headers).filter(([name]) => name !== 'connection'),
    ),
    body: response.body.toString('base64'),
  };
}

const ASSET_ROUTES = [
  ['POST', '/assets'],
  ['GET', '/assets/id/content'],
  ['HEAD', '/assets/id/content'],
  ['PUT', '/assets/id/content'],
  ['DELETE', '/assets/id'],
] as const;

function unreachableRegistry(): { store: AssetStore; methods: Array<ReturnType<typeof vi.fn>> } {
  const fail = () => {
    throw new Error('asset registry was reached');
  };
  const store = {
    put: vi.fn(fail),
    identify: vi.fn(fail),
    resolve: vi.fn(fail),
    remove: vi.fn(fail),
    replace: vi.fn(fail),
  } satisfies AssetStore;
  return { store, methods: Object.values(store) };
}

async function expectAuthRejection(
  options: Pick<AssetConformanceServerOptions, 'authenticate' | 'authorizeAssets'>,
  expectedStatus: number,
  expectedCode: string,
): Promise<void> {
  const registry = unreachableRegistry();
  const isolated = await startAssetConformanceServer({
    ...options,
    store: () => registry.store,
  });
  try {
    for (const [method, path] of ASSET_ROUTES) {
      const response = await isolated.fetch(`${isolated.baseUrl}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(expectedStatus);
      if (method === 'HEAD') {
        expect(response.headers.get('x-error-code'), `${method} ${path}`).toBe(expectedCode);
      } else {
        await expect(response.json(), `${method} ${path}`).resolves.toMatchObject({
          error: { code: expectedCode },
        });
      }
      for (const registryMethod of registry.methods) {
        expect(registryMethod, `${method} ${path}`).not.toHaveBeenCalled();
      }
    }
  } finally {
    await isolated.close();
  }
}

beforeAll(async () => {
  server = await startAssetConformanceServer();
});

afterEach(async () => {
  __setAssetIdFactoryForTesting(null);
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

afterAll(async () => {
  await server.close();
});

runAssetStoreContract(
  'HttpAssetStore over PgAssetStore (PGlite)',
  {
    makeStore: () => makeStore(),
    withAllocator: async (allocator, run) => {
      __setAssetIdFactoryForTesting(allocator);
      try {
        return await run();
      } finally {
        __setAssetIdFactoryForTesting(null);
      }
    },
  },
  async (url) => {
    const stored = blobForObjectUrl(url);
    if (!stored) throw new Error('object URL is not registered');
    return new Uint8Array(await stored.arrayBuffer());
  },
);

describe('asset HTTP handler contract', () => {
  test('exposes revisions on successful cross-origin writes', async () => {
    const storeId = `write-revision-${namespace++}`;
    const allocation = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: multipartHeaders(storeId),
      body: multipart([
        { name: 'meta', value: '{}', contentType: 'application/json' },
        { name: 'bytes', value: 'original', contentType: 'text/plain' },
      ]),
    });
    expect(allocation.status).toBe(201);
    expect(allocation.headers['x-asset-revision']).toBe('1');
    expect(allocation.headers['access-control-expose-headers']).toBe('X-Asset-Revision');

    const id = (JSON.parse(allocation.body.toString()) as { id: string }).id;
    const replacement = await rawRequest({
      method: 'PUT',
      path: `/assets/${encodeURIComponent(id)}/content`,
      headers: multipartHeaders(storeId),
      body: multipart([{ name: 'bytes', value: 'replacement', contentType: 'text/plain' }]),
    });
    expect(replacement.status).toBe(204);
    expect(replacement.headers['x-asset-revision']).toBe('2');
    expect(replacement.headers['access-control-expose-headers']).toBe('X-Asset-Revision');
  });

  test('rejects unauthenticated requests before reaching the registry', async () => {
    await expectAuthRejection({ authenticate: async () => undefined }, 401, 'UNAUTHENTICATED');
  });

  test('maps a malformed authenticated principal to an internal error before the registry', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expectAuthRejection(
        { authenticate: async () => null as unknown as AssetPrincipal },
        500,
        'INTERNAL_ERROR',
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  test('forbids a principal without an asset key on every route before the registry', async () => {
    await expectAuthRejection(
      { authenticate: async () => ({}) as AssetPrincipal },
      403,
      'FORBIDDEN_ASSETS',
    );
  });

  test('applies authorizeAssets denial uniformly before the registry', async () => {
    await expectAuthRejection(
      {
        authenticate: async () => ({ key: 'principal' }),
        authorizeAssets: async () => false,
      },
      403,
      'FORBIDDEN_ASSETS',
    );
  });

  test('HEAD and GET have identical outcomes and headers for owned and missing ids', async () => {
    const storeId = `head-parity-${namespace++}`;
    const owner = makeStore('owner', storeId);
    const other = makeStore('other', storeId);
    const ownId = await owner.put(blob('owned bytes', 'image/png'));
    const foreignId = await other.put(blob('foreign bytes', 'image/png'));
    const deletedId = await owner.put(blob('deleted bytes', 'image/png'));
    await owner.remove(deletedId);

    const cases = [
      ['own', ownId],
      ['foreign', foreignId],
      ['never-allocated', 'ast_never_allocated'],
      ['already-deleted', deletedId],
    ] as const;
    const requestHeaders = {
      'x-asset-store-id': storeId,
      'x-asset-principal': 'owner',
    };

    for (const [kind, id] of cases) {
      const path = `/assets/${encodeURIComponent(id)}/content`;
      const [get, head] = await Promise.all([
        rawRequest({ method: 'GET', path, headers: requestHeaders }),
        rawRequest({ method: 'HEAD', path, headers: requestHeaders }),
      ]);
      const getHeaders = get.headers;
      const headHeaders = head.headers;

      expect(head.status, kind).toBe(get.status);
      expect(headHeaders, kind).toEqual(getHeaders);
      expect(head.body, kind).toHaveLength(0);
      if (kind === 'own') {
        expect(get.status).toBe(200);
        expect(get.body).toEqual(Buffer.from('owned bytes'));
        expect(getHeaders).toEqual({
          'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
          'cache-control': 'private, no-store',
          connection: 'keep-alive',
          'content-length': '11',
          'content-type': 'image/png',
          'keep-alive': 'timeout=5',
          vary: 'Cookie, Authorization',
          'x-asset-revision': '1',
          'x-content-type-options': 'nosniff',
        });
      } else {
        expect(get.status).toBe(404);
        expect(JSON.parse(get.body.toString())).toEqual({
          error: {
            code: 'ASSET_NOT_FOUND',
            message: '@openmaic/storage: no asset is stored under that id',
          },
        });
        expect(getHeaders).toEqual({
          'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
          connection: 'keep-alive',
          'content-length': '100',
          'content-type': 'application/json',
          'keep-alive': 'timeout=5',
          'x-error-code': 'ASSET_NOT_FOUND',
        });
      }
    }
  });

  test('HEAD reads registry identity without reaching the byte layer', async () => {
    class FailingReadByteStore extends PgAssetByteStore {
      override async read(_hash: ContentHash): Promise<Uint8Array | null> {
        throw new Error('HEAD reached the byte layer');
      }

      override async readWith(
        _queryable: Queryable,
        _hash: ContentHash,
      ): Promise<Uint8Array | null> {
        throw new Error('HEAD reached the byte layer');
      }
    }

    const isolated = await startAssetConformanceServer({
      byteStore: (db) => new FailingReadByteStore(db),
    });
    const store = new HttpAssetStore({
      baseUrl: isolated.baseUrl,
      fetch: isolated.fetch,
      headers: () => ({ 'x-asset-principal': 'owner' }),
    });
    try {
      const id = await store.put(blob('identity only', 'image/png'));
      const response = await isolated.fetch(`${isolated.baseUrl}/assets/${id}/content`, {
        method: 'HEAD',
        headers: { 'x-asset-principal': 'owner' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('content-length')).toBe('13');
      expect(response.headers.get('x-asset-revision')).toBe('1');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    } finally {
      await store.close();
      await isolated.close();
    }
  });

  test('foreign, absent, deleted, and malformed-shape ids are indistinguishable on every id route', async () => {
    const storeId = `matrix-${namespace++}`;
    const owner = makeStore('owner', storeId);
    const other = makeStore('other', storeId);
    const ownId = await owner.put(blob('own'));
    const foreignId = await other.put(blob('foreign'));
    const deletedId = await owner.put(blob('deleted'));
    await owner.remove(deletedId);
    const ids = {
      other: foreignId,
      'never-allocated': 'ast_never_allocated',
      'already-deleted': deletedId,
      malformed: 'not-an-asset-id',
    };

    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE'] as const) {
      const observations: unknown[] = [];
      for (const id of Object.values(ids)) {
        const path =
          method === 'DELETE'
            ? `/assets/${encodeURIComponent(id)}`
            : `/assets/${encodeURIComponent(id)}/content`;
        const write = multipart([
          { name: 'bytes', value: 'replacement', contentType: 'text/plain' },
        ]);
        const response = await rawRequest({
          method,
          path,
          headers:
            method === 'PUT'
              ? multipartHeaders(storeId, 'owner')
              : { 'x-asset-store-id': storeId, 'x-asset-principal': 'owner' },
          ...(method === 'PUT' ? { body: write } : {}),
        });
        observations.push(comparable(response));
      }
      for (const observation of observations.slice(1)) expect(observation).toEqual(observations[0]);

      const ownPath =
        method === 'DELETE'
          ? `/assets/${encodeURIComponent(ownId)}`
          : `/assets/${encodeURIComponent(ownId)}/content`;
      const own = await rawRequest({
        method,
        path: ownPath,
        headers:
          method === 'PUT'
            ? multipartHeaders(storeId, 'owner')
            : { 'x-asset-store-id': storeId, 'x-asset-principal': 'owner' },
        ...(method === 'PUT'
          ? {
              body: multipart([
                { name: 'bytes', value: 'own replacement', contentType: 'text/plain' },
              ]),
            }
          : {}),
      });
      expect(own.status).toBe(method === 'GET' || method === 'HEAD' ? 200 : 204);
    }
  });

  test('every FOREIGN_IDS value remains an ordinary HTTP miss', async () => {
    const store = makeStore();
    for (const [, id] of FOREIGN_IDS) {
      await expect(store.resolve(id)).resolves.toBeNull();
      await expect(store.remove(id)).resolves.toBeUndefined();
    }
  });

  test('query strings are rejected on all five routes', async () => {
    const storeId = `query-${namespace++}`;
    const store = makeStore('principal-a', storeId);
    const id = await store.put(blob('query target'));
    const cases = [
      ['POST', '/assets?'],
      ['GET', `/assets/${id}/content?x=1`],
      ['HEAD', `/assets/${id}/content?`],
      ['PUT', `/assets/${id}/content?x=1`],
      ['DELETE', `/assets/${id}?x=1`],
    ] as const;
    for (const [method, path] of cases) {
      const response = await rawRequest({
        method,
        path,
        headers: { 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' },
      });
      expect(response.status).toBe(400);
      if (method !== 'HEAD') expect(response.body.toString()).toContain('VALIDATION_FAILED');
    }
  });

  test('GET, HEAD, and DELETE reject request bodies', async () => {
    const storeId = `bodyless-${namespace++}`;
    const store = makeStore('principal-a', storeId);
    const id = await store.put(blob('bodyless'));
    for (const [method, path] of [
      ['GET', `/assets/${id}/content`],
      ['HEAD', `/assets/${id}/content`],
      ['DELETE', `/assets/${id}`],
    ] as const) {
      const response = await rawRequest({
        method,
        path,
        headers: { 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' },
        body: 'smuggled',
      });
      expect(response.status).toBe(400);
    }
  });

  test('rejects hostile multipart shapes without writing', async () => {
    const storeId = `multipart-${namespace++}`;
    const headers = multipartHeaders(storeId);
    const cases: Array<[string, Buffer, number]> = [
      [
        'duplicate meta parts',
        multipart([
          { name: 'meta', value: '{}', contentType: 'application/json' },
          { name: 'meta', value: '{}', contentType: 'application/json' },
          { name: 'bytes', value: 'a' },
        ]),
        400,
      ],
      [
        'duplicate bytes parts',
        multipart([
          { name: 'meta', value: '{}', contentType: 'application/json' },
          { name: 'bytes', value: 'a' },
          { name: 'bytes', value: 'b' },
        ]),
        400,
      ],
      [
        'extra part',
        multipart([
          { name: 'meta', value: '{}', contentType: 'application/json' },
          { name: 'extra', value: 'x' },
          { name: 'bytes', value: 'a' },
        ]),
        400,
      ],
      [
        'missing bytes',
        multipart([{ name: 'meta', value: '{}', contentType: 'application/json' }]),
        400,
      ],
      [
        'wrong order',
        multipart([
          { name: 'bytes', value: 'a' },
          { name: 'meta', value: '{}', contentType: 'application/json' },
        ]),
        400,
      ],
    ];
    for (const [, body, status] of cases) {
      const response = await rawRequest({ method: 'POST', path: '/assets', headers, body });
      expect(response.status).toBe(status);
    }
    const wrongType = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: { 'content-type': 'application/json', 'x-asset-store-id': storeId },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
  });

  test('enforces request, metadata, and asset byte limits independently', async () => {
    const limited = await startAssetConformanceServer({
      maxRequestBytes: 700,
      maxAssetBytes: 20,
      maxMetaBytes: 20,
    });
    try {
      const url = new URL(limited.baseUrl);
      const send = (body: Buffer): Promise<RawResponse> =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: url.hostname,
              port: url.port,
              method: 'POST',
              path: '/assets',
              headers: {
                'content-type': 'multipart/form-data; boundary=asset-test-boundary',
                'content-length': String(body.byteLength),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      const oversizedMeta = multipart([
        {
          name: 'meta',
          value: JSON.stringify({ x: 'm'.repeat(30) }),
          contentType: 'application/json',
        },
        { name: 'bytes', value: 'ok' },
      ]);
      const oversizedAsset = multipart([
        { name: 'meta', value: '{}', contentType: 'application/json' },
        { name: 'bytes', value: 'b'.repeat(21) },
      ]);
      const oversizedRequest = Buffer.concat([
        multipart([
          { name: 'meta', value: '{}', contentType: 'application/json' },
          { name: 'bytes', value: 'ok' },
        ]),
        Buffer.alloc(800),
      ]);
      expect((await send(oversizedMeta)).status).toBe(413);
      expect((await send(oversizedAsset)).status).toBe(413);
      expect((await send(oversizedRequest)).status).toBe(413);
    } finally {
      await limited.close();
    }
  });

  test.each([
    ['name smuggled in a quoted filename', 'form-data; filename="x; name=meta; y"'],
    ['unterminated quote', 'form-data; name="meta'],
    ['trailing text after a quote', 'form-data; name="meta"junk'],
    ['continuation parameter', 'form-data; name=meta; name*0=bytes'],
    ['non-ASCII separator', 'form-data;\u00a0name=meta'],
    ['bare LF in a quoted filename', 'form-data; name=meta; filename="a\nb"'],
  ] as const)('platform parser rejects %s', async (_label, metaDisposition) => {
    const boundary = 'asset-test-boundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${metaDisposition}\r\n` +
          'Content-Type: application/json\r\n\r\n{}\r\n',
        'latin1',
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="bytes"; filename="asset"\r\n\r\npayload\r\n`,
        'latin1',
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const response = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: multipartHeaders(`disposition-${namespace++}`, 'principal-a', boundary),
      body,
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body.toString())).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: '@openmaic/storage: malformed multipart body',
      },
    });
  });

  test('rejects a meta part without filename as text-decoded data', async () => {
    const response = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: multipartHeaders(`meta-string-${namespace++}`),
      body: multipart([
        { name: 'meta', value: '{}', contentType: 'application/json', filename: null },
        { name: 'bytes', value: 'payload' },
      ]),
    });
    expect(response.status).toBe(400);
    expect(response.body.toString()).toContain('meta part must be sent as a file');
  });

  test('rejects a meta file whose media type is not application/json', async () => {
    const response = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: multipartHeaders(`meta-type-${namespace++}`),
      body: multipart([
        { name: 'meta', value: '{}', contentType: 'text/plain' },
        { name: 'bytes', value: 'payload' },
      ]),
    });
    expect(response.status).toBe(400);
    expect(response.body.toString()).toContain('meta part must be application/json');
  });

  test('rejects a meta file whose bytes are not valid UTF-8', async () => {
    const response = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: multipartHeaders(`meta-utf8-${namespace++}`),
      body: multipart([
        {
          name: 'meta',
          value: Uint8Array.of(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d),
          contentType: 'application/json',
        },
        { name: 'bytes', value: 'payload' },
      ]),
    });
    expect(response.status).toBe(400);
    expect(response.body.toString()).toContain('meta part must contain valid UTF-8');
  });

  test('rejects a bytes part without filename as text-decoded data', async () => {
    const response = await rawRequest({
      method: 'POST',
      path: '/assets',
      headers: multipartHeaders(`bytes-string-${namespace++}`),
      body: multipart([
        { name: 'meta', value: '{}', contentType: 'application/json' },
        { name: 'bytes', value: 'payload', filename: null },
      ]),
    });
    expect(response.status).toBe(400);
    expect(response.body.toString()).toContain('bytes part must be sent as a file');
  });

  test('the client round-trips non-UTF-8 bytes through a file part', async () => {
    const storeId = `binary-${namespace++}`;
    const store = makeStore('principal-a', storeId);
    const original = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80);
    const id = await store.put(new Blob([original], { type: 'image/png' }));
    const response = await rawRequest({
      method: 'GET',
      path: `/assets/${id}/content`,
      headers: { 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from(original));
  });

  test('exceeding maxParts is a payload limit, not a validation failure', async () => {
    const limited = await startAssetConformanceServer({ maxParts: 2 });
    try {
      const url = new URL(limited.baseUrl);
      const body = multipart([
        { name: 'meta', value: '{}', contentType: 'application/json' },
        { name: 'bytes', value: 'ok' },
        { name: 'bytes', value: 'extra' },
      ]);
      const response = await new Promise<RawResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            method: 'POST',
            path: '/assets',
            headers: {
              'content-type': 'multipart/form-data; boundary=asset-test-boundary',
              'content-length': String(body.byteLength),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(response.status).toBe(413);
    } finally {
      await limited.close();
    }
  });

  test('wrong methods return 405 with Allow and /assetsfoo is ROUTE_NOT_FOUND', async () => {
    const storeId = `routes-${namespace++}`;
    for (const [path, allow] of [
      ['/assets', 'POST'],
      ['/assets/id', 'DELETE'],
      ['/assets/id/content', 'GET, HEAD, PUT'],
    ] as const) {
      const response = await rawRequest({
        method: 'PATCH',
        path,
        headers: { 'x-asset-store-id': storeId },
      });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe(allow);
    }
    const outside = await rawRequest({ method: 'GET', path: '/assetsfoo' });
    expect(outside.status).toBe(404);
    expect(outside.body.toString()).toContain('ROUTE_NOT_FOUND');
  });

  test('byte responses enforce safe labels and required headers', async () => {
    const storeId = `labels-${namespace++}`;
    const store = makeStore('principal-a', storeId);
    const id = await store.put(blob('<svg/>', 'image/svg+xml'));
    const response = await server.fetch(`${server.baseUrl}/assets/${id}/content`, {
      headers: { 'x-asset-principal': 'principal-a', 'x-asset-store-id': storeId },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('last-modified')).toBeNull();
    expect(response.headers.get('accept-ranges')).toBeNull();
    const url = await store.resolve(id);
    const stored = blobForObjectUrl(url!);
    expect(stored?.type).toBe('application/octet-stream');
  });

  test('metadata-omitting PUT with an untyped blob uses the binary default media type', async () => {
    const storeId = `retained-type-${namespace++}`;
    const store = makeStore('principal-a', storeId);
    const id = await store.put(blob('before', 'image/png'), { contentType: 'image/png' });
    await store.replace(id as AssetId, blob('after', ''));
    const response = await server.fetch(`${server.baseUrl}/assets/${id}/content`, {
      headers: { 'x-asset-principal': 'principal-a', 'x-asset-store-id': storeId },
    });
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  test('no digest encoding appears in response headers, bodies, ids, or error messages', async () => {
    const storeId = `digest-${namespace++}`;
    const store = makeStore('principal-a', storeId);
    const data = blob('digest scan payload', 'image/png');
    const id = await store.put(data);
    await expectNoDigestSubstring(id, data);
    const responses = await Promise.all([
      rawRequest({
        method: 'GET',
        path: `/assets/${id}/content`,
        headers: { 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' },
      }),
      rawRequest({
        method: 'HEAD',
        path: `/assets/${id}/content`,
        headers: { 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' },
      }),
      rawRequest({
        method: 'GET',
        path: '/assets/absent/content',
        headers: { 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' },
      }),
    ]);
    const observed = responses
      .map((response) => `${JSON.stringify(response.headers)}\n${response.body.toString()}`)
      .join('\n');
    for (const encoding of await commonDigestEncodings(data)) {
      expect(observed.toLowerCase()).not.toContain(encoding.slice(0, 12).toLowerCase());
    }
  });
});

describe('HttpAssetStore snapshot behavior', () => {
  test('coalesces concurrent cold resolves into one GET and one URL', async () => {
    const storeId = `coalesce-${namespace++}`;
    const writer = makeStore('principal-a', storeId);
    const id = await writer.put(blob('coalesce'));
    let gets = 0;
    const client = new HttpAssetStore({
      baseUrl: server.baseUrl,
      fetch: async (input, init) => {
        if ((init?.method ?? 'GET') === 'GET') gets += 1;
        return server.fetch(input, init);
      },
      headers: () => ({ 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' }),
    });
    stores.push(client);
    const [left, right] = await Promise.all([client.resolve(id), client.resolve(id)]);
    expect(left).toBe(right);
    expect(gets).toBe(1);
  });

  test('identical bytes under two ids mint different per-id URLs', async () => {
    const store = makeStore();
    const [leftId, rightId] = await Promise.all([store.put(blob('same')), store.put(blob('same'))]);
    const [left, right] = await Promise.all([store.resolve(leftId), store.resolve(rightId)]);
    expect(left).not.toBe(right);
  });

  test('replace retires rather than revokes an issued snapshot; release revokes both', async () => {
    const store = makeStore();
    const id = await store.put(blob('before'));
    const before = await store.resolve(id);
    expect(blobForObjectUrl(before!)).toBeDefined();
    await store.replace(id as AssetId, blob('after'));
    const after = await store.resolve(id);
    expect(after).not.toBe(before);
    expect(blobForObjectUrl(before!)).toBeDefined();
    expect(blobForObjectUrl(after!)).toBeDefined();
    await store.release(id);
    expect(blobForObjectUrl(before!)).toBeUndefined();
    expect(blobForObjectUrl(after!)).toBeUndefined();
  });

  test('warm resolves revalidate with HEAD', async () => {
    const storeId = `head-${namespace++}`;
    const writer = makeStore('principal-a', storeId);
    const id = await writer.put(blob('head'));
    const methods: string[] = [];
    const client = new HttpAssetStore({
      baseUrl: server.baseUrl,
      fetch: async (input, init) => {
        methods.push(init?.method ?? 'GET');
        return server.fetch(input, init);
      },
      headers: () => ({ 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' }),
    });
    stores.push(client);
    const first = await client.resolve(id);
    const second = await client.resolve(id);
    expect(second).toBe(first);
    expect(methods).toEqual(['GET', 'HEAD']);
  });

  test('records the GET revision rather than the preceding HEAD revision', async () => {
    let gets = 0;
    let heads = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'HEAD') {
        heads += 1;
        const revision = heads === 1 ? '2' : '3';
        return new Response(null, {
          status: 200,
          headers: { 'x-asset-revision': revision, 'content-type': 'image/png' },
        });
      }
      gets += 1;
      return new Response(gets === 1 ? 'one' : 'three', {
        status: 200,
        headers: {
          'x-asset-revision': gets === 1 ? '1' : '3',
          'content-type': 'image/png',
        },
      });
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);
    await store.resolve('asset');
    await store.resolve('asset');
    await store.resolve('asset');
    expect(gets).toBe(2);
    expect(heads).toBe(2);
  });

  test('a descriptor answer is followed with no deployment headers, and labels from the descriptor', async () => {
    // Indirect egress for the packaged client: the byte GET asks for a
    // descriptor, and the signed URL is fetched without any of the
    // deployment's headers -- automatic redirect following would forward
    // them to the object store's origin.
    const seen: Array<{ method: string; url: string; headers: HeadersInit | undefined }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push({ method, url, headers: init?.headers });
      if (url === 'https://objects.example/signed') {
        // The object store's answer: the pinned content type, no revision.
        return new Response(new Blob(['signed-bytes'], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'x-asset-revision': '7', 'content-type': 'image/png' },
        });
      }
      return new Response(JSON.stringify({ url: 'https://objects.example/signed', revision: 7 }), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.openmaic.asset-descriptor+json',
          'x-asset-revision': '7',
        },
      });
    });
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.invalid',
      fetch,
      headers: () => ({ 'x-api-key': 'deployment-secret' }),
    });
    stores.push(store);

    const url = await store.resolve('asset');
    expect(url).not.toBeNull();
    expect(blobForObjectUrl(url!)?.type).toBe('image/png');

    const [byteGet, signedGet] = seen;
    expect(byteGet?.method).toBe('GET');
    // The descriptor is preferred, but bytes stay acceptable: a strict
    // negotiating layer must never see a descriptor-only demand.
    expect(new Headers(byteGet?.headers).get('accept')).toBe(
      'application/vnd.openmaic.asset-descriptor+json, */*;q=0.9',
    );
    expect(signedGet?.url).toBe('https://objects.example/signed');
    expect(new Headers(signedGet?.headers).get('x-api-key')).toBeNull();
    expect(signedGet?.headers).toBeUndefined();

    // The label came from the descriptor: a warm resolve revalidates against
    // it and keeps the snapshot.
    const again = await store.resolve('asset');
    expect(again).toBe(url);
    expect(seen[seen.length - 1]?.method).toBe('HEAD');
  });

  test('a redirect answer to the descriptor byte GET is never followed and fails closed', async () => {
    // The descriptor GET is sent with redirect: 'manual', so a server that
    // ignores the negotiation (or is misconfigured) and answers 302 is
    // surfaced as the 3xx it is rather than followed -- following would
    // forward the deployment's custom credential headers to the redirect
    // target, and the target must never see them or a request.
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(null, {
        status: 302,
        headers: { location: 'https://objects.example/elsewhere' },
      });
    });
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.invalid',
      fetch,
      headers: () => ({ 'x-learner-key': 'deployment-secret' }),
    });
    stores.push(store);

    await expect(store.resolve('asset')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      status: 302,
    });
    // Exactly one request: the redirect target was never fetched, so nothing
    // of the deployment's headers went anywhere.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://assets.invalid/assets/asset/content');
    expect(seen[0]?.init?.redirect).toBe('manual');
  });

  test('a signed URL whose object is gone is a miss, not a malformed response', async () => {
    // Reclamation landing between the mint and the fetch: the entry was owned
    // and readable when the descriptor was issued, so the object store's 404
    // confirming a missing object reports the same physical state a direct
    // read reports as a miss. What a read means must not depend on the
    // deployment's egress setting.
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input) === 'https://objects.example/collected') {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Error><Code>NoSuchKey</Code>' +
            '<Message>The specified key does not exist.</Message></Error>',
          { status: 404, headers: { 'content-type': 'application/xml' } },
        );
      }
      return new Response(
        JSON.stringify({ url: 'https://objects.example/collected', revision: 7 }),
        {
          status: 200,
          headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
        },
      );
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);

    await expect(store.resolve('asset')).resolves.toBeNull();
  });

  test.each([
    // S3/MinIO name a wrong bucket with a code of their own, not NoSuchKey.
    [
      'an XML body naming another code',
      '<?xml version="1.0" encoding="UTF-8"?><Error>' +
        '<Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message>' +
        '</Error>',
    ],
    // A text body is not the documented XML error shape.
    ['a plain-text body', 'NoSuchKey'],
    ['an empty body', ''],
  ])('a signed 404 with %s fails loud, never as a miss', async (_label, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input) === 'https://objects.example/failure') {
        return new Response(body, { status: 404 });
      }
      return new Response(JSON.stringify({ url: 'https://objects.example/failure', revision: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
      });
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);

    await expect(store.resolve('asset')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  test('a signed URL failing for any other reason stays a malformed response', async () => {
    // A 403 is not a miss: with S3 it is what a missing object looks like when
    // the signing identity lacks s3:ListBucket, and it is equally what a real
    // credential fault looks like. Reporting it as a miss would hide the fault.
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input) === 'https://objects.example/denied') {
        return new Response('AccessDenied', { status: 403 });
      }
      return new Response(JSON.stringify({ url: 'https://objects.example/denied', revision: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
      });
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);

    await expect(store.resolve('asset')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  test('a malformed egress descriptor fails as MALFORMED_RESPONSE', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      return new Response(JSON.stringify({ url: 'https://objects.example/signed' }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
      });
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);

    await expect(store.resolve('asset')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  test('a descriptor carrying a non-http(s) url fails as MALFORMED_RESPONSE without a follow-up request', async () => {
    // Only an absolute http(s) URL may be fetched for the bytes. A descriptor
    // naming anything else is malformed, and the signed fetch must never be
    // issued against it.
    for (const bad of ['not-a-url', 'ftp://objects.example/signed', '//objects.example/signed']) {
      const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        seen.push({ url: String(input), init });
        return new Response(JSON.stringify({ url: bad, revision: 7 }), {
          status: 200,
          headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
        });
      });
      const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
      stores.push(store);

      await expect(store.resolve('asset')).rejects.toMatchObject({
        code: 'MALFORMED_RESPONSE',
      });
      // Exactly one request: the descriptor GET. The invalid URL was never
      // fetched.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe('https://assets.invalid/assets/asset/content');
    }
  });

  test('a media type that merely begins with the descriptor type is served as bytes', async () => {
    // Only the exact essence identifies a descriptor; a longer type naming a
    // real payload must not be parsed as one.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      return new Response(new Blob(['payload'], { type: 'text/plain' }), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.openmaic.asset-descriptor+json-seq',
          'x-asset-revision': '4',
        },
      });
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);

    const url = await store.resolve('asset');
    expect(url).not.toBeNull();
    expect(blobForObjectUrl(url!)?.type).toBe('application/vnd.openmaic.asset-descriptor+json-seq');
  });

  test('an unclassifiable HEAD falls back to GET and is never treated as a miss', async () => {
    let requests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requests += 1;
      if (requests === 1) {
        return new Response('bytes', {
          status: 200,
          headers: { 'x-asset-revision': '1', 'content-type': 'image/png' },
        });
      }
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return new Response('bytes', {
        status: 200,
        headers: { 'x-asset-revision': '1', 'content-type': 'image/png' },
      });
    });
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);
    const first = await store.resolve('asset');
    await expect(store.resolve('asset')).resolves.toBe(first);
    expect(requests).toBe(3);
  });

  test('only status 404 together with ASSET_NOT_FOUND is a miss', async () => {
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND', message: 'route' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });
    stores.push(store);
    await expect(store.resolve('asset')).rejects.toMatchObject({
      status: 404,
      code: 'ROUTE_NOT_FOUND',
    });
  });

  test('unaddressable ids resolve and remove locally while replace synthesizes not found', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const store = new HttpAssetStore({ baseUrl: 'https://assets.invalid', fetch });
    stores.push(store);
    for (const id of ['', '.', '..', '\ud800']) {
      await expect(store.resolve(id)).resolves.toBeNull();
      await expect(store.remove(id)).resolves.toBeUndefined();
      await expect(store.replace(id as AssetId, blob('x'))).rejects.toMatchObject({
        status: 404,
        code: 'ASSET_NOT_FOUND',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a headers hook cannot overwrite multipart Content-Type', async () => {
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.invalid',
      fetch: vi.fn<typeof globalThis.fetch>(),
      headers: () => ({ 'content-type': 'multipart/form-data' }),
    });
    stores.push(store);
    await expect(store.put(blob('x'))).rejects.toMatchObject({ code: 'CONTENT_TYPE_CONFLICT' });
  });
});

describe('asset handler construction', () => {
  const inertStore = {} as AssetStore;

  test('refuses executable renderable types', () => {
    expect(() =>
      createAssetHttpHandler(inertStore, {
        authenticate: async () => ({ key: 'principal' }),
        renderableTypes: ['image/svg+xml'],
      }),
    ).toThrow(/excluded executable type/);
  });

  test('requires outer request room beyond the decoded part limits', () => {
    expect(() =>
      createAssetHttpHandler(inertStore, {
        authenticate: async () => ({ key: 'principal' }),
        maxRequestBytes: 20,
        maxAssetBytes: 10,
        maxMetaBytes: 10,
      }),
    ).toThrow(/multipart framing/);
  });
});

describe('HttpAssetStore bounded exists fallback', () => {
  test('exists() rejects within the probe timeout when the fallback GET stalls', async () => {
    // An unclassifiable HEAD falls back to a full resolve; that fallback GET
    // must be bounded like the probe, or a stalled persistence endpoint can
    // hold migration/conversion indefinitely.
    const stalledFetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 500 }));
      // GET: hang until the caller's abort signal fires.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      });
    }) as typeof fetch;
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.test',
      fetch: stalledFetch,
      probeTimeoutMs: 30,
    });

    await expect(store.exists('ast_stalled')).rejects.toMatchObject({
      code: 'HTTP_REQUEST_FAILED',
    });
  });

  test('exists() still resolves through the bounded fallback GET when the HEAD is unclassifiable', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 500 }));
      return Promise.resolve(
        new Response(new Blob(['bytes']), {
          status: 200,
          headers: { 'content-type': 'text/plain', 'x-asset-revision': 'rev-1' },
        }),
      );
    }) as typeof fetch;
    const store = new HttpAssetStore({ baseUrl: 'https://assets.test', fetch: fetchImpl });

    await expect(store.exists('ast_present')).resolves.toBe(true);
  });

  test('exists() rejects within the probe deadline when the signed-object fetch stalls', async () => {
    // The probe deadline must cover the descriptor's signed fetch too: a
    // stalled object store cannot hold the check past the probe budget.
    const seen: AbortSignal[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === 'https://objects.example/stalled-fetch') {
        const signal = init?.signal;
        seen.push(signal as AbortSignal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
        });
      }
      // An unclassifiable HEAD (no x-error-code) forces the bounded fallback.
      if (init?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ url: 'https://objects.example/stalled-fetch', revision: 7 }),
          {
            status: 200,
            headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
          },
        ),
      );
    }) as typeof fetch;
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.test',
      fetch: fetchImpl,
      probeTimeoutMs: 50,
    });

    const started = Date.now();
    await expect(store.exists('ast_stalled_signed')).rejects.toMatchObject({
      code: 'HTTP_REQUEST_FAILED',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen[0]?.aborted).toBe(true);
  });

  test('exists() rejects within the probe deadline when the signed-object body stalls', async () => {
    // Body parsing is part of the same absolute deadline: a signed response
    // that never finishes its body cannot hold the check past the budget.
    const seen: AbortSignal[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === 'https://objects.example/stalled-body') {
        const signal = init?.signal;
        seen.push(signal as AbortSignal);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              pull() {
                return new Promise((_resolve, reject) => {
                  signal?.addEventListener(
                    'abort',
                    () => reject(signal.reason ?? new Error('aborted')),
                    { once: true },
                  );
                });
              },
            }),
            { status: 200, headers: { 'content-type': 'audio/mpeg' } },
          ),
        );
      }
      // An unclassifiable HEAD (no x-error-code) forces the bounded fallback.
      if (init?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ url: 'https://objects.example/stalled-body', revision: 7 }), {
          status: 200,
          headers: { 'content-type': 'application/vnd.openmaic.asset-descriptor+json' },
        }),
      );
    }) as typeof fetch;
    const store = new HttpAssetStore({
      baseUrl: 'https://assets.test',
      fetch: fetchImpl,
      probeTimeoutMs: 50,
    });

    const started = Date.now();
    await expect(store.exists('ast_stalled_body')).rejects.toMatchObject({
      code: 'HTTP_REQUEST_FAILED',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen[0]?.aborted).toBe(true);
  });

  test('exists() does not trust a 200 HEAD without a valid response identity', async () => {
    // An auth wall or proxy landing page can answer 200 with an HTML body and
    // no asset identity (no x-asset-revision / content-type). Trusting that
    // 200 would report an unresolvable id as present, and the converter would
    // drop a co-present legacy handle for bytes that do not exist. The probe
    // must treat the identity-less success as unclassifiable and let the
    // bounded byte read decide -- which refuses the same identity-less body.
    const identityless = new Response('<!doctype html><title>Sign in</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return Promise.resolve(
        init?.method === 'HEAD'
          ? identityless.clone()
          : new Response('<!doctype html><title>Sign in</title>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
      );
    }) as typeof fetch;
    const store = new HttpAssetStore({ baseUrl: 'https://assets.test', fetch: fetchImpl });

    await expect(store.exists('ast_identityless')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  test('exists() resolves an identity-less 200 HEAD through the fallback when the bytes carry a real identity', async () => {
    // The identity-less 200 is not proof, but it is not a miss either: the
    // byte read confirms the asset genuinely resolves, and the probe answers
    // present exactly as a matching warm HEAD would.
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'HEAD') {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        );
      }
      return Promise.resolve(
        new Response(new Blob(['bytes']), {
          status: 200,
          headers: { 'content-type': 'text/plain', 'x-asset-revision': 'rev-1' },
        }),
      );
    }) as typeof fetch;
    const store = new HttpAssetStore({ baseUrl: 'https://assets.test', fetch: fetchImpl });

    await expect(store.exists('ast_present')).resolves.toBe(true);
  });

  test('repeated exists() on an unclassifiable-HEAD endpoint leaves no object URLs minted', async () => {
    // A probe that fell back through the byte read must not retain the fetched
    // blob as an object URL: migration probes run per reference, and pinning
    // every fetched blob would hold quota until store close.
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(
        new Response(new Blob(['bytes']), {
          status: 200,
          headers: { 'content-type': 'text/plain', 'x-asset-revision': 'rev-1' },
        }),
      );
    }) as typeof fetch;
    const store = new HttpAssetStore({ baseUrl: 'https://assets.test', fetch: fetchImpl });

    await expect(store.exists('ast_probe_1')).resolves.toBe(true);
    await expect(store.exists('ast_probe_1')).resolves.toBe(true);
    expect(objectUrlCount()).toBe(0);
  });
});
