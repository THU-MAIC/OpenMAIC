/**
 * The periodic pass that actually reclaims unreferenced assets.
 *
 * It has two levels, and this application runs both. A registry entry is
 * released once it is either a pending allocation no document claimed before
 * `ASSET_PENDING_TTL_MS` ran out, or a committed entry whose last document
 * reference left longer ago than the grace period; its bytes then wait out the
 * same grace and go on a later pass. Nothing on a request path deletes either:
 * `PgAssetStore.remove`, and a `replace` that changes content, only stamp
 * `unreferenced_at`, and this application refuses `remove` to every browser
 * outright. `AssetCollector` is the sole deletion path in the design.
 *
 * Leaving it to "the deployment" is not a decision this repository can defer,
 * because the deployment it ships is `docker-compose.yml` — the app and
 * PostgreSQL, and nothing else that could ever call it. Unrun, ordinary asset
 * churn retains registry rows, PostgreSQL bytes or S3 objects forever, and the
 * per-principal quota only ever fills.
 *
 * So the app schedules it, once per server process, from `instrumentation.ts`.
 *
 * SEVERAL INSTANCES MAY RUN THIS AT ONCE, AND THAT IS FINE. Each candidate row,
 * entry or blob, is re-checked and locked `FOR UPDATE` inside its own
 * transaction before it goes, so two collectors serialize on the row: the loser
 * finds the row gone, or still referenced, and skips it. No distributed lock, leader
 * election, or advisory lock is needed here — please do not add one.
 */
import {
  AssetCollector,
  AssetReferenceTrackingNotEnabledError,
  StorageLockUnavailableError,
} from '@openmaic/storage/asset/collector';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';

import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import { configuredS3Bucket, createAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

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
    // The provider first, and awaited, because it is what declares that this
    // database's document writers maintain asset references -- the thing the
    // entry level refuses to run without.
    //
    // Nothing else here would have brought it up. `register` starts this
    // schedule and does not touch the provider, and the provider is lazy: it
    // initializes on the first persistence request. An instance that serves
    // none -- a cold install, an upgraded deployment, an idle replica behind a
    // health check -- would otherwise reach this pass with nothing declared,
    // refuse the entry level and the one-time backfill, and say so every
    // interval. Awaiting it here makes the declaration part of preparing a
    // collector rather than a race against traffic.
    //
    // A failure propagates like any other preparation failure: `collector()`
    // drops the memoised promise, `collectNow` logs it, and the next interval
    // tries again. The schedule is never taken down by it, and the provider
    // has its own retry on the request path regardless.
    //
    // The collector keeps its own small pool rather than borrowing the
    // provider's. A background pass that competes for request connections is a
    // pass that makes request latency its problem, and this pool's lifetime is
    // the schedule's -- `stop()` ends it, while the provider's is ended by the
    // shutdown hook that owns it.
    await getServerPersistenceProvider(connectionString);
    await ensureAssetSchema(queryable);
    const byteStore = await createAssetByteStore(
      configuredS3Bucket(process.env.ASSET_S3_BUCKET),
      queryable,
    );
    return new AssetCollector(queryable, byteStore, {
      withTransaction: nodePostgresTransaction(queryable),
      graceMs,
      // The entry level of the same reclamation, and not optional here. Every
      // document store this application builds against the server schema runs
      // with `trackAssetReferences`, so the reference table the pass reads is
      // always being maintained; there is no deployment shape of this app in
      // which one half is on and the other off. See the reference-writer
      // comments in lib/persistence/server-provider.ts and
      // lib/persistence/owner-bound-document-store.ts.
      documentReferences: true,
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
      // `collectPass` rather than `collect` because the pass now has two
      // levels and `collect` only answers for the lower one. A pass that
      // released a hundred registry entries and no bytes -- the ordinary shape
      // of the first pass after a course is deleted, since the bytes wait out
      // their own grace afterwards -- would otherwise log nothing at all.
      const pass = await (await collector()).collectPass();
      if (pass.entriesCollected > 0 || pass.collected > 0) {
        console.info(
          `Asset collector reclaimed ${pass.entriesCollected} unreferenced registry entr` +
            `${pass.entriesCollected === 1 ? 'y' : 'ies'} and ${pass.collected} ` +
            `unreferenced blob(s)`,
        );
      }
      if (pass.backfilledDocuments > 0 || pass.legacyEntriesCommitted > 0) {
        // The one-time upgrade walk. Worth its own line: until it finishes,
        // the entry level deliberately releases nothing, so an operator
        // watching reclamation not happen should be able to see why.
        console.info(
          `Asset reference backfill enumerated ${pass.backfilledDocuments} document(s) and ` +
            `committed ${pass.legacyEntriesCommitted} pre-lifecycle entr` +
            `${pass.legacyEntriesCommitted === 1 ? 'y' : 'ies'}`,
        );
      }
    } catch (error) {
      if (error instanceof AssetReferenceTrackingNotEnabledError) {
        // The package's gate is "does this database hold the one-row marker
        // that says its writers maintain references". Reaching here means a
        // pass ran and the row was not there.
        //
        // That is a narrow thing. Preparation awaits the provider, and the
        // provider writes the marker before it returns, so a provider that
        // failed cannot produce this line at all -- preparation would have
        // thrown and the generic branch below would have logged instead. The
        // marker is also never withdrawn: writing it is `INSERT … ON CONFLICT
        // DO NOTHING`, and nothing in the package or this application deletes
        // it, so a store writing without `trackAssetReferences` cannot cause
        // this either. What is left is that the row was removed or never
        // reached the database this collector reads: dropped or truncated out
        // of band, restored from a backup taken before the declaration, or a
        // collector and a provider pointed at different databases.
        //
        // Only the entry level is refused -- the blob level already ran, and
        // nothing is released while refused, so it cannot lose data. It does
        // mean no entry is being reclaimed until someone acts.
        console.error(
          'Asset collection is configured to reclaim registry entries, but this database does ' +
            'not hold the marker that says its document writers maintain them, so entry ' +
            'reclamation (including the one-time backfill) is refused. Byte reclamation is ' +
            'unaffected. The persistence provider writes that marker before this collector is ' +
            'built and nothing ever removes it, so it was dropped or truncated out of band, ' +
            'restored away, or this collector is reading a different database from the one ' +
            'the provider initialized.',
          error,
        );
      } else if (error instanceof StorageLockUnavailableError) {
        // Contention, not breakage: some request path held a row this pass
        // wanted for longer than the collector's lock budget. The next
        // interval takes it. Nothing to page on, so this is a warning.
        console.warn(
          `Asset collection pass gave up waiting on a lock (${error.reason}); ` +
            `retrying on the next interval`,
        );
      } else {
        // A failed pass must not take the process down or end the schedule: an
        // unreachable database and a revoked bucket credential are both
        // transient. Log it and let the next tick try again.
        console.error('Asset collection pass failed; retrying on the next interval', error);
      }
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
