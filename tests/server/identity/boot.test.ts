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

  it('exits on a startup failure that is not a configuration error, with its stack', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    // A module that cannot be loaded, as when a standalone build misses a chunk.
    vi.resetModules();
    vi.doMock('@/lib/persistence/asset-pending-ttl', () => {
      throw new Error("Cannot find module './chunk-42.js'");
    });
    try {
      const { register } = await import('@/instrumentation');

      // The test runner wraps a failing mock factory; the original error is its cause.
      await expect(register()).rejects.toThrow();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toMatch(/^\[boot\] Server startup failed; the server will not start:\n/);
      expect(stderr[0]).not.toContain('Invalid server configuration');
      expect(stderr[0]).toContain('chunk-42');
      expect(stderr[0]).toMatch(/\n\s+at /);
    } finally {
      vi.doUnmock('@/lib/persistence/asset-pending-ttl');
      vi.resetModules();
    }
  });

  describe('single-user mode', () => {
    let warn: ReturnType<typeof vi.fn>;
    const singleUserWarnings = () =>
      warn.mock.calls.filter((args: unknown[]) => args.join(' ').includes('Single-user mode'))
        .length;

    beforeEach(async () => {
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
      vi.stubEnv('OWNER_SINGLE_USER', 'true');
      vi.stubEnv('OWNER_SINGLE_USER_ID', '');
      vi.stubEnv('OPENMAIC_PUBLISH_ADDRESS', '');
      warn = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(warn as never);
      const { resetSingleUserWarningForTests } = await import('@/lib/server/identity/single-user');
      resetSingleUserWarningForTests();
    });

    it('boots without ACCESS_CODE and warns once', async () => {
      vi.stubEnv('ACCESS_CODE', '');
      const { register } = await import('@/instrumentation');

      await expect(register()).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
      expect(singleUserWarnings()).toBe(1);
    });

    it('boots behind ACCESS_CODE without the single-user warning', async () => {
      vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
      vi.stubEnv('OPENMAIC_PUBLISH_ADDRESS', '0.0.0.0');
      const { register } = await import('@/instrumentation');

      await expect(register()).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
      expect(singleUserWarnings()).toBe(0);
    });

    it('exits on a malformed switch', async () => {
      vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
      vi.stubEnv('OWNER_SINGLE_USER', 'yes');
      const { register } = await import('@/instrumentation');

      await expect(register()).rejects.toThrow(/OWNER_SINGLE_USER must be/);
      expectBootExit(/OWNER_SINGLE_USER must be/);
    });

    it('exits beside PERSISTENCE_SHARED_OWNER_ID', async () => {
      vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
      vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
      const { register } = await import('@/instrumentation');

      await expect(register()).rejects.toThrow(/are both set/);
      expectBootExit(/are both set/);
    });

    it('still exits on a removed identity variable', async () => {
      vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
      vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
      const { register } = await import('@/instrumentation');

      await expect(register()).rejects.toThrow(/OWNER_AUTHENTICATOR is set/);
      expectBootExit(/OWNER_AUTHENTICATOR is set/);
    });
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
