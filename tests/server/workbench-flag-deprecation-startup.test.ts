import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetWorkbenchFlagDeprecationWarningForTests } from '@/lib/server/workbench-flag-deprecation';

// register() starts the background workers. Real ones keep polling the
// database after the file's tests end and log into a closing worker.
vi.mock('@/lib/server/generation/run/runner', () => ({
  startGenerationRunner: () => ({ workerId: 'test', wake: () => {}, stop: async () => {} }),
}));
vi.mock('@/lib/server/materials/extraction', () => ({
  startOwnerMaterialExtractor: () => ({ workerId: 'test', wake: () => {}, stop: async () => {} }),
}));
vi.mock('@/lib/server/legacy-classroom-import', () => ({
  startLegacyClassroomImport: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/persistence/schema-boot-check', () => ({ startSchemaBootCheck: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: vi.fn(),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/server/instance-secret-check', () => ({ warnAboutInstanceSecret: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

const WORKBENCH_FLAG = 'NEXT_PUBLIC_WORKBENCH_ENABLED';
const LEGACY_WORKBENCH_FLAG = 'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED';

beforeEach(() => {
  resetWorkbenchFlagDeprecationWarningForTests();
  vi.stubEnv('LOG_LEVEL', 'warn');
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv(WORKBENCH_FLAG, undefined);
  vi.stubEnv(LEGACY_WORKBENCH_FLAG, undefined);
  // Keep the unrelated startup warnings quiet so only this one can appear.
  vi.stubEnv('ACCESS_CODE', 'long-random-code-for-test');
  // register() refuses to boot without a database; these cases start past it.
  vi.stubEnv('DATABASE_URL', 'postgres://workbench-flag-test/openmaic');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Avoid installing shutdown listeners in the test process.
  vi.spyOn(process, 'once').mockReturnValue(process);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function boot(): Promise<void> {
  const { register } = await import('@/instrumentation');
  await register();
}

describe('deprecated workbench flag startup warning', () => {
  it.each([
    ['only the previous name is set', undefined, 'true'],
    ['the new name is empty', '', 'true'],
    ['the previous name disables the workbench', undefined, 'false'],
  ])('warns once at startup when %s', async (_case, current, previous) => {
    vi.stubEnv(WORKBENCH_FLAG, current);
    vi.stubEnv(LEGACY_WORKBENCH_FLAG, previous);

    await boot();
    await boot();

    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED is deprecated and will be removed in 1.4.0',
      ),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rename it to NEXT_PUBLIC_WORKBENCH_ENABLED'),
    );
  });

  it.each([
    ['only the new name is set', 'true', undefined],
    ['both names are set', 'false', 'true'],
    ['neither name is set', undefined, undefined],
    ['the previous name is empty', undefined, ''],
  ])('does not warn when %s', async (_case, current, previous) => {
    vi.stubEnv(WORKBENCH_FLAG, current);
    vi.stubEnv(LEGACY_WORKBENCH_FLAG, previous);

    await boot();

    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not run on Edge', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv(LEGACY_WORKBENCH_FLAG, 'true');

    await boot();

    expect(console.warn).not.toHaveBeenCalled();
  });

  // The warning must fire exactly when isWorkbenchEnabled takes the fallback.
  it.each([
    [undefined, 'true', true],
    ['', 'true', true],
    ['false', 'true', false],
    ['true', undefined, true],
  ])('agrees with the flag reader (new %j, previous %j)', async (current, previous, enabled) => {
    vi.stubEnv(WORKBENCH_FLAG, current);
    vi.stubEnv(LEGACY_WORKBENCH_FLAG, previous);
    const { isWorkbenchEnabled } = await vi.importActual<
      typeof import('@/lib/config/feature-flags')
    >('@/lib/config/feature-flags');

    await boot();

    expect(isWorkbenchEnabled()).toBe(enabled);
    const fellBack = (current === undefined || current === '') && previous !== undefined;
    expect(vi.mocked(console.warn).mock.calls.length).toBe(fellBack ? 1 : 0);
  });
});
