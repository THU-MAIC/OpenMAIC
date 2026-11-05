import { afterEach, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  error: Object.assign(new Error('database upgraded during startup'), {
    name: 'SchemaVersionAheadError',
  }),
  onSchemaRefusal: undefined as unknown as (error: unknown) => Promise<void>,
  stop: vi.fn(async () => {}),
  exit: vi.fn(async () => {}),
  extractionStart: vi.fn(() => ({ stop: async () => {} })),
}));

// register() starts the background workers. Real ones keep polling the
// database after the file's tests end and log into a closing worker.
vi.mock('@/lib/server/pbl-v3/lifecycle-schedule', () => ({
  startLearningLifecycle: vi.fn(),
}));
vi.mock('@/lib/server/pbl-v3/execution-watchdog', () => ({
  startTeachingExecutionWatchdog: vi.fn(),
}));
vi.mock('@/lib/server/sandbox/checkpoint-collector', () => ({
  startCheckpointCollector: vi.fn(),
}));
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
vi.mock('@/lib/persistence/schema-boot-check', () => ({
  startSchemaBootCheck: vi.fn(),
  startRuntimeSchemaMonitor: vi.fn(),
}));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: vi.fn(),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/server/model-config/runtime', () => ({ deploymentConfig: vi.fn() }));
vi.mock('@/lib/server/instance-secret-check', () => ({ warnAboutInstanceSecret: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => true,
  isServerPersistenceConfigured: () => false,
}));

vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  startAgentEventNotifyBus: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/server/agent-runtime/runner', () => ({
  startAgentRunner: (options: { onSchemaRefusal: (error: unknown) => Promise<void> }) => {
    startup.onSchemaRefusal = options.onSchemaRefusal;
    return { stop: startup.stop };
  },
}));
vi.mock('@/lib/server/material-extraction/runner', async () => {
  // The first agent scan can refuse the schema while register is still awaiting
  // the next worker's import. The normal drain must already be callable here.
  await startup.onSchemaRefusal(startup.error);
  return { startMaterialExtractionRunner: startup.extractionStart };
});
vi.mock('@/lib/server/boot-failure', () => ({
  exitOnRuntimeSchemaRefusal: startup.exit,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { end: async () => {} } }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('drains and exits when the first scan refuses the schema before registration completes', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('DATABASE_URL', 'postgres://runtime-schema-test/openmaic');
  vi.stubEnv('ACCESS_CODE', 'long-random-code-for-test');
  vi.spyOn(process, 'once').mockReturnValue(process);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { register } = await import('@/instrumentation');

  await register();

  expect(startup.stop).toHaveBeenCalledOnce();
  expect(startup.exit).toHaveBeenCalledWith(startup.error);
  expect(startup.extractionStart).not.toHaveBeenCalled();
  expect(startup.stop.mock.invocationCallOrder[0]).toBeLessThan(
    startup.exit.mock.invocationCallOrder[0],
  );
  expect(errorLog).not.toHaveBeenCalled();
});
