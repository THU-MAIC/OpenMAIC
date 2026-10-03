import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// register() is driven for whether it starts the material backfill; every
// other startup step is stubbed.
const runtime = vi.hoisted(() => ({ configured: true }));
const migrateOwnerMaterialsToPool = vi.hoisted(() => vi.fn());
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: () => ({ stop: async () => undefined }),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => runtime.configured,
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  startAgentEventNotifyBus: () => ({ stop: async () => undefined }),
}));
vi.mock('@/lib/server/agent-runtime/runner', () => ({
  startAgentRunner: () => ({ stop: async () => undefined }),
}));
vi.mock('@/lib/server/material-extraction/runner', () => ({
  startMaterialExtractionRunner: () => ({ stop: async () => undefined }),
}));
vi.mock('@/lib/server/material-extraction/owner-extraction', () => ({
  startOwnerExtractionRunner: () => ({ stop: async () => ({ drained: true, running: 0 }) }),
}));
vi.mock('@/lib/server/materials/migrate-to-pool', () => ({ migrateOwnerMaterialsToPool }));

beforeEach(() => {
  runtime.configured = true;
  migrateOwnerMaterialsToPool.mockReset();
  migrateOwnerMaterialsToPool.mockResolvedValue({ scanned: 0 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
  vi.stubEnv('DATABASE_URL', 'postgres://boot/openmaic');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Let the fire-and-forget pass register() starts get to its first call. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the material backfill at startup', () => {
  it('does not run unless an operator turns it on', async () => {
    vi.stubEnv('MATERIALS_POOL_BACKFILL', '');
    const { register } = await import('@/instrumentation');

    await register();
    await settle();

    expect(migrateOwnerMaterialsToPool).not.toHaveBeenCalled();
  });

  it('runs one pass when it is turned on and the agent runtime is configured', async () => {
    vi.stubEnv('MATERIALS_POOL_BACKFILL', '1');
    const { register } = await import('@/instrumentation');

    await register();
    await settle();

    expect(migrateOwnerMaterialsToPool).toHaveBeenCalledOnce();
  });

  it('does not run without the agent runtime, even when turned on', async () => {
    vi.stubEnv('MATERIALS_POOL_BACKFILL', '1');
    runtime.configured = false;
    const { register } = await import('@/instrumentation');

    await register();
    await settle();

    expect(migrateOwnerMaterialsToPool).not.toHaveBeenCalled();
  });

  it('only the exact value 1 turns it on', async () => {
    vi.stubEnv('MATERIALS_POOL_BACKFILL', 'true');
    const { register } = await import('@/instrumentation');

    await register();
    await settle();

    expect(migrateOwnerMaterialsToPool).not.toHaveBeenCalled();
  });

  it('does not let a failed pass fail the start', async () => {
    vi.stubEnv('MATERIALS_POOL_BACKFILL', '1');
    migrateOwnerMaterialsToPool.mockRejectedValue(new Error('database unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    await settle();

    expect(error).toHaveBeenCalledWith('[material-backfill] pass failed', expect.any(Error));
  });
});
