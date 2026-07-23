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
});
