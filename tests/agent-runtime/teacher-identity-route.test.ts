import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runtimeConfigured: true }));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));

import { GET, POST } from '@/app/api/teacher/identity/route';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';

const ORIGIN = 'http://localhost:3000';
const ID = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
const RECOVERY_CODE = `openmaic-teacher-v1:${ID}`;

function request(method: 'GET' | 'POST', options: { headers?: HeadersInit; body?: string } = {}) {
  const headers = new Headers({
    origin: ORIGIN,
    'content-type': 'application/json',
    ...options.headers,
  });
  return new Request(`${ORIGIN}/api/teacher/identity`, { method, headers, body: options.body });
}

beforeEach(() => {
  mocks.runtimeConfigured = true;
});

describe('teacher identity recovery API', () => {
  it.each(['GET', 'POST'] as const)('gates %s without issuing credentials', async (method) => {
    mocks.runtimeConfigured = false;
    const response = await (method === 'GET' ? GET : POST)(request(method));

    expect(response.status).toBe(404);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('exports a legacy owner recovery code and renews its cookie', async () => {
    const response = await GET(request('GET', { headers: { cookie: `anonymous_id=${ID}` } }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recoveryCode: RECOVERY_CODE });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain(`anonymous_id=${ID};`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=31536000');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('supports browser same-origin GET fetches without an Origin header', async () => {
    const response = await GET(
      new Request(`${ORIGIN}/api/teacher/identity`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.recoveryCode).toMatch(/^openmaic-teacher-v1:[0-9a-f-]{36}$/);
    expect(response.headers.get('set-cookie')).toContain(body.recoveryCode.split(':')[1]);
  });

  it.each(['GET', 'POST'] as const)(
    'rejects cross-origin %s before issuing cookies',
    async (method) => {
      const response = await (method === 'GET' ? GET : POST)(
        request(method, { headers: { origin: 'https://foreign.example' } }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.has('set-cookie')).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'IDENTITY_ORIGIN_INVALID' },
      });
    },
  );

  it.each(['cross-site', 'same-site', 'none'])(
    'rejects GET with fetch metadata %s even if the Origin appears local',
    async (fetchSite) => {
      const response = await GET(request('GET', { headers: { 'sec-fetch-site': fetchSite } }));

      expect(response.status).toBe(403);
      expect(response.headers.has('set-cookie')).toBe(false);
    },
  );

  it('rejects GET without same-origin evidence', async () => {
    const response = await GET(new Request(`${ORIGIN}/api/teacher/identity`));

    expect(response.status).toBe(403);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('requires an Origin header when restoring an identity', async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/teacher/identity`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryCode: RECOVERY_CODE }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('restores the same owner on subsequent requests without echoing its credential', async () => {
    const response = await POST(
      request('POST', {
        headers: { cookie: 'anonymous_id=bf2cb69d-17f6-49f4-977c-015049687d35' },
        body: JSON.stringify({ recoveryCode: RECOVERY_CODE }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ restored: true });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(resolveRequestOwnerId(request('GET', { headers: { cookie } }), new Headers())).toBe(
      `anon:${ID}`,
    );
  });

  it.each(['http', 'https'])(
    'sets the restored cookie for %s using the actual URL',
    async (protocol) => {
      const origin = `${protocol}://teacher.example`;
      const response = await POST(
        new Request(`${origin}/api/teacher/identity`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-forwarded-proto': protocol === 'https' ? 'http' : 'https',
          },
          body: JSON.stringify({ recoveryCode: RECOVERY_CODE }),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')?.includes('Secure')).toBe(protocol === 'https');
    },
  );

  it.each([null, [], {}, { recoveryCode: ID }, { recoveryCode: `${RECOVERY_CODE}; Path=/` }])(
    'rejects invalid recovery input without changing the cookie',
    async (body) => {
      const response = await POST(request('POST', { body: JSON.stringify(body) }));

      expect(response.status).toBe(400);
      expect(response.headers.has('set-cookie')).toBe(false);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'IDENTITY_RECOVERY_INVALID' },
      });
    },
  );

  it('rejects malformed JSON without changing the cookie', async () => {
    const response = await POST(request('POST', { body: '{broken' }));

    expect(response.status).toBe(400);
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('does not accept a form submission as a recovery request', async () => {
    const response = await POST(
      request('POST', {
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ recoveryCode: RECOVERY_CODE }),
      }),
    );

    expect(response.status).toBe(415);
    expect(response.headers.has('set-cookie')).toBe(false);
  });
});
