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
});
