import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetOwnerAuthenticatorForTests } from '@/lib/server/identity/registry';

// register() is exercised for its owner-identity validation only.
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: vi.fn(),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOwnerAuthenticatorForTests();
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

  it('boots with the default configuration', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
  });
});
