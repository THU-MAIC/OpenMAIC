import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/sandbox/settings', () => ({ resolvedSandboxConfig: async () => ({}) }));
vi.mock('@/lib/server/sandbox/store', () => ({ SandboxStore: { open: vi.fn(async () => ({})) } }));
vi.mock('@/lib/server/sandbox/providers/e2b-compatible', () => ({
  E2BCompatibleSandboxProvider: class {},
}));
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore } from '@/lib/server/sandbox/store';
import type { OwnerPrincipal } from '@/lib/server/identity';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
const principal: OwnerPrincipal = {
  ownerId: 'remote',
  kind: 'user',
  assurance: 'verified',
  roles: new Set(['sandbox:use']),
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetOwnerAuthenticationForTests();
});
describe('sandbox authorization before provider or database access', () => {
  it('allows explicitly privileged verified users and services', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'false');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    await expect(SandboxService.forOwner(principal)).resolves.toBeInstanceOf(SandboxService);
    await expect(
      SandboxService.forOwner({ ...principal, kind: 'service' }),
    ).resolves.toBeInstanceOf(SandboxService);
  });
  it('rejects anonymous, shared, unverified and unprivileged remote principals', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'false');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    for (const p of [
      { ...principal, kind: 'anonymous' as const },
      { ...principal, kind: 'shared' as const },
      { ...principal, assurance: 'unverified-legacy' as const },
      { ...principal, roles: new Set<string>() },
    ]) {
      await expect(SandboxService.forOwner(p)).rejects.toMatchObject({ code: 'SANDBOX_FORBIDDEN' });
    }
    expect(SandboxStore.open).not.toHaveBeenCalled();
  });
  it('preserves personal installations without promoting another owner', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'true');
    vi.stubEnv('OWNER_SINGLE_USER_ID', 'local');
    await expect(
      SandboxService.forOwner({
        ownerId: 'local',
        kind: 'user',
        assurance: 'unverified-legacy',
        roles: new Set(),
      }),
    ).resolves.toBeInstanceOf(SandboxService);
    await expect(
      SandboxService.forOwner({ ...principal, assurance: 'unverified-legacy' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
