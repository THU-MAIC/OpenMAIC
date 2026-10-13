import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccessToken, createUser, getUser } from '@/lib/pbl/v2/git-bridge/gitea-client';
import type { GiteaConfig } from '@/lib/pbl/v2/git-bridge/types';

const config: GiteaConfig = {
  baseUrl: 'http://gitea.local:3000',
  token: 'admin-token',
  templateFullName: 'goking/arkts-pbl-template',
  webhookSecret: 's',
  adminUser: 'admin',
  adminPassword: 'admin-pass',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getUser', () => {
  it('returns undefined on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'not found' }, 404)),
    );
    await expect(getUser(config, 'stu-x')).resolves.toBeUndefined();
  });

  it('returns the parsed user on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 7, login: 'stu-x', email: 'e' })),
    );
    await expect(getUser(config, 'stu-x')).resolves.toEqual({ id: 7, login: 'stu-x', email: 'e' });
  });
});

describe('createUser', () => {
  it('POSTs to /admin/users with must_change_password false', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 9, login: 'stu-x' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createUser(config, { username: 'stu-x', email: 'stu-x@openmaic.local', password: 'pw' });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toContain('/api/v1/admin/users');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      username: 'stu-x',
      email: 'stu-x@openmaic.local',
      password: 'pw',
      must_change_password: false,
    });
  });
});

describe('createAccessToken', () => {
  it('reads the token from `sha1` and returns it with last-eight', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id: 1, name: 'openmaic-pbl', sha1: 'tok-abc', token_last_eight: 'c' }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAccessToken(config, 'stu-x', 'openmaic-pbl', ['write:repository']);
    expect(result).toEqual({ token: 'tok-abc', lastEight: 'c' });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toContain('/api/v1/users/stu-x/tokens');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'openmaic-pbl',
      scopes: ['write:repository'],
    });
  });

  it('falls back to the `token` field when `sha1` is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ token: 'fallback', token_last_eight: 'ck' }, 201)),
    );
    await expect(createAccessToken(config, 'stu-x', 'n', ['write:repository'])).resolves.toEqual({
      token: 'fallback',
      lastEight: 'ck',
    });
  });

  it('throws when Gitea returns no token value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 1 }, 201)),
    );
    await expect(createAccessToken(config, 'stu-x', 'n', ['write:repository'])).rejects.toThrow(
      /no token/,
    );
  });

  it('throws when admin Basic-auth credentials are missing', async () => {
    const noAdmin = { ...config, adminUser: undefined, adminPassword: undefined };
    await expect(createAccessToken(noAdmin, 'stu-x', 'n', ['write:repository'])).rejects.toThrow(
      /admin Basic-auth credentials/,
    );
  });
});
