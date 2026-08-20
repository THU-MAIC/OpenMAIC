import type { RequestListener } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('embedded persistence route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('ASSET_S3_BUCKET', '');
  });

  it('returns a clear 404 when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { GET } = await import('@/app/api/persistence/[...path]/route');

    const response = await GET(new Request('http://localhost/api/persistence/runtime/sessions'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'PERSISTENCE_NOT_CONFIGURED',
        message: 'server persistence not configured',
      },
    });
  });

  it('refuses configured persistence when the development token is missing', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://unused-in-this-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    const { GET } = await import('@/app/api/persistence/[...path]/route');

    const response = await GET(new Request('http://localhost/api/persistence/documents'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'PERSISTENCE_DEV_TOKEN_MISSING',
        message: 'server persistence requires PERSISTENCE_DEV_TOKEN (development auth only)',
      },
    });
  });

  it('retries initialization on the next request after a failed pool initialization', async () => {
    const ensureSchema = vi
      .fn()
      .mockRejectedValueOnce(new Error('postgres is still starting'))
      .mockResolvedValue(undefined);
    const ensureDocumentSchema = vi.fn().mockResolvedValue(undefined);
    const failedPool = { end: vi.fn().mockResolvedValue(undefined) };
    const workingPool = { end: vi.fn().mockResolvedValue(undefined) };

    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema,
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema,
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://retry-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const request = () =>
      new Request('http://localhost/api/persistence/runtime/sessions', {
        headers: { authorization: 'Bearer test-token' },
      });

    const first = await handlePersistenceRequest(request(), {
      poolFactory: () => failedPool as never,
    });
    const second = await handlePersistenceRequest(request(), {
      poolFactory: () => workingPool as never,
    });

    expect(first.status).toBe(500);
    expect(second.status).toBe(204);
    expect(ensureSchema).toHaveBeenCalledTimes(2);
    expect(failedPool.end).toHaveBeenCalledOnce();
    expect(workingPool.end).not.toHaveBeenCalled();

    // Next dev HMR reloads module code but retains globalThis. The initialized
    // handler must be reused rather than opening another pool.
    vi.resetModules();
    const reloaded = await import('@/app/api/persistence/[...path]/route');
    const hmrPoolFactory = vi.fn();
    const afterReload = await reloaded.handlePersistenceRequest(request(), {
      poolFactory: hmrPoolFactory,
    });
    expect(afterReload.status).toBe(204);
    expect(hmrPoolFactory).not.toHaveBeenCalled();
  });

  it('mounts an asset store on the document pool and transaction and ensures its schema', async () => {
    const sdkModuleResolved = vi.fn();
    const ensureSchema = vi.fn().mockResolvedValue(undefined);
    const ensureDocumentSchema = vi.fn().mockResolvedValue(undefined);
    const ensureAssetSchema = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn();
    const nodePostgresTransaction = vi.fn(() => transaction);
    const runtimeConstructions: Array<{
      queryable: unknown;
      options: unknown;
      instance: unknown;
    }> = [];
    const documentConstructions: Array<{ queryable: unknown; options: unknown }> = [];
    const byteConstructions: unknown[] = [];
    const assetConstructions: Array<{ queryable: unknown; options: unknown; instance: unknown }> =
      [];
    const handlerOptions: unknown[] = [];

    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema,
      PgRuntimeStore: class {
        constructor(queryable: unknown, options: unknown) {
          runtimeConstructions.push({ queryable, options, instance: this });
        }
      },
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema,
      PgDocumentStore: class {
        constructor(queryable: unknown, options: unknown) {
          documentConstructions.push({ queryable, options });
        }
      },
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {
        constructor(queryable: unknown) {
          byteConstructions.push(queryable);
        }
        read = vi.fn().mockResolvedValue(new Uint8Array([1]));
      },
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema,
      PgAssetStore: class {
        constructor(queryable: unknown, options: unknown) {
          assetConstructions.push({ queryable, options, instance: this });
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({ nodePostgresTransaction }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        (_runtime: unknown, _documents: unknown, options: unknown) => {
          handlerOptions.push(options);
          return (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          };
        },
      ),
    }));
    vi.doMock('@aws-sdk/client-s3', () => {
      sdkModuleResolved();
      throw new Error('the optional SDK must not resolve without a bucket');
    });
    vi.stubEnv('DATABASE_URL', 'postgres://asset-wiring-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const pool = { end: vi.fn().mockResolvedValue(undefined) };

    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/assets/ast_example/content', {
        headers: { authorization: 'Bearer test-token', 'x-learner-key': 'anon:test' },
      }),
      { poolFactory: () => pool as never },
    );

    expect(response.status).toBe(204);
    expect(ensureSchema).toHaveBeenCalledWith(pool);
    expect(ensureDocumentSchema).toHaveBeenCalledWith(pool);
    expect(ensureAssetSchema).toHaveBeenCalledWith(pool);
    expect(nodePostgresTransaction).toHaveBeenCalledWith(pool);
    expect(runtimeConstructions[0]?.queryable).toBe(pool);
    expect(documentConstructions[0]?.queryable).toBe(pool);
    expect(assetConstructions[0]?.queryable).toBe(pool);
    // The byte layer is deferred to first use: nothing constructs it during
    // handler initialization, and the first byte operation builds the
    // PostgreSQL byte store on the same pool.
    expect(byteConstructions).toHaveLength(0);
    const byteStore = (assetConstructions[0]?.options as { byteStore?: unknown }).byteStore as {
      read(hash: never): Promise<unknown>;
    };
    await expect(byteStore.read('sha256-x' as never)).resolves.toEqual(new Uint8Array([1]));
    expect(byteConstructions[0]).toBe(pool);
    expect(
      (runtimeConstructions[0]?.options as { withTransaction?: unknown }).withTransaction,
    ).toBe(transaction);
    expect(
      (documentConstructions[0]?.options as { withTransaction?: unknown }).withTransaction,
    ).toBe(transaction);
    expect((assetConstructions[0]?.options as { withTransaction?: unknown }).withTransaction).toBe(
      transaction,
    );
    expect((handlerOptions[0] as { assetStore?: unknown }).assetStore).toBe(
      assetConstructions[0]?.instance,
    );
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const secondPoolFactory = vi.fn();
    const sharedProvider = await getServerPersistenceProvider(
      'postgres://asset-wiring-test',
      secondPoolFactory,
    );
    expect(sharedProvider.runtimeStore).toBe(runtimeConstructions[0]?.instance);
    expect(secondPoolFactory).not.toHaveBeenCalled();
    expect(sdkModuleResolved).not.toHaveBeenCalled();
  });

  it('defers S3 resolution to the first asset byte operation', async () => {
    const pgByteStore = vi.fn();
    const assetOptions: unknown[] = [];
    const s3ModuleResolved = vi.fn();
    const s3Read = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const loadS3AssetByteStore = vi.fn().mockResolvedValue({ read: s3Read });
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {
        constructor(queryable: unknown) {
          pgByteStore(queryable);
        }
      },
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {
        constructor(_queryable: unknown, options: unknown) {
          assetOptions.push(options);
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.doMock('@openmaic/storage/asset/s3-bytes', () => {
      s3ModuleResolved();
      return { loadS3AssetByteStore };
    });
    vi.stubEnv('DATABASE_URL', 'postgres://asset-s3-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    vi.stubEnv('ASSET_S3_BUCKET', '  asset-bucket  ');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');

    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/assets', {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'x-learner-key': 'anon:test' },
      }),
      { poolFactory: () => ({ end: vi.fn().mockResolvedValue(undefined) }) as never },
    );

    // Handler initialization leaves the byte layer unresolved: the mocked
    // handler never touches it, so neither the SDK module nor the PostgreSQL
    // byte store has been constructed yet.
    expect(response.status).toBe(204);
    expect(s3ModuleResolved).not.toHaveBeenCalled();
    expect(loadS3AssetByteStore).not.toHaveBeenCalled();
    expect(pgByteStore).not.toHaveBeenCalled();

    // The first byte operation resolves through the single-loader path, with
    // the configured bucket trimmed.
    const byteStore = (assetOptions[0] as { byteStore?: unknown }).byteStore as {
      read(hash: never): Promise<unknown>;
    };
    await expect(byteStore.read('sha256-x' as never)).resolves.toEqual(new Uint8Array([1]));
    expect(s3ModuleResolved).toHaveBeenCalledOnce();
    expect(loadS3AssetByteStore).toHaveBeenCalledExactlyOnceWith('asset-bucket');
    expect(pgByteStore).not.toHaveBeenCalled();
    expect(s3Read).toHaveBeenCalledWith('sha256-x');
  });

  it('contains a malformed S3 bucket to asset traffic instead of failing persistence', async () => {
    const s3ModuleResolved = vi.fn();
    const assetOptions: unknown[] = [];
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {
        constructor(_queryable: unknown, options: unknown) {
          assetOptions.push(options);
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.doMock('@openmaic/storage/asset/s3-bytes', () => {
      s3ModuleResolved();
      return { loadS3AssetByteStore: vi.fn() };
    });
    vi.stubEnv('DATABASE_URL', 'postgres://invalid-s3-bucket-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    vi.stubEnv('ASSET_S3_BUCKET', 'Invalid_Bucket');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const poolFactory = vi.fn(() => ({ end: vi.fn().mockResolvedValue(undefined) }));

    // The malformed bucket no longer gates handler initialization: document
    // and runtime traffic initializes and serves normally.
    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/runtime/sessions', {
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: poolFactory as never },
    );

    expect(response.status).toBe(204);
    expect(poolFactory).toHaveBeenCalledOnce();
    expect(s3ModuleResolved).not.toHaveBeenCalled();

    // The misconfiguration surfaces on the first asset byte operation, naming
    // the variable at fault, and never reaches for the SDK.
    const byteStore = (assetOptions[0] as { byteStore?: unknown }).byteStore as {
      read(hash: never): Promise<unknown>;
    };
    await expect(byteStore.read('sha256-x' as never)).rejects.toThrow(
      'Invalid ASSET_S3_BUCKET: expected a valid Amazon S3 general purpose bucket name',
    );
    expect(s3ModuleResolved).not.toHaveBeenCalled();
  });

  it('does not cache a failed byte-store construction: the next asset request retries', async () => {
    const assetOptions: unknown[] = [];
    const loadS3AssetByteStore = vi
      .fn()
      .mockRejectedValueOnce(new Error('@aws-sdk/client-s3 could not be resolved'))
      .mockResolvedValue({ read: vi.fn().mockResolvedValue(new Uint8Array([1])) });
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {
        constructor(_queryable: unknown, options: unknown) {
          assetOptions.push(options);
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.doMock('@openmaic/storage/asset/s3-bytes', () => ({ loadS3AssetByteStore }));
    vi.stubEnv('DATABASE_URL', 'postgres://asset-s3-retry-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    vi.stubEnv('ASSET_S3_BUCKET', 'asset-bucket');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');

    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/runtime/sessions', {
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: () => ({ end: vi.fn().mockResolvedValue(undefined) }) as never },
    );

    // An SDK that cannot be resolved must not reach handler initialization.
    expect(response.status).toBe(204);

    const byteStore = (assetOptions[0] as { byteStore?: unknown }).byteStore as {
      read(hash: never): Promise<unknown>;
    };
    await expect(byteStore.read('sha256-x' as never)).rejects.toThrow(
      '@aws-sdk/client-s3 could not be resolved',
    );
    // Installing the dependency fixes an already-initialized handler: the
    // rejection was not latched into the wrapper.
    await expect(byteStore.read('sha256-x' as never)).resolves.toEqual(new Uint8Array([1]));
    expect(loadS3AssetByteStore).toHaveBeenCalledTimes(2);
  });

  it('passes one complete app payload-validator table to Pg and HTTP boundaries', async () => {
    const pgOptions: unknown[] = [];
    const handlerOptions: unknown[] = [];
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {
        constructor(_queryable: unknown, options: unknown) {
          pgOptions.push(options);
        }
      },
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn((_runtime: unknown, _document: unknown, options: unknown) => {
        handlerOptions.push(options);
        return (
          _request: unknown,
          response: { writeHead: (status: number) => void; end: () => void },
        ) => {
          response.writeHead(204);
          response.end();
        };
      }),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://validator-wiring-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    const [{ handlePersistenceRequest }, { APP_RUNTIME_PAYLOAD_VALIDATORS }] = await Promise.all([
      import('@/app/api/persistence/[...path]/route'),
      import('@/lib/runtime/payload-validators'),
    ]);
    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/runtime/sessions', {
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: () => ({ end: vi.fn() }) as never },
    );

    expect(response.status).toBe(204);
    expect((pgOptions[0] as { payloadValidators?: unknown }).payloadValidators).toBe(
      APP_RUNTIME_PAYLOAD_VALIDATORS,
    );
    expect((handlerOptions[0] as { payloadValidators?: unknown }).payloadValidators).toBe(
      APP_RUNTIME_PAYLOAD_VALIDATORS,
    );
    expect(Object.keys(APP_RUNTIME_PAYLOAD_VALIDATORS)).toEqual([
      'chat',
      'quizAttempt',
      'whiteboard',
    ]);
  });

  it('round-trips status, headers, and bodies through the Fetch↔Node adapter', async () => {
    // The adapter (Web Request faked as IncomingMessage; writeHead/end bridged
    // back to a Response) is the most bug-prone code in the route — exercise a
    // full body round-trip, a 204, multi-value headers, and path encoding.
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          async (
            request: import('node:http').IncomingMessage,
            response: import('node:http').ServerResponse,
          ) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            const body = Buffer.concat(chunks).toString('utf8');
            seen.push({ method: request.method, url: request.url, body });
            if (request.method === 'PUT') {
              response.writeHead(201, {
                'content-type': 'application/json',
                'x-multi': ['a', 'b'],
              });
              response.end(JSON.stringify({ echoed: JSON.parse(body) }));
              return;
            }
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://adapter-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const pool = { end: vi.fn().mockResolvedValue(undefined) };

    const put = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/stage%2Fslash', {
        method: 'PUT',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      { poolFactory: () => pool as never },
    );
    expect(put.status).toBe(201);
    expect(put.headers.get('content-type')).toBe('application/json');
    expect(put.headers.get('x-multi')).toContain('a');
    await expect(put.json()).resolves.toEqual({ echoed: { hello: 'world' } });

    const del = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/stage%2Fslash', {
        method: 'DELETE',
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: () => pool as never },
    );
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');

    expect(seen[0]?.method).toBe('PUT');
    // Encoded path segments must reach the node handler un-decoded.
    expect(seen[0]?.url).toContain('stage%2Fslash');
    expect(seen[0]?.body).toBe(JSON.stringify({ hello: 'world' }));
    expect(seen[1]?.method).toBe('DELETE');
  });

  // The adapter claims to be a `ServerResponse` through an `as unknown as`
  // cast, so the compiler checks none of that surface. These cases pin the
  // response behavior that differs materially from a plain Fetch Response.
  const mockAdapterHandler = (handler: RequestListener, connectionString: string) => {
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(() => handler),
    }));
    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
  };

  const readAdapterBody = async (path: string) => {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const response = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/${path}`, {
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: () => pool as never },
    );
    return { response, body: new Uint8Array(await response.arrayBuffer()) };
  };

  it('round-trips an asset GET body with invalid UTF-8 byte-for-byte', async () => {
    // `ServerResponse.end` accepts a `Uint8Array`. Bytes that are not valid
    // UTF-8 must survive intact: decoding them substitutes U+FFFD and corrupts
    // the body with no error anywhere.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    mockAdapterHandler((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.byteLength,
      });
      response.end(bytes);
    }, 'postgres://binary-test');

    const { response, body } = await readAdapterBody('assets/ast_binary/content');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(body).toEqual(bytes);
  });

  it('returns binary response bodies byte-for-byte', async () => {
    // `ServerResponse.end` accepts a `Uint8Array`. Bytes that are not valid
    // UTF-8 must survive intact: decoding them substitutes U+FFFD and corrupts
    // the body with no error anywhere.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    mockAdapterHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(bytes);
    }, 'postgres://binary-test');

    const { response, body } = await readAdapterBody('documents/binary');

    expect(response.status).toBe(200);
    expect(body).toEqual(bytes);
  });

  it('supports handlers that call write before end', async () => {
    // `write` was missing entirely, so a chunked handler was a runtime
    // TypeError rather than a compile error.
    const first = new Uint8Array([0x00, 0xc3]);
    const second = new Uint8Array([0x28, 0xff]);
    mockAdapterHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write(first);
      response.write(second);
      response.end();
    }, 'postgres://chunked-test');

    const { response, body } = await readAdapterBody('documents/chunked');

    expect(response.status).toBe(200);
    expect(body).toEqual(new Uint8Array([...first, ...second]));
  });

  it('defers write callbacks without synchronous recursion', async () => {
    const chunkCount = 20_000;
    let callbackRanInline = false;
    let writesCompleted = 0;
    mockAdapterHandler((_request, response) => {
      const writeNext = () => {
        let writeReturned = false;
        response.write('x', () => {
          if (!writeReturned) callbackRanInline = true;
          writesCompleted += 1;
          if (writesCompleted === chunkCount) response.end();
          else writeNext();
        });
        writeReturned = true;
      };
      writeNext();
    }, 'postgres://deferred-write-callback-test');

    const { response, body } = await readAdapterBody('documents/deferred-write-callback');

    expect(response.status).toBe(200);
    expect(callbackRanInline).toBe(false);
    expect(writesCompleted).toBe(chunkCount);
    expect(body).toHaveLength(chunkCount);
  });

  it.each(['write', 'end'] as const)('honors latin1 encoding in %s', async (method) => {
    mockAdapterHandler((_request, response) => {
      if (method === 'write') {
        response.write('é', 'latin1');
        response.end();
      } else {
        response.end('é', 'latin1');
      }
    }, `postgres://latin1-${method}-test`);

    const { response, body } = await readAdapterBody(`documents/latin1-${method}`);

    expect(response.status).toBe(200);
    expect(body).toEqual(new Uint8Array([0xe9]));
  });

  it('throws Node ERR_UNKNOWN_ENCODING for an invalid response encoding', async () => {
    let encodingError: unknown;
    mockAdapterHandler((_request, response) => {
      try {
        response.write('x', 'definitely-invalid' as BufferEncoding);
      } catch (error) {
        encodingError = error;
      }
      response.end();
    }, 'postgres://invalid-encoding-test');

    const { response } = await readAdapterBody('documents/invalid-encoding');

    expect(response.status).toBe(200);
    expect(encodingError).toMatchObject({
      name: 'TypeError',
      code: 'ERR_UNKNOWN_ENCODING',
      message: 'Unknown encoding: definitely-invalid',
    });
  });

  it.each([204, 205, 304])('suppresses a buffered body for status %i', async (status) => {
    mockAdapterHandler((_request, response) => {
      response.writeHead(status);
      response.write('x');
      response.end();
    }, `postgres://null-body-${status}-test`);

    const { response, body } = await readAdapterBody(`documents/null-body-${status}`);

    expect(response.status).toBe(status);
    expect(body).toHaveLength(0);
  });

  it('suppresses a handler body for HEAD requests while retaining headers', async () => {
    mockAdapterHandler((_request, response) => {
      response.writeHead(200, {
        'content-length': '7',
        'content-type': 'text/plain',
      });
      response.end('content');
    }, 'postgres://head-test');
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const response = await handlePersistenceRequest(
      new Request('http://localhost/api/persistence/documents/head', {
        method: 'HEAD',
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: () => ({ end: vi.fn() }) as never },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('7');
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(0);
  });

  // Minimal storage mocks for the egress-wiring tests: every store and schema
  // is stubbed, and createStorageHttpHandler only records its options.
  const mockEgressWiring = (handlerOptions: unknown[], connectionString: string) => {
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn((_runtime: unknown, _document: unknown, options: unknown) => {
        handlerOptions.push(options);
        return (
          _request: unknown,
          response: { writeHead: (status: number) => void; end: () => void },
        ) => {
          response.writeHead(204);
          response.end();
        };
      }),
      DEFAULT_SIGNED_URL_TTL_SECONDS: 60,
    }));
    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
  };

  const requestThroughRoute = async () => {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request('http://localhost/api/persistence/runtime/sessions', {
        headers: { authorization: 'Bearer test-token' },
      }),
      { poolFactory: () => ({ end: vi.fn().mockResolvedValue(undefined) }) as never },
    );
  };

  it('opts the asset handler into redirect egress only when ASSET_BYTE_EGRESS=redirect', async () => {
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, 'postgres://egress-redirect-test');
    vi.stubEnv('ASSET_BYTE_EGRESS', ' redirect ');

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    // The grace travels with the mode: enabling indirect egress without
    // declaring the reclamation window it lives inside is not expressible.
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toEqual({
      mode: 'redirect',
      collectionGraceMs: 60 * 60 * 1000,
    });
  });

  it('degrades to direct egress with a warning when the collection grace is too short', async () => {
    // A signed URL must never outlive its object: with the default 60-second
    // lifetime, a grace below ten minutes can collect the object while the
    // URL is still valid. The asset backend is optional, so the
    // misconfiguration falls back to direct bytes instead of failing the
    // shared handler.
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, 'postgres://egress-grace-test');
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', '30000');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ten times'));
    warn.mockRestore();
  });

  it('treats an empty collection grace as unset, like the collector does', async () => {
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, 'postgres://egress-empty-grace-test');
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', '  ');

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toEqual({
      mode: 'redirect',
      collectionGraceMs: 60 * 60 * 1000,
    });
  });

  it('declares the grace the collector itself resolved to the handler', async () => {
    // The handler checks its signed URL lifetime against this number, so it
    // has to be the number the collector actually runs with.
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, 'postgres://egress-shared-grace-test');
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', '7200000');

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toEqual({
      mode: 'redirect',
      collectionGraceMs: 7_200_000,
    });
  });

  it('keeps redirect egress when an invalid grace resolves to the collector default', async () => {
    // durationEnv warns and falls back to one hour for an unparseable value,
    // so the deployment really is running a one-hour grace and redirect egress
    // is safe. Reading the variable a second way here could disagree.
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, 'postgres://egress-invalid-grace-test');
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', 'soon');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toEqual({
      mode: 'redirect',
      collectionGraceMs: 60 * 60 * 1000,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ASSET_COLLECTION_GRACE_MS'));
    warn.mockRestore();
  });

  it.each(['', 'direct'])('keeps byte egress direct for ASSET_BYTE_EGRESS=%j', async (value) => {
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, `postgres://egress-default-${value || 'unset'}-test`);
    vi.stubEnv('ASSET_BYTE_EGRESS', value);

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toBeUndefined();
  });

  it('warns and keeps direct egress for an unrecognized ASSET_BYTE_EGRESS', async () => {
    const handlerOptions: unknown[] = [];
    mockEgressWiring(handlerOptions, 'postgres://egress-bogus-test');
    vi.stubEnv('ASSET_BYTE_EGRESS', 'proxy');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await requestThroughRoute();

    expect(response.status).toBe(204);
    expect((handlerOptions[0] as { byteEgress?: unknown }).byteEgress).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ASSET_BYTE_EGRESS'));
    warn.mockRestore();
  });

  it('forwards byte URL signing through the lazy byte store only when the layer supports it', async () => {
    const assetOptions: unknown[] = [];
    const signReadUrl = vi.fn().mockResolvedValue('https://objects.example/signed');
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {
        constructor(_queryable: unknown, options: unknown) {
          assetOptions.push(options);
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.doMock('@openmaic/storage/asset/s3-bytes', () => ({
      loadS3AssetByteStore: vi.fn().mockResolvedValue({ signReadUrl }),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://egress-signing-forward-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
    vi.stubEnv('ASSET_S3_BUCKET', 'asset-bucket');

    const response = await requestThroughRoute();
    expect(response.status).toBe(204);

    const byteStore = (assetOptions[0] as { byteStore?: unknown }).byteStore as {
      signReadUrl(hash: string, headers: unknown): Promise<unknown>;
    };
    const headers = {
      contentType: 'image/png',
      cacheControl: 'private, no-store',
      expiresInSeconds: 60,
    };
    // The S3 layer signs, and the wrapper forwards hash and headers untouched.
    await expect(byteStore.signReadUrl('sha256-x', headers)).resolves.toBe(
      'https://objects.example/signed',
    );
    expect(signReadUrl).toHaveBeenCalledExactlyOnceWith('sha256-x', headers);
  });

  it('declines byte URL signing when the PostgreSQL byte layer has no signer', async () => {
    const assetOptions: unknown[] = [];
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    // No signReadUrl on the PostgreSQL byte store: the wrapper must answer
    // undefined rather than fail, so the handler falls back to direct bytes.
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {
        read = vi.fn().mockResolvedValue(new Uint8Array([1]));
      },
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {
        constructor(_queryable: unknown, options: unknown) {
          assetOptions.push(options);
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.doMock('@openmaic/storage/server', () => ({
      createStorageHttpHandler: vi.fn(
        () =>
          (
            _request: unknown,
            response: { writeHead: (status: number) => void; end: () => void },
          ) => {
            response.writeHead(204);
            response.end();
          },
      ),
    }));
    vi.stubEnv('DATABASE_URL', 'postgres://egress-signing-decline-test');
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');

    const response = await requestThroughRoute();
    expect(response.status).toBe(204);

    // With no bucket configured the layer is known to be PostgreSQL, so the
    // wrapper does not advertise the method at all: resolveIndirect's
    // feature-detect fails fast instead of taking a lock just to decline.
    const byteStore = (assetOptions[0] as { byteStore?: unknown }).byteStore as {
      signReadUrl?: (hash: string, headers: unknown) => Promise<unknown>;
    };
    expect(byteStore.signReadUrl).toBeUndefined();
  });
});

describe('embedded persistence route -- real handler boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('ASSET_S3_BUCKET', '');
  });

  // The composed path the mocked tests cannot see: the route's Fetch<->Node
  // adapter, the real createStorageHttpHandler, and the egress option wiring,
  // against an in-memory asset store.
  // The route caches its handler per connection string in a process global that
  // survives vi.resetModules, so every test here needs its own.
  function wireRealHandler(
    stores: unknown[],
    signed?: string,
    connectionString = 'postgres://boundary-test',
  ) {
    // Earlier tests register a canned 204 mock for the server module; the
    // point of this test is the real handler, so un-mock it explicitly.
    vi.doUnmock('@openmaic/storage/server');
    vi.doMock('@openmaic/storage/runtime/pg', () => ({
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      PgRuntimeStore: class {},
    }));
    vi.doMock('@openmaic/storage/document/pg', () => ({
      ensureDocumentSchema: vi.fn().mockResolvedValue(undefined),
      PgDocumentStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
      PgAssetByteStore: class {},
    }));
    vi.doMock('@openmaic/storage/asset/pg', () => ({
      ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
      PgAssetStore: class {
        constructor(_queryable: unknown, _options: unknown) {
          stores.push(this);
        }
        private entries = new Map<string, { bytes: Uint8Array; mime: string; revision: number }>();
        async put(principal: { key: string }, data: Blob, meta?: { contentType?: string }) {
          const id = `ast_mem_${this.entries.size + 1}`;
          this.entries.set(`${principal.key}:${id}`, {
            bytes: new Uint8Array(await data.arrayBuffer()),
            mime: meta?.contentType ?? data.type ?? '',
            revision: 1,
          });
          return id;
        }
        async identify(principal: { key: string }, ref: string) {
          const entry = this.entries.get(`${principal.key}:${ref}`);
          return entry
            ? { mime: entry.mime, revision: entry.revision, byteLength: entry.bytes.byteLength }
            : null;
        }
        async resolve(principal: { key: string }, ref: string) {
          const entry = this.entries.get(`${principal.key}:${ref}`);
          return entry ? { bytes: entry.bytes, mime: entry.mime, revision: entry.revision } : null;
        }
        // Present only when the test supplies a URL, mirroring a byte layer
        // that can sign; absent otherwise, which is the PostgreSQL byte column.
        resolveIndirect =
          signed === undefined
            ? undefined
            : async (principal: { key: string }, ref: string) => {
                const entry = this.entries.get(`${principal.key}:${ref}`);
                // An empty URL stands for a layer that declines to sign after
                // all, which must degrade to direct bytes.
                if (entry === undefined) return null;
                return signed === '' ? undefined : { url: signed, revision: entry.revision };
              };
        async remove() {}
        async replace(principal: { key: string }, ref: string, data: Blob) {
          const key = `${principal.key}:${ref}`;
          const entry = this.entries.get(key);
          if (!entry) return 0;
          const revision = entry.revision + 1;
          this.entries.set(key, {
            bytes: new Uint8Array(await data.arrayBuffer()),
            mime: entry.mime,
            revision,
          });
          return revision;
        }
      },
    }));
    vi.doMock('@openmaic/storage/server/reference', () => ({
      nodePostgresTransaction: vi.fn(() => vi.fn()),
    }));
    vi.stubEnv('DATABASE_URL', connectionString);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token');
  }

  const authed = (path: string, extraHeaders: Record<string, string> = {}) =>
    new Request(`http://localhost/api/persistence${path}`, {
      headers: { authorization: 'Bearer test-token', ...extraHeaders },
    });

  it('serves a stored asset through the real handler and route adapter', async () => {
    const stores: Array<{
      put(principal: { key: string }, data: Blob, meta?: { contentType?: string }): Promise<string>;
    }> = [];
    wireRealHandler(stores);
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const deps = { poolFactory: () => ({ end: vi.fn().mockResolvedValue(undefined) }) as never };

    // First request initializes the handler and the store.
    const first = await handlePersistenceRequest(authed('/runtime/sessions'), deps);
    expect(first.status).not.toBe(500);
    const store = stores[0]!;
    const id = await store.put(
      {
        // The dev authenticator issues one shared asset principal for every
        // request, so the stored entry must live under it to be readable.
        key: 'shared',
      },
      new Blob(['real-bytes'], { type: 'text/plain' }),
      {
        contentType: 'image/png',
      },
    );

    const response = await handlePersistenceRequest(
      authed(`/assets/${id}/content`, { 'x-learner-key': 'anon:test' }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-asset-revision')).toBe('1');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('real-bytes');
  });

  // The rest of the egress matrix through the same composed path. Redirect mode
  // has three answers and each is reachable only through real option wiring:
  // the 302 for a consumer that did not ask, the descriptor for one that did,
  // and direct bytes when the byte layer turns out not to sign.
  async function storedAsset(name: string, signed: string | undefined, graceMs = '3600000') {
    const stores: Array<{
      put(principal: { key: string }, data: Blob, meta?: { contentType?: string }): Promise<string>;
    }> = [];
    wireRealHandler(stores, signed, `postgres://boundary-${name}`);
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', graceMs);
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const deps = { poolFactory: () => ({ end: vi.fn().mockResolvedValue(undefined) }) as never };
    const first = await handlePersistenceRequest(authed('/runtime/sessions'), deps);
    expect(first.status).not.toBe(500);
    const id = await stores[0]!.put(
      {
        // The dev authenticator issues one shared asset principal for every
        // request, so the stored entry must live under it to be readable.
        key: 'shared',
      },
      new Blob(['real-bytes'], { type: 'text/plain' }),
      { contentType: 'image/png' },
    );
    return { id, deps, handlePersistenceRequest };
  }

  it('answers a redirect-egress byte GET with a 302 to the signed URL', async () => {
    const { id, deps, handlePersistenceRequest } = await storedAsset(
      'redirect',
      'https://objects.example/signed',
    );

    const response = await handlePersistenceRequest(
      authed(`/assets/${id}/content`, { 'x-learner-key': 'anon:test' }),
      deps,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://objects.example/signed');
    expect(response.headers.get('x-asset-revision')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers a descriptor to a client that asks for one', async () => {
    const { id, deps, handlePersistenceRequest } = await storedAsset(
      'descriptor',
      'https://objects.example/signed',
    );

    const response = await handlePersistenceRequest(
      authed(`/assets/${id}/content`, {
        'x-learner-key': 'anon:test',
        accept: 'application/vnd.openmaic.asset-descriptor+json, */*;q=0.9',
      }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openmaic.asset-descriptor+json',
    );
    expect(await response.json()).toEqual({
      url: 'https://objects.example/signed',
      revision: 1,
    });
  });

  it('serves bytes directly when the byte layer declines to sign', async () => {
    const { id, deps, handlePersistenceRequest } = await storedAsset('unsigned', '');

    const response = await handlePersistenceRequest(
      authed(`/assets/${id}/content`, { 'x-learner-key': 'anon:test' }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('real-bytes');
  });

  it('serves bytes directly when a short grace degraded the configured egress', async () => {
    // The route refused redirect egress at wiring time, so the composed handler
    // never reaches the signer even though this byte layer has one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { id, deps, handlePersistenceRequest } = await storedAsset(
      'shortgrace',
      'https://objects.example/signed',
      '30000',
    );

    const response = await handlePersistenceRequest(
      authed(`/assets/${id}/content`, { 'x-learner-key': 'anon:test' }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('real-bytes');
    warn.mockRestore();
  });
});
