import type { NextRequest } from 'next/server';

import type {
  AuthOutcome,
  OwnerAssurance,
  OwnerPrincipal,
  SubjectKind,
} from '@/lib/server/identity/types';
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
 * and keep asserting on route behavior. A plain `anon:` id becomes an
 * anonymous principal without roles; any other plain id a signed-in principal
 * holding `course:publish` — the test-side stand-in for "not anonymous". A stub
 * that needs something else returns an owner object instead, whose `kind`,
 * `roles` and `assurance` override those defaults.
 */
export interface TestOwner {
  ownerId: string;
  kind?: SubjectKind;
  roles?: Iterable<string>;
  assurance?: OwnerAssurance;
}
export type OwnerIdStub = (req: NextRequest, responseHeaders: Headers) => string | TestOwner;

export function principalForTestOwner(owner: string | TestOwner): OwnerPrincipal {
  const { ownerId, ...overrides } = typeof owner === 'string' ? { ownerId: owner } : owner;
  const defaults: OwnerPrincipal = ownerId.startsWith('anon:')
    ? { ownerId, kind: 'anonymous', roles: new Set(), assurance: 'unverified-legacy' }
    : {
        ownerId,
        kind: 'user',
        roles: new Set([OWNER_ROLES.coursePublish]),
        assurance: 'verified',
      };
  return {
    ...defaults,
    ...(overrides.kind ? { kind: overrides.kind } : {}),
    ...(overrides.roles ? { roles: new Set(overrides.roles) } : {}),
    ...(overrides.assurance ? { assurance: overrides.assurance } : {}),
  };
}

export function outcomeFromOwnerIdStub(stub: OwnerIdStub, req: { headers: Headers }): AuthOutcome {
  const headers = new Headers();
  // Route handlers receive a NextRequest; the stubs are typed for it.
  const owner = stub(req as NextRequest, headers);
  const setCookies = headers.getSetCookie();
  return {
    ok: true,
    principal: principalForTestOwner(owner),
    ...(setCookies.length > 0 ? { setCookies } : {}),
  };
}

export function ownerResolveModule(stub: OwnerIdStub) {
  return {
    resolveRequestOwner: async (req: { headers: Headers }) => outcomeFromOwnerIdStub(stub, req),
  };
}
