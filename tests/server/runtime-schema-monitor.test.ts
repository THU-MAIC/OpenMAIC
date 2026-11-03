import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  monitorStart: vi.fn(),
  monitorStop: vi.fn(),
  agentStop: vi.fn(async () => {}),
  materialStop: vi.fn(async () => {}),
  checkpointStop: vi.fn(async () => {}),
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
  startCheckpointCollector: () => ({ stop: runtime.checkpointStop }),
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
  runtime.checkpointStop.mockReset().mockResolvedValue(undefined);
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
  vi.useRealTimers();
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

it.each(['SchemaVersionAheadError', 'SchemaMigrationChecksumError'])(
  'exits within the retirement deadline when pool shutdown never settles (%s)',
  async (name) => {
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    runtime.poolEnd.mockImplementationOnce(async () => {
      closing.resolve();
      await release.promise;
      shutdownComplete.resolve();
    });
    await register();
    vi.useFakeTimers();
    const error = Object.assign(new Error('database incompatible'), { name });
    const retirement = runtime.refuse(error);
    try {
      await closing.promise;
      expect(runtime.agentStop).toHaveBeenCalledOnce();
      expect(runtime.generationStop).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      // Another refusal shares the original deadline rather than extending it.
      const concurrent = runtime.agentRefuse(error);
      expect(concurrent).toBe(retirement);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(runtime.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.exit).toHaveBeenCalledOnce();
      expect(runtime.exit).toHaveBeenCalledWith(error);
      await retirement;
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('retirement timed out'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Simulate the lock releasing only AFTER the exit assertion. The deadline
      // must not rely on an explicit unlock/cancel to make pool.end() resolve.
      release.resolve();
      await retirement;
      await shutdownComplete.promise;
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.exit).toHaveBeenCalledOnce();
  },
);

it('clears the retirement deadline when the normal drain completes', async () => {
  await register();
  vi.useFakeTimers();
  await runtime.refuse(
    Object.assign(new Error('schema refusal'), { name: 'SchemaVersionAheadError' }),
  );
  expect(runtime.exit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(runtime.exit).toHaveBeenCalledOnce();
  expect(console.error).not.toHaveBeenCalled();
});

it('still exits for the original schema refusal if a cleanup step fails', async () => {
  const failure = new Error('checkpoint cleanup failed');
  runtime.checkpointStop.mockRejectedValueOnce(failure);
  await register();
  vi.useFakeTimers();
  const error = Object.assign(new Error('schema refusal'), { name: 'SchemaVersionAheadError' });
  try {
    await runtime.refuse(error);
    expect(runtime.exit).toHaveBeenCalledWith(error);
    expect(console.error).toHaveBeenCalledWith(
      '[instrumentation] Schema retirement drain failed',
      failure,
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    // This deliberate failure exits before reaching the mocked pool close.
    shutdownComplete.resolve();
  }
});
