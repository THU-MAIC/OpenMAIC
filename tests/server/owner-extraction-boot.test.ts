import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// register() is driven for the owner-level extraction runner: it starts with
// the agent runtime, and shutdown waits for it before closing the pool. Every
// other startup step is stubbed.
const runtime = vi.hoisted(() => ({ configured: true }));
const order = vi.hoisted(() => [] as string[]);
const owner = vi.hoisted(() => ({
  start: vi.fn(),
  outcome: { drained: true, running: 0 },
}));
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
  startOwnerExtractionRunner: () => {
    owner.start();
    return {
      stop: async () => {
        // Slower than everything else, so the pool would close first if
        // shutdown did not wait.
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('owner-extraction stopped');
        return owner.outcome;
      },
    };
  },
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: {
      end: async () => {
        order.push('pool ended');
      },
    },
  }),
}));

beforeEach(() => {
  runtime.configured = true;
  order.length = 0;
  owner.start.mockReset();
  owner.outcome = { drained: true, running: 0 };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
  vi.stubEnv('DATABASE_URL', 'postgres://boot/openmaic');
  vi.stubEnv('MATERIALS_POOL_BACKFILL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** register(), with the shutdown it installs for SIGTERM. */
async function boot(): Promise<() => Promise<void>> {
  let onTerm: (() => void) | undefined;
  vi.spyOn(process, 'once').mockImplementation(((signal: string, listener: () => void) => {
    if (signal === 'SIGTERM') onTerm = listener;
    return process;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const { register } = await import('@/instrumentation');
  await register();
  return async () => {
    onTerm!();
    for (let attempt = 0; attempt < 100 && !order.includes('pool ended'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

describe('owner-level extraction at startup and shutdown', () => {
  it('starts with the agent runtime', async () => {
    await boot();
    expect(owner.start).toHaveBeenCalledOnce();
  });

  it('does not start without the agent runtime', async () => {
    runtime.configured = false;
    await boot();
    expect(owner.start).not.toHaveBeenCalled();
  });

  it('closes the pool only after the runner stopped', async () => {
    const shutdown = await boot();
    await shutdown();
    expect(order).toEqual(['owner-extraction stopped', 'pool ended']);
  });

  it('says so when runs were still going, and still shuts down', async () => {
    owner.outcome = { drained: false, running: 2 };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shutdown = await boot();
    await shutdown();
    expect(warn).toHaveBeenCalledWith(
      '[instrumentation] Owner extraction not drained: 2 run(s) still going',
    );
    expect(order).toEqual(['owner-extraction stopped', 'pool ended']);
  });
});
