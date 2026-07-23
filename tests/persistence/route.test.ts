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
});
