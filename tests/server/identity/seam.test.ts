import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  cookieSet: vi.fn(),
  softDeleteSession: vi.fn(async () => true),
}));
vi.mock('next/headers', () => ({
  headers: async () => mocks.requestHeaders,
  cookies: async () => ({ get: () => undefined, set: mocks.cookieSet }),
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ softDeleteSession: mocks.softDeleteSession }),
}));

import {
  configureOwnerAuthentication,
  OWNER_ROLES,
  sharedTeamAuthMethod,
  type OwnerAuthMethod,
  type OwnerAuthMethodResult,
  type OwnerAuthRequest,
  type OwnerPrincipal,
} from '@/lib/server/identity';
import {
  ownerAuthConfigurationForResolution,
  resetOwnerAuthenticationForTests,
  retiredOwnerClearCookies,
} from '@/lib/server/identity/registry';
import {
  InvalidOwnerCredentialError,
  requireContextOwner,
  resolveRequestOwner,
} from '@/lib/server/identity/resolve';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';

const ANON_UUID = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
const ANON_COOKIE = `anonymous_id=${ANON_UUID}`;

function userPrincipal(ownerId: string): OwnerPrincipal {
  return { ownerId, kind: 'user', roles: new Set(), assurance: 'verified', channel: 'test' };
}

/**
 * A host method in miniature, keyed on one header: absent is `not-applicable`,
 * `bad` is `invalid`, anything else authenticates `<prefix>:<value>`.
 */
function headerMethod(name: string, header: string): OwnerAuthMethod & { calls: number } {
  const method = {
    name,
    calls: 0,
    async authenticate(req: OwnerAuthRequest): Promise<OwnerAuthMethodResult> {
      method.calls += 1;
      const value = req.headers.get(header);
      if (!value) return { status: 'not-applicable' };
      if (value === 'bad') return { status: 'invalid', reason: `bad ${header}` };
      return { status: 'authenticated', principal: userPrincipal(`${name}:${value}`) };
    },
  };
  return method;
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/a', { headers });
}

beforeEach(() => {
  mocks.requestHeaders = new Headers();
  mocks.cookieSet.mockClear();
  mocks.softDeleteSession.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOwnerAuthenticationForTests();
});

describe('configureOwnerAuthentication', () => {
  it('is single-shot', () => {
    configureOwnerAuthentication({ methods: [headerMethod('bearer', 'authorization')] });
    expect(() =>
      configureOwnerAuthentication({ methods: [headerMethod('bearer', 'authorization')] }),
    ).toThrow(/already configured/);
  });

  it('refuses a registration after owner resolution has started', () => {
    ownerAuthConfigurationForResolution();
    expect(() =>
      configureOwnerAuthentication({ methods: [headerMethod('bearer', 'authorization')] }),
    ).toThrow(/after owner resolution/);
  });

  it.each<[string, unknown, RegExp]>([
    ['no options', undefined, /expects/],
    ['methods that are not an array', { methods: 'x' }, /expects/],
    ['an empty method list', { methods: [] }, /at least one method/],
    ['a method without a name', { methods: [{ authenticate: async () => ({}) }] }, /methods\[0\]/],
    ['a method without authenticate', { methods: [{ name: 'x' }] }, /methods\[0\]/],
    [
      'a hook that is not a function',
      { methods: [{ name: 'x', authenticate: async () => ({}), clearCredential: 'no' }] },
      /methods\[0\]/,
    ],
    [
      'two methods of one name',
      {
        methods: [headerMethod('dup', 'a'), headerMethod('dup', 'b')],
      },
      /unique/,
    ],
    ['the fallback name', { methods: [headerMethod('anonymousCookie', 'a')] }, /unique/],
    [
      'a non-boolean fallback',
      { methods: [headerMethod('a', 'a')], anonymousFallback: 'no' },
      /anonymousFallback/,
    ],
  ])('refuses %s', (_label, options, error) => {
    expect(() => configureOwnerAuthentication(options as never)).toThrow(error);
  });

  it('refuses sharedTeam anywhere but last, and without its variable', () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    expect(() =>
      configureOwnerAuthentication({
        methods: [sharedTeamAuthMethod(), headerMethod('bearer', 'authorization')],
      }),
    ).toThrow(/must be the last/);
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    expect(() => configureOwnerAuthentication({ methods: [sharedTeamAuthMethod()] })).toThrow(
      /PERSISTENCE_SHARED_OWNER_ID is not set/,
    );
  });

  it('refuses PERSISTENCE_SHARED_OWNER_ID that the registration would ignore', () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    expect(() =>
      configureOwnerAuthentication({ methods: [headerMethod('bearer', 'authorization')] }),
    ).toThrow(/do not include sharedTeam/);
  });
});

describe('resolution order', () => {
  it('lets the first authenticated method win and asks nothing after it', async () => {
    const first = headerMethod('first', 'x-first');
    const second = headerMethod('second', 'x-second');
    configureOwnerAuthentication({ methods: [first, second] });

    const outcome = await resolveRequestOwner(request({ 'x-first': 'alice', 'x-second': 'bob' }));

    expect(outcome).toMatchObject({ ok: true, principal: { ownerId: 'first:alice' } });
    expect(second.calls).toBe(0);
  });

  it('skips not-applicable methods', async () => {
    const first = headerMethod('first', 'x-first');
    const second = headerMethod('second', 'x-second');
    configureOwnerAuthentication({ methods: [first, second] });

    const outcome = await resolveRequestOwner(request({ 'x-second': 'bob' }));

    expect(outcome).toMatchObject({ ok: true, principal: { ownerId: 'second:bob' } });
    expect(outcome.ok && outcome.setCookies).toBeFalsy();
    expect(first.calls).toBe(1);
  });

  it('refuses an invalid credential at once, even when a later method would match', async () => {
    const first = headerMethod('first', 'x-first');
    const second = headerMethod('second', 'x-second');
    configureOwnerAuthentication({ methods: [first, second] });

    const outcome = await resolveRequestOwner(
      request({ 'x-first': 'bad', 'x-second': 'bob', cookie: ANON_COOKIE }),
    );

    expect(outcome).toEqual({ ok: false, status: 401, code: 'INVALID_CREDENTIAL' });
    expect(second.calls).toBe(0);
  });

  it('falls back to the anonymous cookie when no method applies', async () => {
    configureOwnerAuthentication({ methods: [headerMethod('first', 'x-first')] });

    const existing = await resolveRequestOwner(request({ cookie: ANON_COOKIE }));
    expect(existing).toMatchObject({
      ok: true,
      principal: { ownerId: `anon:${ANON_UUID}`, kind: 'anonymous' },
    });
    expect(existing.ok && existing.principal.pendingClaim).toBeUndefined();

    const minted = await resolveRequestOwner(request());
    expect(minted).toMatchObject({ ok: true, principal: { kind: 'anonymous' } });
    expect(minted.ok && minted.setCookies).toEqual([expect.stringMatching(/^anonymous_id=/)]);
  });

  it('refuses a request no method applies to when the fallback is off', async () => {
    configureOwnerAuthentication({
      methods: [headerMethod('first', 'x-first')],
      anonymousFallback: false,
    });

    await expect(resolveRequestOwner(request({ cookie: ANON_COOKIE }))).resolves.toEqual({
      ok: false,
      status: 401,
      code: 'INVALID_CREDENTIAL',
    });
    await expect(resolveRequestOwner(request({ 'x-first': 'alice' }))).resolves.toMatchObject({
      ok: true,
      principal: { ownerId: 'first:alice' },
    });
  });

  it('with no registration and no environment, resolves every request anonymously', async () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    expect(ownerAuthConfigurationForResolution()).toEqual({
      methods: [],
      anonymousFallback: true,
    });
    const outcome = await resolveRequestOwner(request({ authorization: 'Bearer alice' }));
    expect(outcome).toMatchObject({ ok: true, principal: { kind: 'anonymous' } });
  });

  it('asks sharedTeam after the host methods when the host includes it', async () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    configureOwnerAuthentication({
      methods: [headerMethod('bearer', 'authorization'), sharedTeamAuthMethod()],
    });

    await expect(
      resolveRequestOwner(request({ authorization: 'alice', cookie: ANON_COOKIE })),
    ).resolves.toMatchObject({
      ok: true,
      principal: { ownerId: 'bearer:alice', pendingClaim: { fromOwnerId: `anon:${ANON_UUID}` } },
    });
    const team = await resolveRequestOwner(request({ cookie: ANON_COOKIE }));
    expect(team).toMatchObject({ ok: true, principal: { ownerId: 'team-alpha', kind: 'shared' } });
    expect(team.ok && team.principal.pendingClaim).toBeUndefined();
  });
});

describe('per-request memoization', () => {
  it('authenticates a request once however many times it is resolved', async () => {
    const method = headerMethod('bearer', 'authorization');
    configureOwnerAuthentication({ methods: [method] });
    const req = request({ authorization: 'alice' });

    const [first, second] = await Promise.all([resolveRequestOwner(req), resolveRequestOwner(req)]);
    const third = await resolveRequestOwner(req);

    expect(method.calls).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('mints one anonymous owner per request, not one per resolution', async () => {
    const req = request();
    const first = await resolveRequestOwner(req);
    const second = await resolveRequestOwner(req);

    expect(first.ok && second.ok && second.principal.ownerId).toBe(
      first.ok && first.principal.ownerId,
    );
  });

  it('does not share a resolution between requests', async () => {
    const method = headerMethod('bearer', 'authorization');
    configureOwnerAuthentication({ methods: [method] });

    await resolveRequestOwner(request({ authorization: 'a' }));
    await resolveRequestOwner(request({ authorization: 'b' }));

    expect(method.calls).toBe(2);
  });
});

describe('invalid credentials', () => {
  it('answer 401 and never reach the handler or fall back to an anonymous owner', async () => {
    configureOwnerAuthentication({ methods: [headerMethod('bearer', 'authorization')] });
    const handler = vi.fn(async () => new Response('ok'));

    const response = await withRequestOwner(request({ authorization: 'bad' }), handler);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INVALID_CREDENTIAL', message: 'invalid owner credential' },
    });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('throw from a Server Action instead of acting as someone else', async () => {
    configureOwnerAuthentication({ methods: [headerMethod('bearer', 'authorization')] });
    mocks.requestHeaders = new Headers({ authorization: 'bad', cookie: ANON_COOKIE });

    await expect(requireContextOwner()).rejects.toBeInstanceOf(InvalidOwnerCredentialError);
    await expect(deleteWorkspaceSession('session-1')).rejects.toBeInstanceOf(
      InvalidOwnerCredentialError,
    );
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});

describe('method result checks', () => {
  function returning(result: unknown): OwnerAuthMethod {
    return { name: 'broken', authenticate: async () => result as OwnerAuthMethodResult };
  }
  const authenticated = (principal: unknown) => ({ status: 'authenticated', principal });

  it.each<[string, unknown]>([
    ['no result', undefined],
    ['an unknown status', { status: 'ok' }],
    ['an empty owner id', authenticated({ ...userPrincipal(''), ownerId: '' })],
    ['a whitespace owner id', authenticated(userPrincipal('user 1'))],
    ['an overlong owner id', authenticated(userPrincipal('u'.repeat(257)))],
    ['an unknown kind', authenticated({ ...userPrincipal('u1'), kind: 'teacher' })],
    ['roles that are not a Set', authenticated({ ...userPrincipal('u1'), roles: ['admin'] })],
    ['an unknown assurance', authenticated({ ...userPrincipal('u1'), assurance: 'trusted' })],
    [
      'a pendingClaim of its own',
      authenticated({
        ...userPrincipal('u1'),
        pendingClaim: { fromOwnerId: 'guest-1', assurance: 'minted' },
      }),
    ],
    [
      'setCookies that are not strings',
      { status: 'authenticated', principal: userPrincipal('u1'), setCookies: [1] },
    ],
  ])('turn %s into a server error, not a stored id', async (_label, result) => {
    configureOwnerAuthentication({ methods: [returning(result)] });
    await expect(resolveRequestOwner(request())).rejects.toThrow(
      /Owner auth method broken returned/,
    );
  });
});

describe('Server Actions', () => {
  it('ask the methods in the same order, through authenticate() with the request headers', async () => {
    const first = headerMethod('first', 'x-first');
    const second = headerMethod('second', 'x-second');
    configureOwnerAuthentication({ methods: [first, second] });
    mocks.requestHeaders = new Headers({ 'x-second': 'carol' });

    await expect(deleteWorkspaceSession(' session-1 ')).resolves.toEqual({ deleted: true });
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-1', 'second:carol');
    expect(first.calls).toBe(1);
  });

  it('prefer authenticateFromContext when a method has one', async () => {
    configureOwnerAuthentication({
      methods: [
        {
          name: 'context',
          authenticate: async () => ({ status: 'invalid' }),
          authenticateFromContext: async () => ({
            status: 'authenticated',
            principal: userPrincipal('user:ctx'),
          }),
        },
      ],
    });

    await deleteWorkspaceSession('session-2');
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-2', 'user:ctx');
  });

  it('fall back to the anonymous cookie, minted through next/headers', async () => {
    configureOwnerAuthentication({ methods: [headerMethod('first', 'x-first')] });

    const principal = await requireContextOwner();

    expect(principal.kind).toBe('anonymous');
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      'anonymous_id',
      principal.ownerId.slice('anon:'.length),
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('refuse with the fallback off when no method applies', async () => {
    configureOwnerAuthentication({
      methods: [headerMethod('first', 'x-first')],
      anonymousFallback: false,
    });
    await expect(requireContextOwner()).rejects.toBeInstanceOf(InvalidOwnerCredentialError);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('refuse a cookie minted without authenticateFromContext', async () => {
    configureOwnerAuthentication({
      methods: [
        {
          name: 'minting',
          authenticate: async () => ({
            status: 'authenticated',
            principal: userPrincipal('user:m'),
            setCookies: ['session=1'],
          }),
        },
      ],
    });

    await expect(requireContextOwner()).rejects.toThrow(
      /minting returned setCookies in a Server Action/,
    );
    await expect(deleteWorkspaceSession('session-3')).rejects.toThrow(/setCookies/);
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
  });
});

describe('retired credentials', () => {
  it('clear the anonymous cookie, plus any method that declares clearCredential', () => {
    const cleared = 'guest_session=; Path=/; Max-Age=0';
    configureOwnerAuthentication({
      methods: [
        headerMethod('bearer', 'authorization'),
        { ...headerMethod('guest', 'x-guest'), clearCredential: () => [cleared] },
      ],
    });
    expect(retiredOwnerClearCookies()).toEqual([
      'anonymous_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      cleared,
    ]);
  });
});

describe('core roles', () => {
  it('are the documented vocabulary', () => {
    expect(OWNER_ROLES).toEqual({ coursePublish: 'course:publish', admin: 'admin' });
  });
});
