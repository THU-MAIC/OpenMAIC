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
  options: { graceMs?: number; withTransaction?: unknown; documentReferences?: boolean };
}

interface CollectionPass {
  collected: number;
  capped: boolean;
  entriesCollected: number;
  entriesCapped: boolean;
  backfilledDocuments: number;
  legacyEntriesCommitted: number;
}

/** A pass that did nothing, so a case only states the counts it is about. */
function pass(overrides: Partial<CollectionPass> = {}): CollectionPass {
  return {
    collected: 0,
    capped: false,
    entriesCollected: 0,
    entriesCapped: false,
    backfilledDocuments: 0,
    legacyEntriesCommitted: 0,
    ...overrides,
  };
}

/**
 * Stand-ins for the package's typed failures. The schedule branches on
 * `instanceof`, so these must be real classes rather than tagged objects — and
 * mocking them here is what lets a case fire one without a database.
 */
class MockReferenceTrackingNotEnabled extends Error {
  constructor() {
    super('no reference writer has ever run');
    this.name = 'AssetReferenceTrackingNotEnabledError';
  }
}

class MockLockUnavailable extends Error {
  readonly reason: string;
  constructor(reason: 'lock-timeout' | 'deadlock') {
    super('lock unavailable');
    this.name = 'StorageLockUnavailableError';
    this.reason = reason;
  }
}

interface Harness {
  collectPass: ReturnType<typeof vi.fn>;
  collectors: CollectorRecord[];
  ensureAssetSchema: ReturnType<typeof vi.fn>;
  pgByteStores: unknown[];
  loadS3AssetByteStore: ReturnType<typeof vi.fn>;
  pools: Array<{ end: ReturnType<typeof vi.fn> }>;
  poolOptions: unknown[];
  /** The provider the schedule awaits before it builds a collector. */
  getServerPersistenceProvider: ReturnType<typeof vi.fn>;
  /** What happened, in the order it happened, across both seams. */
  order: string[];
}

/**
 * Mock the storage seams the schedule composes, leaving the schedule's own
 * decisions — whether to start, on what period, what it logs, and what happens
 * to a failed pass — as the only real behavior under test.
 */
function mockStorage(collect: () => Promise<Partial<CollectionPass>>): Harness {
  const order: string[] = [];
  const harness: Harness = {
    collectPass: vi.fn(async () => {
      order.push('pass');
      return pass(await collect());
    }),
    collectors: [],
    ensureAssetSchema: vi.fn().mockResolvedValue(undefined),
    pgByteStores: [],
    loadS3AssetByteStore: vi.fn().mockResolvedValue({ kind: 's3' }),
    pools: [],
    poolOptions: [],
    getServerPersistenceProvider: vi.fn(async () => {
      order.push('provider');
      return { pool: {} };
    }),
    order,
  };

  // The seam that declares this database maintains asset references. The
  // schedule has to have brought it up before the entry level can run, so it is
  // mocked rather than stubbed away: every case here would otherwise be
  // exercising a collector prepared in an order production never uses.
  vi.doMock('@/lib/persistence/server-provider', () => ({
    getServerPersistenceProvider: harness.getServerPersistenceProvider,
  }));

  vi.doMock('@openmaic/storage/asset/collector', () => ({
    DEFAULT_ASSET_COLLECTION_GRACE_MS: 60 * 60 * 1000,
    AssetReferenceTrackingNotEnabledError: MockReferenceTrackingNotEnabled,
    StorageLockUnavailableError: MockLockUnavailable,
    AssetCollector: class {
      collectPass = harness.collectPass;
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
    const harness = mockStorage(async () => ({ collected: 2 }));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-default');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();

    expect(schedule).toBeDefined();
    // 15 minutes and 1 hour: the Compose deployment is correct without a
    // deployment-managed collector, because there is nowhere to manage one.
    expect(schedule?.intervalMs).toBe(15 * 60 * 1000);
    expect(schedule?.graceMs).toBe(60 * 60 * 1000);
    expect(harness.collectPass).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collectPass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collectPass).toHaveBeenCalledTimes(2);

    expect(harness.ensureAssetSchema).toHaveBeenCalledTimes(1);
    expect(harness.collectors).toHaveLength(1);
    expect(harness.collectors[0]?.options.graceMs).toBe(60 * 60 * 1000);
    // The entry level is on, unconditionally, because every document store
    // this app builds against the server schema records references. There is
    // no environment variable for this, and there must not be: the pairing is
    // what keeps the pass from expiring allocations live documents name.
    expect(harness.collectors[0]?.options.documentReferences).toBe(true);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('brings the persistence provider up before it collects anything', async () => {
    // The provider is what declares that this database's document writers
    // maintain asset references, and it is lazy: nothing else in a server
    // process brings it up until the first persistence request. An instance
    // that serves none before the first tick -- a cold install, an upgraded
    // deployment, an idle replica behind a health check -- would otherwise run
    // its first pass against a database where nothing had declared anything,
    // and refuse the entry level and the one-time backfill for as long as the
    // instance stayed quiet.
    const harness = mockStorage(async () => ({}));
    let letProviderFinish = (): void => {};
    const providerReady = new Promise<void>((resolve) => {
      letProviderFinish = resolve;
    });
    harness.getServerPersistenceProvider.mockImplementation(async () => {
      harness.order.push('provider');
      await providerReady;
      return { pool: {} };
    });
    vi.stubEnv('DATABASE_URL', 'postgres://collector-declares-first');

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Held open: the pass has started and is waiting on the provider, which is
    // the assertion. A fire-and-forget call, or no call at all, collects here.
    expect(harness.getServerPersistenceProvider).toHaveBeenCalledWith(
      'postgres://collector-declares-first',
    );
    expect(harness.collectPass).not.toHaveBeenCalled();

    letProviderFinish();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.collectPass).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual(['provider', 'pass']);
  });

  it('logs the entry counts next to the blob count', async () => {
    const harness = mockStorage(async () => ({ collected: 2, entriesCollected: 7 }));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-entry-counts');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(harness.collectPass).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain('7 unreferenced registry entries');
    expect(line).toContain('2 unreferenced blob(s)');
    info.mockRestore();
  });

  it('logs a pass that released entries but no bytes', async () => {
    // The ordinary first pass after a course is deleted: the entries go now,
    // their bytes wait out their own grace. Reporting only the blob count would
    // print nothing at all and read as an idle collector.
    const harness = mockStorage(async () => ({ entriesCollected: 1 }));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-entries-only');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(harness.collectPass).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('1 unreferenced registry entry');
    info.mockRestore();
  });

  it('reports the one-time reference backfill on its own line', async () => {
    mockStorage(async () => ({ backfilledDocuments: 50, legacyEntriesCommitted: 0 }));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-backfill');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Until the walk finishes the entry level deliberately releases nothing, so
    // an operator watching reclamation not happen can see why.
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('enumerated 50 document(s)');
    info.mockRestore();
  });

  it('reports a missing reference declaration as a defect, and keeps collecting', async () => {
    const harness = mockStorage(async () => ({}));
    harness.collectPass.mockRejectedValue(new MockReferenceTrackingNotEnabled());
    vi.stubEnv('DATABASE_URL', 'postgres://collector-unpaired');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Preparing a collector awaits the provider that makes the declaration, so
    // a pass only reaches here on a database where it was made and did not
    // take -- never on one that is merely new or idle. Two causes are left and
    // the message names both. Its own line rather than the transient wording,
    // and the schedule keeps running either way, because only the entry level
    // is refused and the blob level already ran.
    expect(harness.collectPass).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    const alarm = String(error.mock.calls[0]?.[0]);
    expect(alarm).toContain('trackAssetReferences');
    expect(alarm).toContain('awaits the persistence provider');
    expect(alarm).toContain('provider initialization failed');
    expect(alarm).not.toContain('retrying on the next interval');
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it('treats lock contention as a retry rather than something to page on', async () => {
    const harness = mockStorage(async () => ({}));
    harness.collectPass
      .mockRejectedValueOnce(new MockLockUnavailable('lock-timeout'))
      .mockResolvedValue(pass({ entriesCollected: 4 }));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-contention');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Some request path held a row longer than the collector's lock budget.
    // The next interval takes it, so this is a warning and never an error.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('lock-timeout');
    expect(error).not.toHaveBeenCalled();
    expect(harness.collectPass).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[0]?.[0])).toContain('4 unreferenced registry entries');
    error.mockRestore();
    warn.mockRestore();
    info.mockRestore();
  });

  it('does not run without a database', async () => {
    const harness = mockStorage(async () => ({}));
    vi.stubEnv('DATABASE_URL', '');

    schedule = await startSchedule();

    expect(schedule).toBeUndefined();
    expect(harness.pools).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(harness.collectPass).not.toHaveBeenCalled();
  });

  it('does not run when collection is disabled', async () => {
    const harness = mockStorage(async () => ({}));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-disabled');
    vi.stubEnv('ASSET_COLLECTION_ENABLED', '0');

    schedule = await startSchedule();

    expect(schedule).toBeUndefined();
    expect(harness.pools).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(harness.collectPass).not.toHaveBeenCalled();
  });

  it('keeps the schedule alive after a failed pass', async () => {
    const harness = mockStorage(async () => ({}));
    harness.collectPass
      .mockRejectedValueOnce(new Error('postgres went away'))
      .mockRejectedValueOnce(new Error('postgres is still away'))
      .mockResolvedValue(pass({ collected: 3 }));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-failure');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    schedule = await startSchedule();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    }

    // Two failures, then a success: the failures neither escaped as an
    // unhandled rejection nor ended the schedule.
    expect(harness.collectPass).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);

    process.off('unhandledRejection', unhandled);
    error.mockRestore();
    info.mockRestore();
  });

  it('retries preparation after it fails, rather than wedging the schedule', async () => {
    const harness = mockStorage(async () => ({ collected: 1 }));
    harness.ensureAssetSchema
      .mockRejectedValueOnce(new Error('relation does not exist'))
      .mockResolvedValue(undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://collector-prepare');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    schedule = await startSchedule();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collectPass).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collectPass).toHaveBeenCalledTimes(1);
    expect(harness.ensureAssetSchema).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);

    error.mockRestore();
    info.mockRestore();
  });

  it('takes the interval and grace period from the environment', async () => {
    const harness = mockStorage(async () => ({}));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-env');
    vi.stubEnv('ASSET_COLLECTION_INTERVAL_MS', '60000');
    vi.stubEnv('ASSET_COLLECTION_GRACE_MS', '5000');

    schedule = await startSchedule();

    expect(schedule?.intervalMs).toBe(60_000);
    expect(schedule?.graceMs).toBe(5_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.collectPass).toHaveBeenCalledTimes(1);
    expect(harness.collectors[0]?.options.graceMs).toBe(5_000);
  });

  it('falls back to the defaults for an unusable interval or grace', async () => {
    mockStorage(async () => ({}));
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
    const harness = mockStorage(async () => ({}));
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
    const harness = mockStorage(async () => ({}));
    vi.stubEnv('DATABASE_URL', 'postgres://collector-once');

    const scheduleModule = await import('@/lib/persistence/asset-collector-schedule');
    schedule = scheduleModule.startAssetCollectorSchedule();
    const again = scheduleModule.startAssetCollectorSchedule();

    expect(again).toBe(schedule);
    expect(harness.pools).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(harness.collectPass).toHaveBeenCalledTimes(1);
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

  it('refuses to start on a malformed pending TTL, before anything is scheduled', async () => {
    const startAssetCollectorSchedule = vi.fn();
    vi.doMock('@/lib/persistence/asset-collector-schedule', () => ({
      startAssetCollectorSchedule,
    }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ASSET_PENDING_TTL_MS', '24h');

    const { register } = await import('@/instrumentation');

    // `register` runs before the server is ready, so throwing here is what
    // makes a misconfigured deployment fail to start rather than fail to work.
    await expect(register()).rejects.toThrow(/ASSET_PENDING_TTL_MS/);
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
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
