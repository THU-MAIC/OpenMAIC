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
