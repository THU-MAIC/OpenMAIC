/**
 * The periodic pass that actually reclaims unreferenced asset bytes.
 *
 * `PgAssetStore.remove`, and a `replace` that changes content, only stamp
 * `asset_blobs.unreferenced_at`; `AssetCollector.collect` is the sole deletion
 * path in the design. Leaving it to "the deployment" is not a decision this
 * repository can defer, because the deployment it ships is `docker-compose.yml`
 * — the app and PostgreSQL, and nothing else that could ever call it. Unrun,
 * ordinary asset churn retains PostgreSQL bytes or S3 objects forever.
 *
 * So the app schedules it, once per server process, from `instrumentation.ts`.
 *
 * SEVERAL INSTANCES MAY RUN THIS AT ONCE, AND THAT IS FINE. Each candidate blob
 * is re-checked and locked `FOR UPDATE` inside its own transaction before the
 * bytes and the row go, so two collectors serialize on the row: the loser finds
 * the row gone, or still referenced, and skips it. No distributed lock, leader
 * election, or advisory lock is needed here — please do not add one.
 */
import { AssetCollector } from '@openmaic/storage/asset/collector';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';

import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import { configuredS3Bucket, createAssetByteStore } from '@/lib/persistence/asset-byte-store';

/**
 * Fifteen minutes. Short enough that a deleted asset's bytes go the same day,
 * long enough that the pass is invisible next to ordinary request traffic. It
 * is not the retention window — the grace period below is.
 */
export const DEFAULT_ASSET_COLLECTION_INTERVAL_MS = 15 * 60 * 1000;

export interface AssetCollectorScheduleDeps {
  /** Overridden by tests; production opens its own small pool. */
  poolFactory?: (connectionString: string) => Pool;
}

export interface AssetCollectorSchedule {
  /** Stop the schedule and release the pool. */
  stop(): Promise<void>;
  /** Run one pass now, awaiting it. Exposed for tests; the timer does not await. */
  collectNow(): Promise<void>;
  intervalMs: number;
  graceMs: number;
}

/**
 * ASSET_COLLECTION_ENABLED: set to `0` or `false` to disable reclamation in
 * this process. Anything else, including unset, leaves it on — the Compose
 * deployment has to be correct with no operator action, so the working default
 * is "collect".
 */
function collectionEnabled(): boolean {
  const raw = process.env.ASSET_COLLECTION_ENABLED?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

function durationEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    console.warn(
      `${name}=${raw} is not an integer of at least ${minimum} milliseconds; using ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

const SCHEDULE_KEY = Symbol.for('openmaic.asset-collector.schedule');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: AssetCollectorSchedule | undefined;
};

/**
 * Start the reclamation schedule for this server process.
 *
 * Returns `undefined` when nothing was scheduled, which is the correct outcome
 * in two cases: server persistence is not configured, so there is no registry
 * to reclaim from; or the operator disabled collection because they run their
 * own.
 */
export function startAssetCollectorSchedule(
  deps: AssetCollectorScheduleDeps = {},
): AssetCollectorSchedule | undefined {
  // Next runs `register` once per server process, but dev-time module reloads
  // retain `globalThis`. Keying the schedule there keeps one timer and one pool
  // per process rather than one per module instance.
  const existing = globalState[SCHEDULE_KEY];
  if (existing) return existing;

  // No database, no collector. DATABASE_URL is what makes server persistence
  // real; without it every asset lives in the browser and nothing here has
  // anything to reclaim. PERSISTENCE_DEV_TOKEN deliberately does not gate this:
  // it authenticates the HTTP surface, and bytes already written still have to
  // be reclaimed if it is later removed.
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;
  if (!collectionEnabled()) return undefined;

  const intervalMs = durationEnv(
    // ASSET_COLLECTION_INTERVAL_MS: how often a pass runs. Defaults to 15
    // minutes; a floor of one second keeps a typo from spinning the database.
    'ASSET_COLLECTION_INTERVAL_MS',
    DEFAULT_ASSET_COLLECTION_INTERVAL_MS,
    1_000,
  );
  // ASSET_COLLECTION_GRACE_MS: how long bytes survive after their last
  // reference goes. Defaults to the package's one hour. This is the retention
  // window a user's deleted bytes actually get, so raise it deliberately.
  // Shared with the persistence route, which needs the same number to enable
  // indirect byte egress safely.
  const graceMs = resolveAssetCollectionGraceMs();

  const pool = (deps.poolFactory ?? ((value) => new Pool({ connectionString: value, max: 2 })))(
    connectionString,
  );
  const queryable = pool as unknown as ConnectableQueryable;

  // Built on first use rather than now: PostgreSQL may still be starting (the
  // Compose stack has no `depends_on` for it), and resolving an S3 byte store
  // means resolving the optional AWS SDK. Both belong inside the pass, where a
  // failure is logged and retried instead of escaping into server startup.
  let prepared: Promise<AssetCollector> | undefined;
  const prepare = async (): Promise<AssetCollector> => {
    await ensureAssetSchema(queryable);
    const byteStore = await createAssetByteStore(
      configuredS3Bucket(process.env.ASSET_S3_BUCKET),
      queryable,
    );
    return new AssetCollector(queryable, byteStore, {
      withTransaction: nodePostgresTransaction(queryable),
      graceMs,
    });
  };
  const collector = (): Promise<AssetCollector> =>
    (prepared ??= prepare().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    }));

  let stopped = false;
  let running = false;
  const collectNow = async (): Promise<void> => {
    // A pass slower than the interval must not stack on itself; the next tick
    // finds this one still running and skips.
    if (stopped || running) return;
    running = true;
    try {
      const collected = await (await collector()).collect();
      if (collected > 0) {
        console.info(`Asset collector reclaimed ${collected} unreferenced blob(s)`);
      }
    } catch (error) {
      // A failed pass must not take the process down or end the schedule: an
      // unreachable database, a revoked bucket credential, and a lock timeout
      // are all transient. Log it and let the next tick try again.
      console.error('Asset collection pass failed; retrying on the next interval', error);
    } finally {
      running = false;
    }
  };

  // The first pass is one interval away rather than immediate, so a cold start
  // does not race PostgreSQL coming up, and nothing can be reclaimed in that
  // window anyway: the grace period exceeds it by default.
  const timer = setInterval(() => void collectNow(), intervalMs);
  // Never the reason the process stays alive; the HTTP server is.
  timer.unref?.();

  const schedule: AssetCollectorSchedule = {
    intervalMs,
    graceMs,
    collectNow,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      globalState[SCHEDULE_KEY] = undefined;
      await pool.end().catch(() => {});
    },
  };
  globalState[SCHEDULE_KEY] = schedule;
  return schedule;
}
