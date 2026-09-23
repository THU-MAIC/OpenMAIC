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

  it('fails the register() hook when trusted-proxy mode has no secret', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
    vi.stubEnv('TRUSTED_PROXY_SECRET', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/requires TRUSTED_PROXY_SECRET/);
  });

  it('fails the register() hook on a trusted-proxy variable without the selector', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', '');
    vi.stubEnv('TRUSTED_PROXY_SECRET', 'x'.repeat(40));
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/OWNER_AUTHENTICATOR/);
  });

  it('boots in trusted-proxy mode without an ACCESS_CODE warning', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
    vi.stubEnv('TRUSTED_PROXY_SECRET', 'x'.repeat(40));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resetAccessCodeWarningForTests } = await import('@/lib/server/access-code-warning');
    resetAccessCodeWarningForTests();
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/ACCESS_CODE/);
  });

  it('boots with the default configuration', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
  });
});
