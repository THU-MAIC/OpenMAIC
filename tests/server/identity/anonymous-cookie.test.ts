import { afterEach, describe, expect, it, vi } from 'vitest';

const cookieJar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  set: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.values.has(name) ? { name, value: cookieJar.values.get(name)! } : undefined,
    set: cookieJar.set,
  }),
}));

import { createAnonymousCookieAuthenticator } from '@/lib/server/identity/anonymous-cookie';
import { OWNER_ROLES, type AuthOutcome } from '@/lib/server/identity/types';
import { resetOwnerAuthenticatorForTests } from '@/lib/server/identity/registry';
import { requireContextOwner, resolveRequestOwner } from '@/lib/server/identity/resolve';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXISTING = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
const COOKIE_SHAPE = /^anonymous_id=[0-9a-f-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/i;

const anonymousCookie = createAnonymousCookieAuthenticator();

function success(outcome: AuthOutcome) {
  if (!outcome.ok) throw new Error('expected a principal');
  return outcome;
}

afterEach(() => {
  vi.unstubAllEnvs();
  cookieJar.values.clear();
  cookieJar.set.mockReset();
  resetOwnerAuthenticatorForTests();
});

describe('anonymousCookie: route requests', () => {
  it('mints a UUID-backed anonymous owner when the cookie is absent', async () => {
    const outcome = success(await anonymousCookie.authenticate(new Request('http://localhost/a')));
    const { principal } = outcome;

    expect(principal.ownerId.startsWith('anon:')).toBe(true);
    expect(principal.ownerId.slice('anon:'.length)).toMatch(UUID_V4);
    expect(principal.kind).toBe('anonymous');
    expect(principal.assurance).toBe('minted');
    expect(outcome.setCookies).toEqual([
      expect.stringContaining(`anonymous_id=${principal.ownerId.slice('anon:'.length)}`),
    ]);
  });

  it('reuses a valid anonymous cookie without returning another cookie', async () => {
    const outcome = success(
      await anonymousCookie.authenticate(
        new Request('http://localhost/a', {
          headers: { cookie: `theme=dark; anonymous_id=${EXISTING}; locale=en` },
        }),
      ),
    );

    expect(outcome.principal.ownerId).toBe(`anon:${EXISTING}`);
    expect(outcome.principal.assurance).toBe('unverified-legacy');
    expect(outcome.setCookies).toBeUndefined();
  });

  it.each([
    ['not a UUID', 'anonymous_id=not-a-uuid'],
    ['a UUID of another version', 'anonymous_id=a652e716-0e2e-17f5-8432-4ee60f6f0977'],
    ['an undecodable value', 'anonymous_id=%E0%A4%A'],
  ])('re-mints, never refuses, a malformed cookie (%s)', async (_label, cookie) => {
    const outcome = await anonymousCookie.authenticate(
      new Request('http://localhost/a', { headers: { cookie } }),
    );

    expect(outcome.ok).toBe(true);
    const { principal, setCookies } = success(outcome);
    expect(principal.assurance).toBe('minted');
    expect(setCookies).toHaveLength(1);
  });

  it('sets a long-lived, HTTP-only, SameSite=Lax cookie at the root path', async () => {
    const { setCookies } = success(
      await anonymousCookie.authenticate(new Request('http://localhost/a')),
    );
    expect(setCookies?.[0]).toMatch(COOKIE_SHAPE);
  });

  it('adds Secure to the cookie in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { setCookies } = success(
      await anonymousCookie.authenticate(new Request('https://example.test/a')),
    );
    expect(setCookies?.[0]).toMatch(/; Secure$/);
  });

  it('omits Secure when COOKIE_SECURE=0', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', '0');
    const { setCookies } = success(
      await anonymousCookie.authenticate(new Request('http://localhost/a')),
    );
    expect(setCookies?.[0]).toMatch(COOKIE_SHAPE);
  });

  it('grants no core role: an anonymous owner may not publish', async () => {
    const { principal } = success(await anonymousCookie.authenticate(new Request('http://x/a')));
    expect(principal.roles.has(OWNER_ROLES.coursePublish)).toBe(false);
    expect(principal.roles.has(OWNER_ROLES.admin)).toBe(false);
  });
});

describe('anonymousCookie: the default seam', () => {
  it('is what resolves a request when nothing is configured', async () => {
    const outcome = success(
      await resolveRequestOwner(
        new Request('http://localhost/a', { headers: { cookie: `anonymous_id=${EXISTING}` } }),
      ),
    );
    expect(outcome.principal.ownerId).toBe(`anon:${EXISTING}`);
  });

  it('carries a minted cookie on a success response', async () => {
    const response = await withRequestOwner(new Request('http://localhost/a'), async (_p, h) =>
      Response.json({ ok: true }, { headers: h }),
    );
    expect(response.headers.get('set-cookie')).toMatch(COOKIE_SHAPE);
  });

  it('carries a minted cookie on an error response the handler builds', async () => {
    const response = await withRequestOwner(new Request('http://localhost/a'), async (_p, h) =>
      Response.json({ error: 'nope' }, { status: 404, headers: h }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toMatch(COOKIE_SHAPE);
  });

  it('carries a minted cookie on the 500 of a handler that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await withRequestOwner(new Request('http://localhost/a'), async () => {
      throw new Error('boom');
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toMatch(COOKIE_SHAPE);
    vi.mocked(console.error).mockRestore();
  });
});

describe('anonymousCookie: Server Actions', () => {
  it('reuses a valid cookie', async () => {
    cookieJar.values.set('anonymous_id', EXISTING);

    await expect(requireContextOwner()).resolves.toMatchObject({
      ownerId: `anon:${EXISTING}`,
      kind: 'anonymous',
    });
    expect(cookieJar.set).not.toHaveBeenCalled();
  });

  it('mints through next/headers with the same attributes as the route cookie', async () => {
    cookieJar.values.set('anonymous_id', 'forged');

    const principal = await requireContextOwner();

    const uuid = principal.ownerId.slice('anon:'.length);
    expect(uuid).toMatch(UUID_V4);
    expect(cookieJar.set).toHaveBeenCalledWith('anonymous_id', uuid, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 2592000,
      secure: false,
    });
  });

  it('marks the Server Action cookie Secure in production unless COOKIE_SECURE=0', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await requireContextOwner();
    expect(cookieJar.set.mock.calls[0][2]).toMatchObject({ secure: true });

    vi.stubEnv('COOKIE_SECURE', '0');
    await requireContextOwner();
    expect(cookieJar.set.mock.calls[1][2]).toMatchObject({ secure: false });
  });

  it('resolves the shared owner instead when one is configured', async () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    cookieJar.values.set('anonymous_id', EXISTING);

    await expect(requireContextOwner()).resolves.toMatchObject({
      ownerId: 'team-alpha',
      kind: 'shared',
    });
    expect(cookieJar.set).not.toHaveBeenCalled();
  });
});
