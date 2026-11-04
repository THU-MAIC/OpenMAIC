import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOwnerAuthentication, isPersonalInstallationOwner } from '@/lib/server/identity';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import type { OwnerPrincipal } from '@/lib/server/identity';
const principal: OwnerPrincipal = {
  ownerId: 'local',
  kind: 'user',
  assurance: 'unverified-legacy',
  roles: new Set(),
};
afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
});
describe('personal installation identity seam', () => {
  it('recognizes the configured personal owner without granting other identities an exception', () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'true');
    vi.stubEnv('OWNER_SINGLE_USER_ID', 'local');
    expect(isPersonalInstallationOwner(principal)).toBe(true);
    expect(isPersonalInstallationOwner({ ...principal, ownerId: 'someone-else' })).toBe(false);
    expect(isPersonalInstallationOwner({ ...principal, kind: 'anonymous' })).toBe(false);
    expect(isPersonalInstallationOwner({ ...principal, kind: 'shared' })).toBe(false);
  });
  it('does not infer a personal owner from an id or a disabled switch', () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'false');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    expect(isPersonalInstallationOwner(principal)).toBe(false);
  });
  it('does not bypass host registration using a leftover environment setting', () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'false');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    configureOwnerAuthentication({
      methods: [{ name: 'host', authenticate: async () => ({ status: 'not-applicable' }) }],
    });
    vi.stubEnv('OWNER_SINGLE_USER', 'true');
    expect(isPersonalInstallationOwner(principal)).toBe(false);
  });
});
