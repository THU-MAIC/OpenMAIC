import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import { isDocumentNavigation } from '@/lib/server/identity/navigation';
import { middleware } from '@/middleware';

/**
 * The page request establishes the anonymous owner (middleware.ts,
 * lib/server/identity/navigation.ts): one cookie, minted on the document
 * response with the route handlers' own format and attributes, before the
 * page can send an API request that would mint one of its own.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXISTING = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';

const DOCUMENT_HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
};

function pageRequest(
  path = '/',
  headers: Record<string, string> = {},
  method = 'GET',
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { ...DOCUMENT_HEADERS, ...headers },
  });
}

function mintedId(setCookie: string | null): string {
  const match = /^anonymous_id=([^;]*);/.exec(setCookie ?? '');
  if (!match) throw new Error(`no anonymous cookie in ${String(setCookie)}`);
  return match[1]!;
}

/** The cookie a route handler mints for a request without one. */
async function serverMintedCookie(): Promise<string> {
  const outcome = await resolveRequestOwner(new Request('http://localhost/api/stages'));
  if (!outcome.ok || !outcome.setCookies?.[0]) throw new Error('the server minted nothing');
  return outcome.setCookies[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
});

describe('the page request establishes the anonymous owner', () => {
  it('mints one cookie on a first page load, with the attributes a route handler uses', async () => {
    const response = await middleware(pageRequest());

    const setCookie = response.headers.get('set-cookie');
    const id = mintedId(setCookie);
    expect(id).toMatch(UUID_V4);
    const server = await serverMintedCookie();
    expect(setCookie).toBe(server.replace(mintedId(server), id));
    // The rest of this request (the page render) sees the same owner.
    expect(response.headers.get('x-middleware-request-cookie')).toContain(`anonymous_id=${id}`);
  });

  it('uses the Secure attribute exactly when the route handlers do', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const secure = (await middleware(pageRequest())).headers.get('set-cookie')!;
    expect(secure).toMatch(/; Secure$/);
    const server = await serverMintedCookie();
    expect(secure).toBe(server.replace(mintedId(server), mintedId(secure)));

    vi.stubEnv('COOKIE_SECURE', '0');
    const plain = (await middleware(pageRequest())).headers.get('set-cookie')!;
    expect(plain).not.toMatch(/Secure/);
    const plainServer = await serverMintedCookie();
    expect(plain).toBe(plainServer.replace(mintedId(plainServer), mintedId(plain)));
  });

  it('never replaces a valid anonymous cookie', async () => {
    const response = await middleware(
      pageRequest('/', { cookie: `theme=dark; anonymous_id=${EXISTING}` }),
    );
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-middleware-request-cookie')).toBeNull();
  });

  it('replaces a malformed cookie, as a route handler would, and forwards only the new one', async () => {
    const response = await middleware(
      pageRequest('/classroom/x', { cookie: 'theme=dark; anonymous_id=not-a-uuid; lang=en' }),
    );
    const id = mintedId(response.headers.get('set-cookie'));
    expect(id).toMatch(UUID_V4);
    const forwarded = response.headers.get('x-middleware-request-cookie')!;
    expect(forwarded).toContain(`anonymous_id=${id}`);
    expect(forwarded).not.toContain('not-a-uuid');
    expect(forwarded).toContain('theme=dark');
    expect(forwarded).toContain('lang=en');
  });

  it('mints a different owner for each browser', async () => {
    const first = mintedId((await middleware(pageRequest())).headers.get('set-cookie'));
    const second = mintedId((await middleware(pageRequest())).headers.get('set-cookie'));
    expect(first).not.toBe(second);
  });

  it('mints on a page the access-code modal guards, and nothing on a refused API request', async () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    const page = await middleware(pageRequest());
    expect(mintedId(page.headers.get('set-cookie'))).toMatch(UUID_V4);

    const api = await middleware(new NextRequest('http://localhost/api/stages'));
    expect(api.status).toBe(401);
    expect(api.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['an API request', '/api/stages', {}],
    ['an RSC fetch', '/classroom/x', { rsc: '1', 'sec-fetch-dest': 'empty' }],
    ['a router prefetch', '/classroom/x', { 'next-router-prefetch': '1' }],
    ['a Server Action', '/workbench', { 'next-action': 'abc' }],
    ['a script fetch', '/', { 'sec-fetch-dest': 'empty', accept: '*/*' }],
    ['an image', '/logo.png', { 'sec-fetch-dest': 'image', accept: 'image/*' }],
  ])('does not mint for %s', async (_label, path, headers) => {
    const response = await middleware(pageRequest(path, headers as Record<string, string>));
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not mint for a POST to a page', async () => {
    const response = await middleware(pageRequest('/', {}, 'POST'));
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not mint when single-user mode resolves every request to one owner', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'true');
    const response = await middleware(pageRequest());
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not mint when a shared team owner resolves every request', async () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team');
    const response = await middleware(pageRequest());
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not mint on a configuration the boot refuses', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'maybe');
    const response = await middleware(pageRequest());
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('mints when single-user mode is explicitly off', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'false');
    const response = await middleware(pageRequest());
    expect(mintedId(response.headers.get('set-cookie'))).toMatch(UUID_V4);
  });
});

describe('isDocumentNavigation', () => {
  const request = (headers: Record<string, string>, pathname = '/', method = 'GET') => ({
    method,
    pathname,
    headers: new Headers(headers),
  });

  it('trusts Fetch Metadata when present', () => {
    expect(isDocumentNavigation(request({ 'sec-fetch-dest': 'document' }))).toBe(true);
    expect(isDocumentNavigation(request({ 'sec-fetch-dest': 'iframe', accept: 'text/html' }))).toBe(
      false,
    );
  });

  it('falls back to Accept for a client without Fetch Metadata', () => {
    expect(isDocumentNavigation(request({ accept: 'text/html' }))).toBe(true);
    expect(isDocumentNavigation(request({ accept: 'application/json' }))).toBe(false);
    expect(isDocumentNavigation(request({}))).toBe(false);
  });

  it('never treats an API path as a page', () => {
    expect(isDocumentNavigation(request({ 'sec-fetch-dest': 'document' }, '/api/stages'))).toBe(
      false,
    );
  });
});
