import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifySchemaMigrations = vi.hoisted(() => vi.fn());
vi.mock('@openmaic/storage/pg-migrations', () => ({ verifySchemaMigrations }));
const exitOnBootFailure = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/boot-failure', () => ({ exitOnBootFailure }));

const provider = vi.hoisted(() => vi.fn());
vi.mock('@/lib/persistence/server-provider', () => ({ getServerPersistenceProvider: provider }));
import {
  assertRuntimeSchemaCompatibility,
  startSchemaBootCheck,
  startRuntimeSchemaMonitor,
} from '@/lib/persistence/schema-boot-check';
import { APP_SCHEMA_STORES } from '@/lib/persistence/schema-stores';

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('schema check at startup', () => {
  const end = vi.fn(async () => {});
  const on = vi.fn();
  const pool = { end, on } as unknown as Pool;
  const poolFactory = vi.fn(() => pool);

  beforeEach(() => {
    verifySchemaMigrations.mockReset();
    exitOnBootFailure.mockReset();
    end.mockClear();
    poolFactory.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies every store the application knows, on a pool of its own it then closes', async () => {
    verifySchemaMigrations.mockResolvedValue(undefined);

    await startSchemaBootCheck(' postgres://db/openmaic ', poolFactory);

    expect(poolFactory).toHaveBeenCalledWith('postgres://db/openmaic');
    expect(verifySchemaMigrations).toHaveBeenCalledWith(pool, APP_SCHEMA_STORES);
    expect(end).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(exitOnBootFailure).not.toHaveBeenCalled();
  });

  it.each(['SchemaVersionAheadError', 'SchemaMigrationChecksumError'])(
    'stops the process on a %s',
    async (name) => {
      const refusal = named(name);
      verifySchemaMigrations.mockRejectedValue(refusal);

      await startSchemaBootCheck('postgres://db/openmaic', poolFactory);

      expect(exitOnBootFailure).toHaveBeenCalledWith(refusal);
    },
  );

  it('leaves any other failure to the stores, and says so', async () => {
    verifySchemaMigrations.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await startSchemaBootCheck('postgres://db/openmaic', poolFactory);

    expect(exitOnBootFailure).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/checks them again when it is first used/),
      expect.any(Error),
    );
  });

  it('rechecks a running instance before claims, propagating refusals without closing its shared pool', async () => {
    provider.mockResolvedValue({ pool });
    verifySchemaMigrations.mockResolvedValueOnce(undefined);
    await assertRuntimeSchemaCompatibility();
    const refusal = named('SchemaVersionAheadError');
    verifySchemaMigrations.mockRejectedValueOnce(refusal);
    await expect(assertRuntimeSchemaCompatibility()).rejects.toBe(refusal);
    expect(verifySchemaMigrations).toHaveBeenCalledTimes(2);
    expect(verifySchemaMigrations).toHaveBeenLastCalledWith(pool, APP_SCHEMA_STORES);
    expect(end).not.toHaveBeenCalled();
  });
});

describe('process runtime schema monitor', () => {
  const end = vi.fn(async () => {});
  beforeEach(async () => {
    verifySchemaMigrations.mockReset().mockResolvedValue(undefined);
    provider.mockResolvedValue({ pool: { end } });
    end.mockClear();
    await import('@/lib/persistence/server-provider');
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['SchemaVersionAheadError', 'SchemaMigrationChecksumError'])(
    'polls every 30 seconds and retires once on a later %s',
    async (name) => {
      const refuse = vi.fn(async () => {});
      const monitor = startRuntimeSchemaMonitor(refuse);
      try {
        await vi.advanceTimersByTimeAsync(29_999);
        expect(verifySchemaMigrations).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(verifySchemaMigrations).toHaveBeenCalledOnce();
        const error = named(name);
        verifySchemaMigrations.mockRejectedValueOnce(error);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(refuse).toHaveBeenCalledWith(error);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(verifySchemaMigrations).toHaveBeenCalledTimes(2);
        expect(refuse).toHaveBeenCalledOnce();
        expect(end).not.toHaveBeenCalled();
      } finally {
        monitor.stop();
      }
    },
  );

  it('retries a temporary failure on the next poll without retiring', async () => {
    const refuse = vi.fn(async () => {});
    const monitor = startRuntimeSchemaMonitor(refuse);
    try {
      verifySchemaMigrations.mockRejectedValueOnce(new Error('ECONNRESET'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refuse).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(verifySchemaMigrations).toHaveBeenCalledTimes(2);
      expect(refuse).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it('does not overlap checks or retire on an in-flight result after stop', async () => {
    const pending = Promise.withResolvers<void>();
    verifySchemaMigrations.mockReturnValueOnce(pending.promise);
    const refuse = vi.fn(async () => {});
    const monitor = startRuntimeSchemaMonitor(refuse);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(verifySchemaMigrations).toHaveBeenCalledOnce();
      monitor.stop();
      pending.reject(named('SchemaVersionAheadError'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(verifySchemaMigrations).toHaveBeenCalledOnce();
      expect(refuse).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      monitor.stop();
    }
  });
});
