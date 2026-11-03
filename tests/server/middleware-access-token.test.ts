import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
