import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// The real exit wrapper runs with `process.exit` and stderr stubbed, so every
// refusal below is checked all the way to "exit 1 with the original message".
let exit: ReturnType<typeof vi.spyOn>;
let stderr: string[];

beforeEach(() => {
  stderr = [];
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    callback?: () => void,
  ) => {
    stderr.push(String(chunk));
    callback?.();
    return true;
  }) as never);
});

/** The process exited once, non-zero, after one stderr line carrying `message`. */
function expectBootExit(message: RegExp): void {
  expect(exit).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(1);
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toMatch(/^\[boot\] Invalid server configuration; the server will not start: /);
  expect(stderr[0]).toMatch(message);
}

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

    expectBootExit(/PERSISTENCE_SHARED_OWNER_ID/);
  });

  it('fails the register() hook on a shared owner id without ACCESS_CODE', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/ACCESS_CODE/);

    expectBootExit(/ACCESS_CODE/);
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

    expectBootExit(/do not include sharedTeam/);
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

    expectBootExit(/PERSISTENCE_SHARED_OWNER_ID is not set/);
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

    expect(exit).not.toHaveBeenCalled();
    expect(validateOwnerIdentityConfiguration()).toBe('configured');
  });

  it.each(['OWNER_AUTHENTICATOR', 'TRUSTED_PROXY_SECRET', 'TRUSTED_PROXY_USER_HEADER'])(
    'fails the register() hook when the removed %s is set',
    async (variable) => {
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
      vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
      vi.stubEnv(variable, 'anything');
      const { register } = await import('@/instrumentation');

      const refusal = new RegExp(
        `${variable} is set, but the built-in gateway-header authenticator was removed`,
      );
      await expect(register()).rejects.toThrow(refusal);
      expectBootExit(refusal);
    },
  );

  it('ignores a removed variable that is set but blank', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', ' ');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
  });

  it('boots with the default configuration', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
  });

  it('exits on a malformed owner lock wait', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_WRITE_LOCK_WAIT_MS', 'soon');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/OWNER_WRITE_LOCK_WAIT_MS/);
    expectBootExit(/OWNER_WRITE_LOCK_WAIT_MS/);
  });

  it('only warns, and does not exit, when ACCESS_CODE is unset', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    // The warning itself is covered in access-code-startup.test.ts (it prints
    // once per process); here only the absence of an exit matters.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('never validates, or exits, on the Edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    vi.stubEnv('ACCESS_CODE', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
