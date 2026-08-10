import type { RequestListener } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('embedded persistence route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
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
});
