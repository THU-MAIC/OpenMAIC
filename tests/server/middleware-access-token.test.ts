import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';
import { ACCESS_TOKEN_MAX_AGE_MS } from '@/lib/server/access-token-shared';

const CODE = 'demo-code-that-is-long-enough';

/** Sign `timestamp` exactly the way the app mints access tokens. */
function tokenFor(timestamp: number): string {
  const raw = String(timestamp);
  const signature = createHmac('sha256', CODE).update(raw).digest('hex');
  return `${raw}.${signature}`;
}

/** An API request carrying (or not) the access cookie. */
function apiRequest(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue !== undefined) {
    headers.set('cookie', `openmaic_access=${cookieValue}`);
  }
  return new NextRequest('http://localhost/api/foo', { method: 'GET', headers });
}

describe('middleware access-token gate', () => {
  beforeEach(() => {
    process.env.ACCESS_CODE = CODE;
  });

  afterEach(() => {
    delete process.env.ACCESS_CODE;
  });

  it('rejects a correctly signed cookie older than the max age', async () => {
    const stale = tokenFor(Date.now() - ACCESS_TOKEN_MAX_AGE_MS - 1000);

    const response = await middleware(apiRequest(stale));

    expect(response.status).toBe(401);
  });

  it('lets a fresh, correctly signed cookie through', async () => {
    const fresh = tokenFor(Date.now());

    const response = await middleware(apiRequest(fresh));

    expect(response.status).not.toBe(401);
  });

  it('rejects an uppercase-hex signature', async () => {
    const [timestamp, signature] = tokenFor(Date.now()).split('.');

    const response = await middleware(apiRequest(`${timestamp}.${signature.toUpperCase()}`));

    expect(response.status).toBe(401);
  });

  it('rejects a missing cookie', async () => {
    const response = await middleware(apiRequest());
    expect(response.status).toBe(401);
  });
});

// The retired classroom chat route has no handler. The access gate still
// answers first; once it lets the request through, Next serves its own 404.
describe('middleware access-token gate for the retired POST /api/chat', () => {
  function legacyChatRequest(cookieValue?: string): NextRequest {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (cookieValue !== undefined) {
      headers.set('cookie', `openmaic_access=${cookieValue}`);
    }
    return new NextRequest('http://localhost/api/chat', { method: 'POST', headers, body: '{}' });
  }

  afterEach(() => {
    delete process.env.ACCESS_CODE;
  });

  it('answers 401 without an access cookie when an access code is set', async () => {
    process.env.ACCESS_CODE = CODE;

    const response = await middleware(legacyChatRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'Access code required' });
  });

  it('lets a valid access cookie through to routing', async () => {
    process.env.ACCESS_CODE = CODE;

    const response = await middleware(legacyChatRequest(tokenFor(Date.now())));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('lets the request through to routing when no access code is set', async () => {
    delete process.env.ACCESS_CODE;

    const response = await middleware(legacyChatRequest());

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('retired provider request headers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['x-api-key', 'x-model', 'x-model-routes', 'x-image-model', 'x-video-provider'])(
    'returns 400 with migration instructions for %s',
    async (name) => {
      vi.stubEnv('ACCESS_CODE', '');
      const request = new NextRequest('http://localhost/api/generate/image', {
        method: 'POST',
        headers: { [name]: 'not-for-the-response' },
      });
      const response = await middleware(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain(name);
      expect(body.error).toContain('#migrating-from-the-legacy-configuration');
      expect(body.error).not.toContain('not-for-the-response');
    },
  );

  it.each(['/api/access-code/verify'])(
    'keeps %s public while rejecting deprecated headers with or without an access code',
    async (path) => {
      for (const code of ['', CODE]) {
        vi.stubEnv('ACCESS_CODE', code);
        const url = new URL(path, 'http://localhost');
        const clean = await middleware(new NextRequest(url));
        expect(clean.headers.get('x-middleware-next')).toBe('1');
        const stale = await middleware(new NextRequest(url, { headers: { 'x-model': 'old' } }));
        expect(stale.status).toBe(400);
        expect((await stale.json()).error).toContain('#migrating-from-the-legacy-configuration');
      }
    },
  );

  it.each(['', CODE])('ignores legacy provider headers on the health probe (%s)', async (code) => {
    vi.stubEnv('ACCESS_CODE', code);
    const request = new NextRequest('http://localhost/api/health', {
      headers: { 'x-api-key': 'old', 'x-model': 'old' },
    });
    expect((await middleware(request)).headers.get('x-middleware-next')).toBe('1');
  });

  it('checks access before reporting deprecated headers on protected routes', async () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    const request = new NextRequest('http://localhost/api/chat/pi', {
      headers: { 'x-model': 'old' },
    });
    expect((await middleware(request)).status).toBe(401);
  });

  it('checks the migration after accepting a valid access cookie', async () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    const request = new NextRequest('http://localhost/api/chat/pi', {
      method: 'POST',
      headers: {
        cookie: `openmaic_access=${tokenFor(Date.now())}`,
        'X-Model': '',
      },
    });
    expect((await middleware(request)).status).toBe(400);
  });
});
