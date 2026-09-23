import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAuthenticator, OwnerPrincipal } from '@/lib/server/identity/types';

/**
 * The claim candidate on the principal, and what core knows about a stored
 * owner id: which built-ins set `pendingClaim` and when, the shape check core
 * applies to it, and `principalFromStoredOwner`.
 */

const SECRET = 'pending-claim-secret-0123456789abcdef012345';
const ANON_UUID = '7e2d1b3c-4a5f-4b6e-8c7d-9e0f1a2b3c4d';
const ANON = `anon:${ANON_UUID}`;

function gatewayRequest(cookie?: string): Request {
  return new Request('http://localhost/api/stages', {
    headers: {
      'x-openmaic-proxy-secret': SECRET,
      'x-forwarded-user': 'alice',
      ...(cookie ? { cookie } : {}),
    },
  });
}

async function principalOf(request: Request): Promise<OwnerPrincipal> {
  const { resolveRequestOwner } = await import('@/lib/server/identity/resolve');
  const outcome = await resolveRequestOwner(request);
  if (!outcome.ok) throw new Error('expected a principal');
  return outcome.principal;
}

describe('pendingClaim and stored owners', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', '');
    vi.stubEnv('TRUSTED_PROXY_SECRET', '');
  });

  afterEach(async () => {
    const { resetOwnerAuthenticatorForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticatorForTests();
    vi.unstubAllEnvs();
  });

  describe('trustedProxyHeader', () => {
    beforeEach(() => {
      vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
      vi.stubEnv('TRUSTED_PROXY_SECRET', SECRET);
    });

    it('names the anonymous cookie owner presented beside the gateway user', async () => {
      const principal = await principalOf(gatewayRequest(`theme=dark; anonymous_id=${ANON_UUID}`));
      expect(principal.ownerId).toBe('proxy:alice');
      expect(principal.pendingClaim).toEqual({
        fromOwnerId: ANON,
        assurance: 'unverified-legacy',
      });
    });

    it.each([
      ['no cookie', undefined],
      ['a malformed cookie', 'anonymous_id=not-a-uuid'],
      ['a UUID that is not v4', 'anonymous_id=7e2d1b3c-4a5f-1b6e-8c7d-9e0f1a2b3c4d'],
      ['another cookie only', 'session=abc'],
    ])('sets none with %s', async (_label, cookie) => {
      const principal = await principalOf(gatewayRequest(cookie));
      expect(principal.pendingClaim).toBeUndefined();
    });

    it('describes stored gateway and anonymous ids', async () => {
      const { principalFromStoredOwner } = await import('@/lib/server/identity/stored-owner');
      const user = principalFromStoredOwner('proxy:alice');
      expect(user).toMatchObject({ kind: 'user', assurance: 'unverified-legacy' });
      expect([...user.roles]).toEqual(['course:publish']);
      expect(principalFromStoredOwner(ANON).kind).toBe('anonymous');
      expect(principalFromStoredOwner('proxy:').kind).toBe('user');
    });

    it('drops the anonymous cookie once a claim is spent', async () => {
      const { getOwnerAuthenticator } = await import('@/lib/server/identity/registry');
      expect(getOwnerAuthenticator().clearPendingClaim?.()).toEqual([
        'anonymous_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      ]);
    });
  });

  it('the anonymous built-in never sets one, even with a cookie', async () => {
    const principal = await principalOf(
      new Request('http://localhost/', { headers: { cookie: `anonymous_id=${ANON_UUID}` } }),
    );
    expect(principal).toMatchObject({ ownerId: ANON, kind: 'anonymous' });
    expect(principal.pendingClaim).toBeUndefined();
  });

  it('the shared-team built-in never sets one, and describes its own id', async () => {
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

  it('describes an id no authenticator recognizes as a user with no roles', async () => {
    const { principalFromStoredOwner } = await import('@/lib/server/identity/stored-owner');
    const principal = principalFromStoredOwner('device:kiosk-1');
    expect(principal).toMatchObject({ ownerId: 'device:kiosk-1', kind: 'user' });
    expect(principal.roles.size).toBe(0);
    expect(() => principalFromStoredOwner('has space')).toThrow(/storable/);
  });

  it('asks a configured authenticator to describe stored ids', async () => {
    const { configureOwnerAuthenticator } = await import('@/lib/server/identity/registry');
    configureOwnerAuthenticator({
      name: 'host',
      authenticate: async () => ({ ok: false, status: 401, code: 'INVALID_CREDENTIAL' }),
      describeStoredOwner: (ownerId) =>
        ownerId.startsWith('guest-') ? { kind: 'anonymous' } : { kind: 'device' },
    });
    const { principalFromStoredOwner } = await import('@/lib/server/identity/stored-owner');
    expect(principalFromStoredOwner('guest-1').kind).toBe('anonymous');
    expect(principalFromStoredOwner('tablet-1').kind).toBe('device');
  });

  it.each<[string, Partial<OwnerPrincipal>]>([
    [
      'a pendingClaim on an anonymous principal',
      { kind: 'anonymous', pendingClaim: { fromOwnerId: 'guest-2', assurance: 'minted' } },
    ],
    [
      'a pendingClaim naming the owner itself',
      { pendingClaim: { fromOwnerId: 'user-1', assurance: 'minted' } },
    ],
    [
      'a pendingClaim.fromOwnerId outside',
      { pendingClaim: { fromOwnerId: 'has space', assurance: 'minted' } },
    ],
    [
      'a pendingClaim with an unknown assurance',
      { pendingClaim: { fromOwnerId: 'guest-2', assurance: 'strong' as never } },
    ],
  ])('refuses an authenticator that returns %s', async (problem, override) => {
    const { configureOwnerAuthenticator } = await import('@/lib/server/identity/registry');
    const authenticator: OwnerAuthenticator = {
      name: 'host',
      authenticate: async () => ({
        ok: true,
        principal: {
          ownerId: 'user-1',
          kind: 'user',
          roles: new Set(),
          assurance: 'verified',
          ...override,
        },
      }),
    };
    configureOwnerAuthenticator(authenticator);
    const { resolveRequestOwner } = await import('@/lib/server/identity/resolve');
    await expect(resolveRequestOwner(new Request('http://localhost/'))).rejects.toThrow(problem);
  });

  it('refuses a configured authenticator whose optional hooks are not functions', async () => {
    const { configureOwnerAuthenticator } = await import('@/lib/server/identity/registry');
    expect(() =>
      configureOwnerAuthenticator({
        name: 'host',
        authenticate: async () => ({ ok: false, status: 401, code: 'INVALID_CREDENTIAL' }),
        canonicalize: 'nope' as never,
      }),
    ).toThrow(/canonicalize/);
  });
});
