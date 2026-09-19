import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetAccessCodeWarningForTests,
  warnIfAccessCodeIsShort,
  warnIfAccessCodeIsUnset,
} from '@/lib/server/access-code-warning';

vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: vi.fn(),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

beforeEach(() => {
  resetAccessCodeWarningForTests();
  vi.stubEnv('LOG_LEVEL', 'warn');
  vi.stubEnv('ACCESS_CODE', undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('missing access-code startup warning', () => {
  it.each([undefined, ''])('warns once when ACCESS_CODE is %j', (code) => {
    warnIfAccessCodeIsUnset(code);
    warnIfAccessCodeIsUnset(code);

    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ACCESS_CODE is not set. The access-code gate is disabled'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('before exposing this server to a network'),
    );
  });

  it.each(['long-random-code-for-test', ' '])(
    'does not warn or disclose a configured code (%j)',
    (code) => {
      // Whitespace is a configured code according to middleware, too.
      warnIfAccessCodeIsUnset(code);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it('does not suppress the independent short-code warning', () => {
    warnIfAccessCodeIsUnset(undefined);
    warnIfAccessCodeIsShort('short-secret');
    warnIfAccessCodeIsShort('short-secret');

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('shorter than 16'));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('short-secret');
  });

  it.each(['0.0.0.0', '::', 'localhost', undefined])(
    'warns during Node startup without relying on HOSTNAME=%j',
    async (hostname) => {
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('HOSTNAME', hostname);
      // Avoid installing shutdown listeners in the test process.
      vi.spyOn(process, 'once').mockReturnValue(process);
      const { register } = await import('@/instrumentation');

      await register();
      await register();

      expect(console.warn).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ACCESS_CODE is not set'));
    },
  );

  it('does not warn at startup when the code is configured', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'long-random-code-for-test');
    vi.spyOn(process, 'once').mockReturnValue(process);
    const { register } = await import('@/instrumentation');

    await register();

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not run the startup warning on Edge', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('@/instrumentation');

    await register();

    expect(console.warn).not.toHaveBeenCalled();
  });
});
