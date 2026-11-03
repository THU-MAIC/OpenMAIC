import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  monitorStart: vi.fn(),
  monitorStop: vi.fn(),
  agentStop: vi.fn(async () => {}),
  materialStop: vi.fn(async () => {}),
  refuse: undefined as unknown as (error: unknown) => Promise<void>,
  agentRefuse: undefined as unknown as (error: unknown) => Promise<void>,
  generationStart: vi.fn(),
  generationStop: vi.fn(async () => {}),
  agentStart: vi.fn(),
  poolEnd: vi.fn(async () => {}),
  exit: vi.fn(async () => {}),
  terminate: undefined as (() => void) | undefined,
}));
vi.mock('@/lib/persistence/schema-boot-check', () => ({
  startSchemaBootCheck: vi.fn(),
  startRuntimeSchemaMonitor: runtime.monitorStart,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { end: runtime.poolEnd } }),
}));
vi.mock('@/lib/server/generation/run/runner', () => ({
  startGenerationRunner: runtime.generationStart,
}));
vi.mock('@/lib/server/agent-runtime/runner', () => ({ startAgentRunner: runtime.agentStart }));
vi.mock('@/lib/server/legacy-classroom-import', () => ({
  startLegacyClassroomImport: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/server/materials/extraction', () => ({
  startOwnerMaterialExtractor: () => ({ stop: runtime.materialStop }),
}));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/server/sandbox/checkpoint-collector', () => ({
  startCheckpointCollector: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/server/pbl-v3/lifecycle-schedule', () => ({
  startLearningLifecycle: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/server/pbl-v3/execution-watchdog', () => ({
  startTeachingExecutionWatchdog: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/server/model-config/runtime', () => ({ deploymentConfig: vi.fn() }));
vi.mock('@/lib/server/instance-secret-check', () => ({ warnAboutInstanceSecret: vi.fn() }));
vi.mock('@/lib/server/material-extraction/runner', () => ({
  startMaterialExtractionRunner: () => ({ stop: async () => {} }),
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  startAgentEventNotifyBus: () => ({ stop: async () => {} }),
  stopAgentEventNotifyBus: async () => {},
}));
vi.mock('@/lib/server/boot-failure', () => ({ exitOnRuntimeSchemaRefusal: runtime.exit }));

import { register } from '@/instrumentation';

let shutdownComplete: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  vi.clearAllMocks();
  shutdownComplete = Promise.withResolvers<void>();
  runtime.poolEnd.mockImplementation(async () => {
    shutdownComplete.resolve();
  });
  runtime.generationStop.mockReset().mockResolvedValue(undefined);
  runtime.materialStop.mockReset().mockResolvedValue(undefined);
  runtime.generationStart.mockReturnValue({ stop: runtime.generationStop });
  runtime.monitorStart.mockImplementation((refuse: typeof runtime.refuse) => {
    runtime.refuse = refuse;
    return { stop: runtime.monitorStop };
  });
  runtime.agentStart.mockImplementation((options: { onSchemaRefusal: typeof runtime.refuse }) => {
    runtime.agentRefuse = options.onSchemaRefusal;
    return { stop: runtime.agentStop };
  });
  runtime.terminate = undefined;
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('DATABASE_URL', 'postgres://runtime-monitor-test/openmaic');
  vi.stubEnv('ACCESS_CODE', 'long-random-code-for-test');
  vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'false');
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') runtime.terminate = listener;
    return process;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  if (runtime.terminate) {
    runtime.terminate();
    await shutdownComplete.promise;
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([undefined, 'false'])(
  'monitors and retires generation and persistence with the agent flag %s',
  async (flag) => {
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', flag);
    await register();
    expect(runtime.generationStart).toHaveBeenCalledOnce();
    expect(runtime.agentStart).not.toHaveBeenCalled();
    expect(runtime.monitorStart).toHaveBeenCalledOnce();
    const error = Object.assign(new Error('database upgraded by a peer'), {
      name: 'SchemaVersionAheadError',
    });
    await runtime.refuse(error);
    expect(runtime.monitorStop).toHaveBeenCalledOnce();
    expect(runtime.generationStop).toHaveBeenCalledOnce();
    expect(runtime.poolEnd).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledWith(error);
    expect(runtime.generationStop.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.poolEnd.mock.invocationCallOrder[0],
    );
    expect(runtime.poolEnd.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.exit.mock.invocationCallOrder[0],
    );
  },
);

it('shares one drain and exit when the process monitor and Agent both refuse the schema', async () => {
  vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
  const draining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  runtime.generationStop.mockImplementationOnce(() => {
    draining.resolve();
    return release.promise;
  });
  try {
    await register();
    expect(runtime.agentStart).toHaveBeenCalledOnce();
    expect(runtime.monitorStart).toHaveBeenCalledOnce();
    const error = Object.assign(new Error('newer database'), { name: 'SchemaVersionAheadError' });
    const processRetirement = runtime.refuse(error);
    const agentRetirement = runtime.agentRefuse(error);
    await draining.promise;
    expect(runtime.exit).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([processRetirement, agentRetirement]);
    expect(runtime.generationStop).toHaveBeenCalledOnce();
    expect(runtime.agentStop).toHaveBeenCalledOnce();
    expect(runtime.poolEnd).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
  }
});

it('stops monitoring before persistence closes on ordinary shutdown', async () => {
  await register();
  runtime.terminate!();
  await shutdownComplete.promise;
  expect(runtime.monitorStop).toHaveBeenCalledOnce();
  expect(runtime.monitorStop.mock.invocationCallOrder[0]).toBeLessThan(
    runtime.poolEnd.mock.invocationCallOrder[0],
  );
  expect(runtime.exit).not.toHaveBeenCalled();
});

it('stops generation from claiming while a busy material worker is still draining', async () => {
  const draining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  runtime.materialStop.mockImplementationOnce(() => {
    draining.resolve();
    return release.promise;
  });
  try {
    await register();
    const retirement = runtime.refuse(
      Object.assign(new Error('schema refusal'), { name: 'SchemaVersionAheadError' }),
    );
    await draining.promise;
    expect(runtime.generationStop).toHaveBeenCalledOnce();
    expect(runtime.poolEnd).not.toHaveBeenCalled();
    release.resolve();
    await retirement;
    expect(runtime.poolEnd).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
  }
});
