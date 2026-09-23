import type { NextRequest } from 'next/server';

import type { AuthOutcome, OwnerPrincipal } from '@/lib/server/identity/types';
import { OWNER_ROLES } from '@/lib/server/identity/types';

/**
 * Route tests stub owner resolution with a plain function of the request that
 * returns an owner id and may append `Set-Cookie` values to the headers it is
 * given, exactly like a minting authenticator would. This adapts such a stub to
 * the `@/lib/server/identity/resolve` module, so a test can write
 *
 *   vi.mock('@/lib/server/identity/resolve', async () =>
 *     (await import('../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolveOwnerId),
 *   );
 *
 * and keep asserting on route behavior. An `anon:` id becomes an anonymous
 * principal without roles; any other id a signed-in principal holding
 * `course:publish` — the test-side stand-in for "not anonymous".
 */
export type OwnerIdStub = (req: NextRequest, responseHeaders: Headers) => string;

export function principalForTestOwner(ownerId: string): OwnerPrincipal {
  return ownerId.startsWith('anon:')
    ? { ownerId, kind: 'anonymous', roles: new Set(), assurance: 'unverified-legacy' }
    : {
        ownerId,
        kind: 'user',
        roles: new Set([OWNER_ROLES.coursePublish]),
        assurance: 'verified',
      };
}

export function outcomeFromOwnerIdStub(stub: OwnerIdStub, req: { headers: Headers }): AuthOutcome {
  const headers = new Headers();
  // Route handlers receive a NextRequest; the stubs are typed for it.
  const ownerId = stub(req as NextRequest, headers);
  const setCookies = headers.getSetCookie();
  return {
    ok: true,
    principal: principalForTestOwner(ownerId),
    ...(setCookies.length > 0 ? { setCookies } : {}),
  };
}

export function ownerResolveModule(stub: OwnerIdStub) {
  return {
    resolveRequestOwner: async (req: { headers: Headers }) => outcomeFromOwnerIdStub(stub, req),
  };
}
