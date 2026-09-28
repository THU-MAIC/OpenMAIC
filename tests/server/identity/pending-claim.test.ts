import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestHeaders: new Headers() }));
vi.mock('next/headers', () => ({
  headers: async () => mocks.requestHeaders,
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));

import type {
  OwnerAuthMethod,
  OwnerAuthRequest,
  OwnerPrincipal,
} from '@/lib/server/identity/types';

/**
 * The claim candidate core attaches to a principal, and what core knows about
 * a stored owner id: when `pendingClaim` is set and when it is not, and
 * `principalFromStoredOwner` across the methods.
 */

const ANON_UUID = '7e2d1b3c-4a5f-4b6e-8c7d-9e0f1a2b3c4d';
const ANON = `anon:${ANON_UUID}`;

/** `x-session: <user>` signs `user:<user>` in; `x-session: guest-<n>` is the host's own anonymous visitor. */
const sessionMethod: OwnerAuthMethod = {
  name: 'session',
  authenticate: async (req: OwnerAuthRequest) => {
    const user = req.headers.get('x-session');
    if (!user) return { status: 'not-applicable' };
    const principal: OwnerPrincipal = user.startsWith('guest-')
      ? { ownerId: user, kind: 'anonymous', roles: new Set(), assurance: 'minted' }
      : { ownerId: `user:${user}`, kind: 'user', roles: new Set(), assurance: 'verified' };
    return { status: 'authenticated', principal };
  },
  describeStoredOwner: (ownerId) =>
    ownerId.startsWith('guest-')
      ? { kind: 'anonymous' }
      : ownerId.startsWith('user:')
        ? { kind: 'user', roles: new Set(['course:publish']) }
        : undefined,
};

function sessionRequest(cookie?: string, user = 'alice'): Request {
  return new Request('http://localhost/api/stages', {
    headers: { 'x-session': user, ...(cookie ? { cookie } : {}) },
  });
}

async function principalOf(request: Request): Promise<OwnerPrincipal> {
  const { resolveRequestOwner } = await import('@/lib/server/identity/resolve');
  const outcome = await resolveRequestOwner(request);
  if (!outcome.ok) throw new Error('expected a principal');
  return outcome.principal;
}

async function register(anonymousFallback?: boolean): Promise<void> {
  const { configureOwnerAuthentication } = await import('@/lib/server/identity/registry');
  configureOwnerAuthentication({ methods: [sessionMethod], anonymousFallback });
}

describe('pendingClaim and stored owners', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    mocks.requestHeaders = new Headers();
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    vi.unstubAllEnvs();
  });

  describe('a host method', () => {
    it('gets the anonymous cookie owner presented beside it as the claim candidate', async () => {
      await register();
      const principal = await principalOf(sessionRequest(`theme=dark; anonymous_id=${ANON_UUID}`));
      expect(principal.ownerId).toBe('user:alice');
      expect(principal.pendingClaim).toEqual({
        fromOwnerId: ANON,
        assurance: 'unverified-legacy',
      });
    });

    it('gets one with the anonymous fallback off too: earlier anonymous work stays claimable', async () => {
      await register(false);
      const principal = await principalOf(sessionRequest(`anonymous_id=${ANON_UUID}`));
      expect(principal.pendingClaim?.fromOwnerId).toBe(ANON);
    });

    it('gets one in a Server Action', async () => {
      await register();
      mocks.requestHeaders = new Headers({
        'x-session': 'alice',
        cookie: `anonymous_id=${ANON_UUID}`,
      });
      const { requireContextOwner } = await import('@/lib/server/identity/resolve');
      await expect(requireContextOwner()).resolves.toMatchObject({
        ownerId: 'user:alice',
        pendingClaim: { fromOwnerId: ANON },
      });
    });

    it.each([
      ['no cookie', undefined],
      ['a malformed cookie', 'anonymous_id=not-a-uuid'],
      ['a UUID that is not v4', 'anonymous_id=7e2d1b3c-4a5f-1b6e-8c7d-9e0f1a2b3c4d'],
      ['another cookie only', 'session=abc'],
    ])('gets none with %s', async (_label, cookie) => {
      await register();
      const principal = await principalOf(sessionRequest(cookie));
      expect(principal.pendingClaim).toBeUndefined();
    });

    it('gets none for an anonymous principal of its own', async () => {
      await register();
      const principal = await principalOf(sessionRequest(`anonymous_id=${ANON_UUID}`, 'guest-1'));
      expect(principal).toMatchObject({ ownerId: 'guest-1', kind: 'anonymous' });
      expect(principal.pendingClaim).toBeUndefined();
    });

    it('describes stored ids after the anonymous cookie method', async () => {
      await register();
      const { principalFromStoredOwner } = await import('@/lib/server/identity/stored-owner');
      const user = principalFromStoredOwner('user:alice');
      expect(user).toMatchObject({ kind: 'user', assurance: 'unverified-legacy' });
      expect([...user.roles]).toEqual(['course:publish']);
      expect(principalFromStoredOwner('guest-1').kind).toBe('anonymous');
      expect(principalFromStoredOwner(ANON).kind).toBe('anonymous');
      expect(principalFromStoredOwner('tablet-1').kind).toBe('user');
    });

    it('drops the anonymous cookie once a claim is spent', async () => {
      await register();
      const { pendingClaimClearCookies } = await import('@/lib/server/identity/registry');
      expect(pendingClaimClearCookies()).toEqual([
        'anonymous_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      ]);
    });
  });

  it('the anonymous fallback never gets one, even with a cookie', async () => {
    const principal = await principalOf(
      new Request('http://localhost/', { headers: { cookie: `anonymous_id=${ANON_UUID}` } }),
    );
    expect(principal).toMatchObject({ ownerId: ANON, kind: 'anonymous' });
    expect(principal.pendingClaim).toBeUndefined();
  });

  it('the shared-team built-in never gets one, and describes its own id', async () => {
    vi.stubEnv('ACCESS_CODE', 'team-code');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team');
    const principal = await principalOf(
      new Request('http://localhost/', { headers: { cookie: `anonymous_id=${ANON_UUID}` } }),
    );
    expect(principal).toMatchObject({ ownerId: 'team', kind: 'shared' });
    expect(principal.pendingClaim).toBeUndefined();
    const { principalFromStoredOwner } = await import('@/lib/server/identity/stored-owner');
    expect(principalFromStoredOwner('team').kind).toBe('shared');
    // Anonymous ids minted before the switch are still anonymous owners.
    expect(principalFromStoredOwner(ANON).kind).toBe('anonymous');
  });

  it('describes an id no method recognizes as a user with no roles', async () => {
    const { principalFromStoredOwner } = await import('@/lib/server/identity/stored-owner');
    const principal = principalFromStoredOwner('device:kiosk-1');
    expect(principal).toMatchObject({ ownerId: 'device:kiosk-1', kind: 'user' });
    expect(principal.roles.size).toBe(0);
    expect(() => principalFromStoredOwner('has space')).toThrow(/storable/);
  });
});
