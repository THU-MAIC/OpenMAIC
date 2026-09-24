import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import type { OwnerAuthMethod } from '@/lib/server/identity/types';

// register() is exercised for its owner-identity validation only.
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: vi.fn(),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

const notApplicable: OwnerAuthMethod = {
  name: 'host',
  authenticate: async () => ({ status: 'not-applicable' }),
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOwnerAuthenticationForTests();
});

describe('owner identity validation at boot', () => {
  it('fails the instrumentation register() hook on a malformed shared owner id', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'anon:00000000-0000-4000-8000-000000000000');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/PERSISTENCE_SHARED_OWNER_ID/);
  });

  it('fails the register() hook on a shared owner id without ACCESS_CODE', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/ACCESS_CODE/);
  });

  it('fails the register() hook on PERSISTENCE_SHARED_OWNER_ID a host registration ignores', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [notApplicable] });
    // Set after registration, so only boot validation can see it.
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/do not include sharedTeam/);
  });

  it('fails the register() hook on a registered sharedTeam whose variable is unset', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    const { configureOwnerAuthentication, sharedTeamAuthMethod } =
      await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [notApplicable, sharedTeamAuthMethod()] });
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/PERSISTENCE_SHARED_OWNER_ID is not set/);
  });

  it('boots with host methods, and with sharedTeam included last', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    const { configureOwnerAuthentication, sharedTeamAuthMethod } =
      await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [notApplicable, sharedTeamAuthMethod()] });
    const { validateOwnerIdentityConfiguration } = await import('@/lib/server/identity/registry');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(validateOwnerIdentityConfiguration()).toBe('configured');
  });

  it('boots with the default configuration', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
  });
});
