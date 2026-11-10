import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ config: vi.fn(async () => ({})), get: vi.fn() }));
vi.mock('@/lib/server/sandbox/settings', () => ({ resolvedSandboxConfig: mocks.config }));
vi.mock('@/lib/server/sandbox/store', () => ({
  SandboxStore: { open: vi.fn(async () => ({ get: mocks.get })) },
  publicEnvironment: (row: unknown) => row,
}));
vi.mock('@/lib/server/sandbox/providers/e2b-compatible', () => ({
  E2BCompatibleSandboxProvider: class {},
}));
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore } from '@/lib/server/sandbox/store';
import { SandboxError, sandboxNotFound } from '@/lib/sandbox/errors';
import type { OwnerPrincipal } from '@/lib/server/identity';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
const principal: OwnerPrincipal = {
  ownerId: 'remote',
  kind: 'user',
  assurance: 'verified',
  roles: new Set(),
};
const ID = '00000000-0000-4000-8000-000000000001';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetOwnerAuthenticationForTests();
});
describe('sandbox access', () => {
  it('admits every owner principal the deployment resolves, without any role', async () => {
    vi.stubEnv('OWNER_SINGLE_USER', 'false');
    vi.stubEnv('OWNER_SINGLE_USER_ID', '');
    for (const p of [
      principal,
      { ...principal, kind: 'service' as const },
      { ...principal, kind: 'anonymous' as const, assurance: 'unverified-legacy' as const },
      { ...principal, kind: 'shared' as const },
      { ...principal, assurance: 'unverified-legacy' as const },
    ]) {
      await expect(SandboxService.forOwner(p)).resolves.toBeInstanceOf(SandboxService);
    }
  });
  it('admits the personal installation owner and other owners alike', async () => {
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
    ).resolves.toBeInstanceOf(SandboxService);
  });
  it('still refuses every owner while the installation has sandboxes disabled', async () => {
    mocks.config.mockRejectedValueOnce(
      new SandboxError('SANDBOX_DISABLED', 503, 'Sandbox provider is not configured.'),
    );
    await expect(
      SandboxService.forOwner({ ...principal, kind: 'anonymous' }),
    ).rejects.toMatchObject({ code: 'SANDBOX_DISABLED', status: 503 });
    expect(SandboxStore.open).not.toHaveBeenCalled();
  });
  it('scopes every lookup to the calling owner, so another owner sees not found', async () => {
    mocks.get.mockImplementation(async (ownerId: string, id: string) => {
      if (ownerId === 'owner-a' && id === ID) return { id, ownerId };
      throw sandboxNotFound();
    });
    const owner = await SandboxService.forOwner({ ...principal, ownerId: 'owner-a' });
    await expect(owner.get(ID)).resolves.toMatchObject({ id: ID });
    for (const kind of ['anonymous', 'shared', 'user'] as const) {
      const other = await SandboxService.forOwner({ ...principal, kind, ownerId: 'owner-b' });
      await expect(other.get(ID)).rejects.toMatchObject({ status: 404 });
    }
    expect(mocks.get.mock.calls.map(([ownerId]) => ownerId)).toEqual([
      'owner-a',
      'owner-b',
      'owner-b',
      'owner-b',
    ]);
  });
});
