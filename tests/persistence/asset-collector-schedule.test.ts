import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetCollectorSchedule } from '@/lib/persistence/asset-collector-schedule';

/**
 * Cleared between tests because the schedule keys itself on `globalThis` to
 * survive dev-time module reloads, which `vi.resetModules()` deliberately does
 * not touch.
 */
const SCHEDULE_KEY = Symbol.for('openmaic.asset-collector.schedule');

interface CollectorRecord {
  queryable: unknown;
  byteStore: unknown;
  options: { graceMs?: number; withTransaction?: unknown };
}

interface Harness {
  collect: ReturnType<typeof vi.fn>;
  collectors: CollectorRecord[];
  ensureAssetSchema: ReturnType<typeof vi.fn>;
  pgByteStores: unknown[];
  loadS3AssetByteStore: ReturnType<typeof vi.fn>;
  pools: Array<{ end: ReturnType<typeof vi.fn> }>;
  poolOptions: unknown[];
}

/**
 * Mock the storage seams the schedule composes, leaving the schedule's own
 * decisions — whether to start, on what period, and what happens to a failed
 * pass — as the only real behavior under test.
 */
function mockStorage(collect: () => Promise<number>): Harness {
  const harness: Harness = {
    collect: vi.fn(collect),
    collectors: [],
    ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
    pgByteStores: [],
    loadS3AssetByteStore: vi.fn().mockResolvedValue({ kind: 's3' }),
    pools: [],
    poolOptions: [],
  };

  vi.doMock('@openmaic/storage/asset/collector', () => ({
    DEFAULT_ASSET_COLLECTION_GRACE_MS: 60 * 60 * 1000,
    AssetCollector: class {
      collect = harness.collect;
      constructor(queryable: unknown, byteStore: unknown, options: CollectorRecord['options']) {
        harness.collectors.push({ queryable, byteStore, options });
      }
    },
  }));
  vi.doMock('@openmaic/storage/asset/pg', () => ({
    ensureAssetSchema: harness.ensureAssetSchema,
    PgAssetStore: class {},
  }));
  vi.doMock('@openmaic/storage/asset/pg-bytes', () => ({
    PgAssetByteStore: class {
      constructor(queryable: unknown) {
        harness.pgByteStores.push(queryable);
      }
    },
  }));
  vi.doMock('@openmaic/storage/asset/s3-bytes', () => ({
    loadS3AssetByteStore: harness.loadS3AssetByteStore,
  }));
  vi.doMock('@openmaic/storage/server/reference', () => ({
    nodePostgresTransaction: vi.fn(() => vi.fn()),
  }));
  vi.doMock('pg', () => ({
    Pool: class {
      end = vi.fn().mockResolvedValue(undefined);
      constructor(options: unknown) {
        harness.poolOptions.push(options);
        harness.pools.push(this as unknown as { end: ReturnType<typeof vi.fn> });
      }
    },
  }));

  return harness;
}

async function startSchedule(): Promise<AssetCollectorSchedule | undefined> {
  const scheduleModule = await import('@/lib/persistence/asset-collector-schedule');
  return scheduleModule.startAssetCollectorSchedule();
}

describe('asset collector schedule', () => {
  let schedule: AssetCollectorSchedule | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    (globalThis as Record<symbol, unknown>)[SCHEDULE_KEY] = undefined;
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('ASSET_COLLECTION_ENABLED', '');
    vi.stubEnv('ASSET_COLLECTION_INTERVAL_MS', '');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', '');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await schedule?.stop();
    schedule = undefined;
    vi.useRealTimers();
    vi.doUnmock('pg');
  });

  it('collects on an interval by default, with no operator configuration', async () => {
    const harness = mockStorage(async () => 2);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-default');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();

    expect(schedule).toBeDefined();
    // 15 minutes and 1 hour: the Compose deployment is correct without a
    // deployment-managed collector, because there is nowhere to manage one.
    expect(schedule?.intervalMs).toBe(15 * 60 * 1000);
    expect(schedule?.graceMs).toBe(60 * 60 * 1000);
    expect(harness.collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collect).toHaveBeenCalledTimes(2);

    expect(harness.ensureAssetSchema).toHaveBeenCalledTimes(1);
    expect(harness.collectors).toHaveLength(1);
    expect(harness.collectors[0]?.options.graceMs).toBe(60 * 60 * 1000);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('does not run without a database', async () => {
    const harness = mockStorage(async () => 0);
    vi.stubEnv('DATABASE_URL', '');

    schedule = await startSchedule();

    expect(schedule).toBeUndefined();
    expect(harness.pools).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(harness.collect).not.toHaveBeenCalled();
  });

  it('does not run when collection is disabled', async () => {
    const harness = mockStorage(async () => 0);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-disabled');
    vi.stubEnv('ASSET_COLLECTION_ENABLED', '0');

    schedule = await startSchedule();

    expect(schedule).toBeUndefined();
    expect(harness.pools).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(harness.collect).not.toHaveBeenCalled();
  });

  it('keeps the schedule alive after a failed pass', async () => {
    const harness = mockStorage(async () => 0);
    harness.collect
      .mockRejectedValueOnce(new Error('postgres went away'))
      .mockRejectedValueOnce(new Error('postgres is still away'))
      .mockResolvedValue(3);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-failure');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    schedule = await startSchedule();
    for (let pass = 0; pass < 3; pass += 1) {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    }

    // Two failures, then a success: the failures neither escaped as an
    // unhandled rejection nor ended the schedule.
    expect(harness.collect).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);

    process.off('unhandledRejection', unhandled);
    error.mockRestore();
    info.mockRestore();
  });

  it('retries preparation after it fails, rather than wedging the schedule', async () => {
    const harness = mockStorage(async () => 1);
    harness.ensureAssetSchema
      .mockRejectedValueOnce(new Error('relation does not exist'))
      .mockResolvedValue(undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-prepare');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collect).toHaveBeenCalledTimes(1);
    expect(harness.ensureAssetSchema).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);

    error.mockRestore();
    info.mockRestore();
  });

  it('takes the interval and grace period from the environment', async () => {
    const harness = mockStorage(async () => 0);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-env');
    vi.stubEnv('ASSET_COLLECTION_INTERVAL_MS', '60000');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', '5000');

    schedule = await startSchedule();

    expect(schedule?.intervalMs).toBe(60_000);
    expect(schedule?.graceMs).toBe(5_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.collect).toHaveBeenCalledTimes(1);
    expect(harness.collectors[0]?.options.graceMs).toBe(5_000);
  });

  it('falls back to the defaults for an unusable interval or grace', async () => {
    mockStorage(async () => 0);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-bad-env');
    vi.stubEnv('ASSET_COLLECTION_INTERVAL_MS', '10');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', 'soon');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    schedule = await startSchedule();

    expect(schedule?.intervalMs).toBe(15 * 60 * 1000);
    expect(schedule?.graceMs).toBe(60 * 60 * 1000);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reclaims through the S3 byte layer when a bucket is configured', async () => {
    const harness = mockStorage(async () => 0);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-s3');
    vi.stubEnv('ASSET_S3_BUCKET', '  asset-bucket  ');

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Deleting through the PostgreSQL byte layer while the request path wrote
    // to S3 would drop the row and orphan the object permanently.
    expect(harness.loadS3AssetByteStore).toHaveBeenCalledExactlyOnceWith('asset-bucket');
    expect(harness.pgByteStores).toHaveLength(0);
    expect(harness.collectors[0]?.byteStore).toEqual({ kind: 's3' });
  });

  it('starts one schedule per process even if asked twice', async () => {
    const harness = mockStorage(async () => 0);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-once');

    const scheduleModule = await import('@/lib/persistence/asset-collector-schedule');
    schedule = scheduleModule.startAssetCollectorSchedule();
    const again = scheduleModule.startAssetCollectorSchedule();

    expect(again).toBe(schedule);
    expect(harness.pools).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collect).toHaveBeenCalledTimes(1);
  });
});

describe('instrumentation registration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('starts the schedule on the Node.js server runtime', async () => {
    const startAssetCollectorSchedule = vi.fn();
    vi.doMock('@/lib/persistence/asset-collector-schedule', () => ({
      startAssetCollectorSchedule,
    }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');
    await register();

    expect(startAssetCollectorSchedule).toHaveBeenCalledOnce();
  });

  it('does nothing on the Edge runtime', async () => {
    const startAssetCollectorSchedule = vi.fn();
    vi.doMock('@/lib/persistence/asset-collector-schedule', () => ({
      startAssetCollectorSchedule,
    }));
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    const { register } = await import('@/instrumentation');
    await register();

    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });
});
