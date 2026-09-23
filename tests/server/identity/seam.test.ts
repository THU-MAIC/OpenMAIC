import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  softDeleteSession: vi.fn(async () => true),
}));
vi.mock('next/headers', () => ({
  headers: async () => mocks.requestHeaders,
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ softDeleteSession: mocks.softDeleteSession }),
}));

import {
  configureOwnerAuthenticator,
  getOwnerAuthenticator,
  OWNER_ROLES,
  type AuthOutcome,
  type OwnerAuthenticator,
  type OwnerPrincipal,
} from '@/lib/server/identity';
import { resetOwnerAuthenticatorForTests } from '@/lib/server/identity/registry';
import {
  InvalidOwnerCredentialError,
  requireContextOwner,
  resolveRequestOwner,
} from '@/lib/server/identity/resolve';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';

const INVALID: AuthOutcome = { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };

function userPrincipal(ownerId: string): OwnerPrincipal {
  return { ownerId, kind: 'user', roles: new Set(), assurance: 'verified', channel: 'test' };
}

/**
 * A host authenticator in miniature: `authorization: Bearer <user>` is a user,
 * `Bearer bad` is an invalid credential, and no header is refused too (this
 * host admits no anonymous visitors).
 */
function bearerAuthenticator(): OwnerAuthenticator & { calls: number } {
  const authenticator = {
    name: 'test-bearer',
    calls: 0,
    async authenticate(req: { headers: Headers }): Promise<AuthOutcome> {
      authenticator.calls += 1;
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
      if (!token || token === 'bad') return INVALID;
      return { ok: true, principal: userPrincipal(`user:${token}`) };
    },
  };
  return authenticator;
}

beforeEach(() => {
  mocks.requestHeaders = new Headers();
  mocks.softDeleteSession.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOwnerAuthenticatorForTests();
});

describe('configureOwnerAuthenticator', () => {
  it('replaces the built-ins for every later resolution', async () => {
    configureOwnerAuthenticator(bearerAuthenticator());

    const outcome = await resolveRequestOwner(
      new Request('http://localhost/a', {
        headers: {
          authorization: 'Bearer alice',
          cookie: 'anonymous_id=a652e716-0e2e-47f5-8432-4ee60f6f0977',
        },
      }),
    );

    expect(outcome).toMatchObject({ ok: true, principal: { ownerId: 'user:alice' } });
    expect(outcome.ok && outcome.setCookies).toBeFalsy();
  });

  it('is single-shot', () => {
    configureOwnerAuthenticator(bearerAuthenticator());
    expect(() => configureOwnerAuthenticator(bearerAuthenticator())).toThrow(/already configured/);
  });

  it('refuses a registration after owner resolution has started', () => {
    getOwnerAuthenticator();
    expect(() => configureOwnerAuthenticator(bearerAuthenticator())).toThrow(/after owner/);
  });

  it('refuses something that is not an authenticator', () => {
    expect(() => configureOwnerAuthenticator({} as OwnerAuthenticator)).toThrow(/expects/);
    expect(() =>
      configureOwnerAuthenticator({
        name: 'x',
        authenticate: 'no' as unknown as OwnerAuthenticator['authenticate'],
      }),
    ).toThrow(/expects/);
  });

  it('refuses to be combined with PERSISTENCE_SHARED_OWNER_ID', () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    expect(() => configureOwnerAuthenticator(bearerAuthenticator())).toThrow(
      /PERSISTENCE_SHARED_OWNER_ID/,
    );
  });
});

describe('per-request memoization', () => {
  it('authenticates a request once however many times it is resolved', async () => {
    const authenticator = bearerAuthenticator();
    configureOwnerAuthenticator(authenticator);
    const request = new Request('http://localhost/a', {
      headers: { authorization: 'Bearer alice' },
    });

    const [first, second] = await Promise.all([
      resolveRequestOwner(request),
      resolveRequestOwner(request),
    ]);
    const third = await resolveRequestOwner(request);

    expect(authenticator.calls).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('mints one anonymous owner per request, not one per resolution', async () => {
    const request = new Request('http://localhost/a');
    const first = await resolveRequestOwner(request);
    const second = await resolveRequestOwner(request);

    expect(first.ok && second.ok && second.principal.ownerId).toBe(
      first.ok && first.principal.ownerId,
    );
  });

  it('does not share a resolution between requests', async () => {
    const authenticator = bearerAuthenticator();
    configureOwnerAuthenticator(authenticator);

    await resolveRequestOwner(
      new Request('http://localhost/a', { headers: { authorization: 'Bearer a' } }),
    );
    await resolveRequestOwner(
      new Request('http://localhost/a', { headers: { authorization: 'Bearer b' } }),
    );

    expect(authenticator.calls).toBe(2);
  });
});

describe('invalid credentials', () => {
  it('answer 401 and never reach the handler or fall back to an anonymous owner', async () => {
    configureOwnerAuthenticator(bearerAuthenticator());
    const handler = vi.fn(async () => new Response('ok'));

    const response = await withRequestOwner(
      new Request('http://localhost/a', { headers: { authorization: 'Bearer bad' } }),
      handler,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INVALID_CREDENTIAL', message: 'invalid owner credential' },
    });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('throw from a Server Action instead of acting as someone else', async () => {
    configureOwnerAuthenticator(bearerAuthenticator());
    mocks.requestHeaders = new Headers({ authorization: 'Bearer bad' });

    await expect(requireContextOwner()).rejects.toBeInstanceOf(InvalidOwnerCredentialError);
    await expect(deleteWorkspaceSession('session-1')).rejects.toBeInstanceOf(
      InvalidOwnerCredentialError,
    );
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
  });
});

describe('principal checks', () => {
  function returning(principal: unknown): OwnerAuthenticator {
    return {
      name: 'broken',
      authenticate: async () => ({ ok: true, principal }) as AuthOutcome,
    };
  }

  it.each([
    ['an empty owner id', { ...userPrincipal(''), ownerId: '' }],
    ['a whitespace owner id', userPrincipal('user 1')],
    ['an overlong owner id', userPrincipal('u'.repeat(257))],
    ['an unknown kind', { ...userPrincipal('u1'), kind: 'teacher' }],
    ['roles that are not a Set', { ...userPrincipal('u1'), roles: ['admin'] }],
    ['an unknown assurance', { ...userPrincipal('u1'), assurance: 'trusted' }],
  ])('turn %s into a server error, not a stored id', async (_label, principal) => {
    configureOwnerAuthenticator(returning(principal));
    await expect(resolveRequestOwner(new Request('http://localhost/a'))).rejects.toThrow(
      /Owner authenticator broken returned/,
    );
  });
});

describe('Server Actions through a configured authenticator', () => {
  it('fall back to authenticate() with the request headers', async () => {
    configureOwnerAuthenticator(bearerAuthenticator());
    mocks.requestHeaders = new Headers({ authorization: 'Bearer carol' });

    await expect(deleteWorkspaceSession(' session-1 ')).resolves.toEqual({ deleted: true });
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-1', 'user:carol');
  });

  it('prefer authenticateFromContext when the authenticator has one', async () => {
    configureOwnerAuthenticator({
      name: 'context',
      authenticate: async () => INVALID,
      authenticateFromContext: async () => ({ ok: true, principal: userPrincipal('user:ctx') }),
    });

    await deleteWorkspaceSession('session-2');
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-2', 'user:ctx');
  });

  it('refuse a cookie minted without authenticateFromContext', async () => {
    configureOwnerAuthenticator({
      name: 'minting',
      authenticate: async () => ({
        ok: true,
        principal: userPrincipal('user:m'),
        setCookies: ['session=1'],
      }),
    });

    await expect(requireContextOwner()).rejects.toThrow(/authenticateFromContext/);
  });

  it('refuse setCookies returned from authenticateFromContext too', async () => {
    configureOwnerAuthenticator({
      name: 'context-minting',
      authenticate: async () => INVALID,
      authenticateFromContext: async () => ({
        ok: true,
        principal: userPrincipal('user:m'),
        setCookies: ['session=1'],
      }),
    });

    await expect(requireContextOwner()).rejects.toThrow(
      /context-minting returned setCookies in a Server Action/,
    );
    await expect(deleteWorkspaceSession('session-3')).rejects.toThrow(/setCookies/);
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
  });
});

describe('core roles', () => {
  it('are the documented vocabulary', () => {
    expect(OWNER_ROLES).toEqual({ coursePublish: 'course:publish', admin: 'admin' });
  });
});
