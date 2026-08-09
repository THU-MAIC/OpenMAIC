import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { HttpAssetStore } from '../src/asset/http.js';
import { __setAssetIdFactoryForTesting, type AssetId } from '../src/asset/id.js';
import { createAssetHttpHandler } from '../src/server/asset.js';
import type { AssetStore } from '../src/asset/types.js';
import {
  FOREIGN_IDS,
  commonDigestEncodings,
  expectNoDigestSubstring,
  runAssetStoreContract,
} from './asset-contract.js';
import {
  startAssetConformanceServer,
  type AssetConformanceServer,
} from './asset-conformance-server.js';
import { blobForObjectUrl } from './setup.js';

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
      part.filename === undefined ? (part.name === 'bytes' ? 'asset' : undefined) : part.filename;
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

  test.each([undefined, 'meta.json'] as const)(
    'accepts metadata with filename $filename',
    async (filename) => {
      const response = await rawRequest({
        method: 'POST',
        path: '/assets',
        headers: multipartHeaders(`meta-file-${namespace++}`),
        body: multipart([
          {
            name: 'meta',
            value: '{}',
            contentType: 'application/json',
            ...(filename === undefined ? {} : { filename }),
          },
          { name: 'bytes', value: 'payload' },
        ]),
      });
      expect(response.status).toBe(201);
    },
  );

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
