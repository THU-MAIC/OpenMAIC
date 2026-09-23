/** Offline reclamation for unreferenced server asset entries and bytes. */
import type { ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';
import {
  assetReferenceTrackingEnabled,
  backfillDocumentAssetReferences,
  documentAssetReferencesWithdrawn,
  lockBackfillEntries,
  sceneAssetScope,
  stageAssetScope,
} from './references.js';
import { asStorageLockUnavailable } from '../runtime/pg.js';
import type { Queryable, WithTransaction } from '../runtime/pg.js';

/** One hour. A deployment may choose a longer retention window. */
export const DEFAULT_ASSET_COLLECTION_GRACE_MS = 60 * 60 * 1000;

/**
 * The invariant between indirect egress and reclamation: a signed URL must
 * expire far earlier than the bytes it names can be collected, or a reader
 * authorized at mint time errors at the object store. Ten times the lifetime
 * is the floor.
 *
 * The asset HTTP handler applies this itself, on the grace its indirect-egress
 * option requires it to be given, so a deployment wiring both does not have to
 * call it. It stays exported for a deployment that decides the two numbers
 * somewhere other than the call that builds the handler and wants to fail
 * earlier.
 */
export function assertSignedUrlTtlWithinGrace(ttlSeconds: number, graceMs: number): void {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < ttlSeconds * 1000 * 10
  ) {
    throw new Error(
      '@openmaic/storage: the signed URL lifetime must stay far below the collection grace period',
    );
  }
}

/**
 * One thousand blobs per pass.
 *
 * Ordinary churn produces far fewer than this between two scheduled passes, so
 * a healthy deployment never reaches the cap and behaves exactly as it did when
 * a pass was unbounded. The cap is there for the first pass over a backlog that
 * accumulated before collection was scheduled, which is the one pass whose size
 * is set by history rather than by the interval.
 */
export const DEFAULT_ASSET_COLLECTION_BATCH_SIZE = 1000;

/**
 * Fifty documents per backfill chunk.
 *
 * Far smaller than the blob and entry batches because a backfill step reads a
 * whole document -- a stage row and all of its scene rows, content included --
 * rather than one narrow row, and the walk exists to be spread over passes
 * instead of finished in one.
 */
export const DEFAULT_ASSET_REFERENCE_BACKFILL_BATCH_SIZE = 50;

export interface AssetCollectorOptions {
  /** Pin each per-blob callback to a fresh PostgreSQL transaction. */
  withTransaction: WithTransaction;
  /** Minimum age of an unreferenced row before collection. Defaults to one hour. */
  graceMs?: number;
  /** Most blobs one `collect` takes. Defaults to one thousand. */
  batchSize?: number;
  /** Clock override for deterministic hosts and tests. */
  now?: () => Date;
  /**
   * Reclaim unreferenced `asset_entries` as well as unreferenced bytes,
   * using the `document_asset_refs` table. Defaults to `false`.
   *
   * **A deployment that turns this on MUST also construct its
   * `PgDocumentStore` with `trackAssetReferences: true`.** The two halves are
   * one mechanism: the document store is what commits an entry and what
   * records the references this pass reads. Enabling the pass without it
   * leaves every entry pending, and every pending entry is released when its
   * TTL expires -- while the documents naming them are still there.
   *
   * That pairing is enforced on the way in and NOT on the way out. The marker
   * a tracking document store writes is never removed, so turning
   * `trackAssetReferences` back off while leaving this on passes the check and
   * re-opens exactly the failure the marker exists to prevent: allocations
   * from the now-untracked store never commit, and each is released on its
   * TTL. **Roll the two back together.** The marker is not a heartbeat on
   * purpose -- an idle deployment would then be refused the reclamation of its
   * expired pending entries for being idle, which is the wrong answer to a
   * quiet week -- so a host that can configure the halves separately owns
   * keeping them in step.
   */
  documentReferences?: boolean;
  /** Most documents one reference-backfill chunk reads. Defaults to fifty. */
  referenceBackfillBatchSize?: number;
  /**
   * The principals whose entries a document's backfilled references may name,
   * given the document's `owner_id` (`null` for an unowned document), or
   * `undefined` for any entry. Pass the same function as the document store's
   * `assetReferencePrincipals`, so the walk never records a reference a write
   * by that document's owner would not have recorded.
   */
  assetReferencePrincipals?: (documentOwnerId: string | null) => readonly string[] | undefined;
}

/** What one bounded pass did, for a caller that needs more than the count. */
export interface AssetCollectionPass {
  /** Blobs this pass deleted. Never above `batchSize`. */
  collected: number;
  /**
   * The pass took a full batch, so the backlog may hold more. False means the
   * pass saw the end of the eligible set and there is nothing left to drain.
   */
  capped: boolean;
  /**
   * Registry entries this pass deleted: expired pending allocations and
   * committed entries whose last document reference left longer ago than the
   * grace period. Always zero when `documentReferences` is off.
   */
  entriesCollected: number;
  /** The entry pass filled its own batch, so more entries may be eligible. */
  entriesCapped: boolean;
  /** Documents this pass enumerated while backfilling the reference table. */
  backfilledDocuments: number;
  /**
   * Pre-lifecycle entries this pass marked committed, which happens once, on
   * the pass that completes the backfill walk.
   */
  legacyEntriesCommitted: number;
}

interface CandidateRow extends Record<string, unknown> {
  content_hash: ContentHash;
}

interface EntryCandidateRow extends Record<string, unknown> {
  id: string;
}

interface EntryLockRow extends EntryCandidateRow {
  content_hash: ContentHash;
}

interface StageIdRow extends Record<string, unknown> {
  id: string;
}

interface StageWalkRow extends StageIdRow {
  data: unknown;
}

interface OwnedStageWalkRow extends StageWalkRow {
  owner_id: string | null;
}

interface SceneWalkRow extends StageWalkRow {
  stage_id: string;
}

interface TransactionalByteDeleter extends AssetByteStore {
  deleteWith(queryable: Queryable, hash: ContentHash): Promise<void>;
}

function hasTransactionalDeleter(store: AssetByteStore): store is TransactionalByteDeleter {
  return 'deleteWith' in store && typeof store.deleteWith === 'function';
}

type ReleasedEntries = Pick<AssetCollectionPass, 'entriesCollected' | 'entriesCapped'>;

type EntryLevelPass = Pick<
  AssetCollectionPass,
  'entriesCollected' | 'entriesCapped' | 'backfilledDocuments' | 'legacyEntriesCommitted'
>;

/** What the entry level reports when a deployment has not enabled it. */
const EMPTY_ENTRY_LEVEL: EntryLevelPass = {
  entriesCollected: 0,
  entriesCapped: false,
  backfilledDocuments: 0,
  legacyEntriesCommitted: 0,
};

/**
 * A collection failure, optionally naming the document it happened on.
 *
 * The id travels as a property rather than in the message because the message
 * is the value that escapes: this package's egress rule keeps caller-derived
 * strings out of thrown text, and a stage id is caller-derived. A host that
 * wants to know which document stalls its backfill reads `stageId`; a log line
 * that prints the error alone still discloses nothing. Exported so that
 * reading it is a type rather than a cast.
 *
 * `cause` is whatever the pass caught, including a
 * {@link StorageLockUnavailableError} when the document this names could not
 * be locked -- so a host can have both facts at once: `instanceof` on the
 * cause says "contention, retry", and `stageId` says which document to look
 * at. Contention with no document to name is not wrapped at all; it is thrown
 * as the typed error itself (see {@link collectorFailure}).
 */
export class AssetCollectionFailure extends Error {
  /** The document the pass was enumerating, when it was enumerating one. */
  readonly stageId?: string;

  constructor(stageId?: string, cause?: unknown) {
    super(
      '@openmaic/storage: asset collection failed',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AssetCollectionFailure';
    if (stageId !== undefined) this.stageId = stageId;
  }
}

/**
 * Wrap a caught failure, keeping it as `cause`.
 *
 * Lock contention is the one failure this collector manufactures on purpose
 * (through its `lock_timeout` budget), and a host's response to it is to retry
 * rather than to investigate, so it must stay identifiable rather than being
 * flattened into the generic failure and left to string matching. How it is
 * surfaced depends on whether there is a document to name:
 *
 * - No stage id (every pass except the backfill's per-document step): the
 *   typed error is thrown as it is. There is nothing to add to it.
 * - A stage id (the backfill): the typed error becomes the `cause` of an
 *   {@link AssetCollectionFailure} carrying that id, because both facts are
 *   useful and dropping either is a worse answer. `instanceof` on the cause
 *   still identifies contention.
 */
function collectorFailure(stageId?: string, cause?: unknown): Error {
  const contention = asStorageLockUnavailable(cause);
  if (contention && stageId === undefined) return contention;
  return new AssetCollectionFailure(stageId, contention ?? cause);
}

/**
 * The entry pass was enabled on a database no document store maintains
 * references on.
 *
 * Refusing is the whole point. Running anyway would find every entry pending
 * -- because nothing ever commits one -- and delete each on its TTL, while the
 * documents naming them are still there. That is silent, permanent media loss,
 * indistinguishable from correct operation until a user opens an old course.
 * The blob pass is unaffected and still runs; only the entry level refuses.
 */
export class AssetReferenceTrackingNotEnabledError extends Error {
  constructor() {
    super(
      '@openmaic/storage: the asset collector is configured with documentReferences, but no ' +
        'document store on this database has written a reference row. Construct the ' +
        'PgDocumentStore with trackAssetReferences: true (both halves are one mechanism), or ' +
        'turn documentReferences off. Releasing entries without a reference writer would delete ' +
        'assets live documents still name.',
    );
    this.name = 'AssetReferenceTrackingNotEnabledError';
  }
}

/**
 * Bound on how long one collection transaction may wait on a lock.
 *
 * Every transaction below takes a row lock a request path also takes -- the
 * blob row a write claims, the entry row a document write commits, the stage
 * row a save locks -- so an unbounded wait lets one stuck holder park the
 * collector for as long as it stays stuck, on a schedule nothing is watching.
 * The same budget, for the same reason, as the registry's write transactions.
 */
const COLLECTION_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '30s'`;

function collectorConfigurationFailure(): Error {
  return new Error(
    '@openmaic/storage: the asset byte store cannot coordinate collection with the registry. A ' +
      'byte store without deleteWith() deletes on its own connection; if it deletes bytes in the ' +
      'same PostgreSQL as the registry, that delete blocks forever on the blob-row lock the ' +
      "collector's transaction just took (a self-deadlock PostgreSQL cannot detect). Provide a " +
      'transaction-pinned deleteWith(), or declare writesOutsideRegistryDatabase: true when the ' +
      "bytes genuinely live outside the registry's database (for example in an object store).",
  );
}

/**
 * An error a pass raised while it was already holding an entry-level failure.
 *
 * `collectPass` runs the entry level first and the blob pass second, and the
 * blob pass is allowed to fail on its own. When both fail, the blob failure is
 * the one thrown -- it is what stopped the pass -- and the entry-level failure
 * would otherwise be lost, so it is attached here instead. Declared as an
 * interface so reading it is a type rather than a cast, exactly as `stageId`
 * is on {@link AssetCollectionFailure}; the property is non-enumerable, so it
 * does not change how an error already logged or serialized prints.
 */
export interface AssetCollectionEntryLevelFailure {
  /** The entry-level failure this pass had recorded before the raised one. */
  readonly entryLevelFailure?: unknown;
}

/** Attach a recorded entry-level failure to the error about to be thrown. */
function carryingEntryFailure(
  error: unknown,
  pending: { readonly error: unknown } | undefined,
): unknown {
  if (pending === undefined || !(error instanceof Error) || error === pending.error) return error;
  Object.defineProperty(error, 'entryLevelFailure', {
    value: pending.error,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/**
 * Re-runnable collector for the rows left behind by request operations.
 *
 * This is the only component that calls `AssetByteStore.delete`, and -- with
 * `documentReferences` enabled -- the only server-side path that deletes a
 * registry entry outside `remove`. Hosts must schedule it: leaving it
 * unscheduled lets unreferenced storage grow without bound, at both levels.
 *
 * With `documentReferences` enabled a pass has two levels, run in that order:
 * entries first (backfill if the reference table is incomplete, then release
 * expired pending and long-unreferenced committed entries), then the bytes
 * whose last entry left. The levels share one grace period: an entry and its
 * bytes are two rows describing one asset, and giving them separate windows
 * would only invite them to disagree about how long an undo has.
 *
 * A pass is **bounded**: it takes at most `batchSize` blobs and returns. An
 * unbounded pass would be sized by however long the deployment ran before
 * collection was scheduled — one statement selecting every eligible blob, then
 * one transaction and one byte-layer delete each, in a loop nothing interrupts.
 * A pass that stops at the cap costs the remainder one scheduling interval,
 * which is what the interval is for.
 *
 * `collect` answers how many blobs the pass deleted, and that count alone
 * cannot tell an empty backlog from a full batch: a candidate that was
 * re-referenced, or already taken by a concurrent collector, is skipped, so
 * even a full batch can return less than `batchSize`. `collectPass` returns the
 * same count together with `capped`, which is exactly "this batch was full, run
 * again" — a caller draining the backlog in a loop runs while `capped` is true.
 */
export class AssetCollector {
  private readonly transactionHook: WithTransaction;
  private readonly graceMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly documentReferences: boolean;
  private readonly referenceBackfillBatchSize: number;
  private readonly assetReferencePrincipals: AssetCollectorOptions['assetReferencePrincipals'];
  /**
   * Where the reference backfill walk has got to, as the id of the last stage
   * enumerated; `null` means "no walk in progress".
   *
   * In memory, and therefore per collector instance: a process that restarts
   * mid-walk starts the walk again. That is safe rather than merely tolerable,
   * because of the order the two halves run in. The walk only ever INSERTS
   * reference rows (`ON CONFLICT DO NOTHING`, so repeating it is free), and
   * legacy entries are marked committed only by the pass that reaches the end
   * of the walk. Until that happens, invariant (i) below stops the entry pass
   * from releasing anything at all -- so an interrupted walk can never have
   * released an entry the documents it had not reached still reference.
   */
  private backfillCursor: string | null = null;
  /**
   * Where {@link stampUnreferencedSweep} has got to, as the id of the last
   * entry it considered; `null` means "start from the beginning".
   *
   * In memory and therefore per collector instance, like
   * {@link backfillCursor}, and for a weaker reason: the sweep is idempotent
   * and unordered work, so a process that restarts mid-walk simply starts the
   * walk again and reaches the same rows. Nothing depends on where it was.
   */
  private stampSweepCursor: string | null = null;

  constructor(
    private readonly queryable: Queryable,
    private readonly byteStore: AssetByteStore,
    options: AssetCollectorOptions,
  ) {
    if (typeof options?.withTransaction !== 'function') {
      throw new Error('@openmaic/storage: withTransaction is required for AssetCollector');
    }
    const graceMs = options.graceMs ?? DEFAULT_ASSET_COLLECTION_GRACE_MS;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw new Error('@openmaic/storage: graceMs must be a non-negative safe integer');
    }
    const batchSize = options.batchSize ?? DEFAULT_ASSET_COLLECTION_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error('@openmaic/storage: batchSize must be a positive safe integer');
    }
    const referenceBackfillBatchSize =
      options.referenceBackfillBatchSize ?? DEFAULT_ASSET_REFERENCE_BACKFILL_BATCH_SIZE;
    if (!Number.isSafeInteger(referenceBackfillBatchSize) || referenceBackfillBatchSize < 1) {
      throw new Error(
        '@openmaic/storage: referenceBackfillBatchSize must be a positive safe integer',
      );
    }
    this.transactionHook = options.withTransaction;
    this.graceMs = graceMs;
    this.batchSize = batchSize;
    this.now = options.now ?? (() => new Date());
    this.documentReferences = options.documentReferences === true;
    this.referenceBackfillBatchSize = referenceBackfillBatchSize;
    this.assetReferencePrincipals = options.assetReferencePrincipals;
  }

  /** Every collection transaction: a fresh pinned one, plus a lock-wait budget. */
  private lockBoundedTransaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(async (queryable) => {
      await queryable.query(COLLECTION_LOCK_TIMEOUT_SQL);
      return body(queryable);
    });
  }

  /**
   * Run one bounded pass and resolve to the number of BLOBS it deleted, which
   * is never above `batchSize`.
   *
   * Deliberately still the blob count with the entry level enabled: this is
   * the number a host logs as "bytes reclaimed", and widening it into a total
   * would silently change what every existing caller reports. `collectPass`
   * carries the entry counts.
   *
   * A caller that needs to tell "the backlog is drained" from "this pass filled
   * its batch and more is waiting" must use `collectPass`; this count cannot
   * carry that distinction, for the reason given on the class.
   */
  async collect(): Promise<number> {
    return (await this.collectPass()).collected;
  }

  /** Run one bounded pass and report both what it deleted and whether it filled its batch. */
  async collectPass(): Promise<AssetCollectionPass> {
    // Refuse the self-deadlock configuration before any row is locked, mirroring
    // the registry's write guard (see PgAssetStore.assertByteWriteIsCoordinatable):
    // a layer without deleteWith() deletes on its own connection, which blocks
    // forever on the blob-row lock this pass's transaction holds when those bytes
    // live in the registry's own PostgreSQL.
    if (
      !hasTransactionalDeleter(this.byteStore) &&
      this.byteStore.writesOutsideRegistryDatabase !== true
    ) {
      throw collectorConfigurationFailure();
    }
    const now = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - this.graceMs).toISOString();
    // The entry level runs first: releasing an entry is what stamps its blob
    // unreferenced, and doing it before the blob pass means a blob freed here
    // starts its own grace period now instead of one interval from now.
    //
    // NOTHING the entry level does can stop the blob pass, and that is the
    // whole shape of the block below. The blob pass is correct with or without
    // a reference writer and with or without a working entry level -- it reads
    // `asset_blobs` and asks only whether any entry still names those bytes --
    // so a deployment whose entry level is misconfigured or contended keeps
    // reclaiming bytes rather than stopping at both levels at once. Two things
    // can go wrong here, and BOTH are recorded rather than thrown:
    //
    // - A missing tracking marker, which is a misconfiguration whose
    //   consequence would be deleting live media, so the entry level refuses.
    // - Any throw out of the entry level itself: a lock timeout on the legacy
    //   mark, a backfill that cannot read its document, a release that lost a
    //   race with the request path. These are transient by nature, and letting
    //   one of them cost the deployment its byte reclamation for that interval
    //   would be a strictly worse answer than reporting it after the fact.
    //
    // The two are exclusive -- the refusal is the else branch of the check
    // whose then branch is the only thing that can fail -- but the order they
    // are raised in is still explicit, so an edit that makes both reachable
    // raises the misconfiguration rather than silently dropping either.
    //
    // PRECEDENCE, when the blob pass ALSO fails: the blob failure is what is
    // thrown, because it is the failure that stopped this pass, and the
    // recorded entry-level failure travels on it as `entryLevelFailure` (see
    // AssetCollectionEntryLevelFailure) rather than being dropped. Otherwise
    // the recorded failure is thrown at the end, once the blob pass is done.
    let trackingFailure: AssetReferenceTrackingNotEnabledError | undefined;
    // Wrapped rather than held bare, so "there was a failure" cannot be
    // confused with a falsy thrown value.
    let entryFailure: { readonly error: unknown } | undefined;
    let entries = EMPTY_ENTRY_LEVEL;
    if (this.documentReferences) {
      try {
        if (await this.referenceTrackingEnabled()) {
          entries = await this.entryLevelPass(now, cutoff);
        } else {
          trackingFailure = new AssetReferenceTrackingNotEnabledError();
        }
      } catch (error) {
        entryFailure = { error };
      }
    }
    // Whichever of the two was recorded; they are exclusive.
    const pendingEntryLevelFailure =
      trackingFailure === undefined ? entryFailure : { error: trackingFailure };
    let candidates;
    try {
      candidates = await this.queryable.query<CandidateRow>(
        // Oldest unreferenced first. Some ordering has to decide what a full
        // pass leaves behind, and this one cannot starve a blob: every blob is
        // stamped when its last reference goes, so this is arrival order, and
        // a blob that has waited longer is always taken before one stamped
        // after it. Ordering by `content_hash` -- the only other column that
        // could order this set -- would starve, because digests are uniformly
        // distributed: a blob whose digest sorts high waits behind every lower
        // digest stamped after it, and under steady arrivals those keep coming.
        // The hash is the tiebreaker within one timestamp only, where the tied
        // set is bounded and every member of it is taken by the same pass or
        // the next one.
        `SELECT content_hash
           FROM asset_blobs
          WHERE unreferenced_at < $1::timestamptz
          ORDER BY unreferenced_at ASC, content_hash ASC
          LIMIT $2`,
        [cutoff, this.batchSize],
      );
    } catch (error) {
      throw carryingEntryFailure(collectorFailure(undefined, error), pendingEntryLevelFailure);
    }

    let collected = 0;
    for (const candidate of candidates.rows) {
      try {
        const didCollect = await this.lockBoundedTransaction(async (queryable) => {
          const locked = await queryable.query<CandidateRow>(
            `SELECT content_hash
               FROM asset_blobs
              WHERE content_hash = $1
                AND unreferenced_at < $2::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM asset_entries WHERE content_hash = $1
                )
              FOR UPDATE`,
            [candidate.content_hash, cutoff],
          );
          if (!locked.rows[0]) return false;
          if (hasTransactionalDeleter(this.byteStore)) {
            await this.byteStore.deleteWith(queryable, candidate.content_hash);
          } else {
            // Reachable only after the entry-point guard above: the layer either
            // has deleteWith (handled by the branch above) or declared that its
            // bytes live outside the registry's database, so this plain delete
            // cannot contend for the blob-row lock this transaction holds.
            await this.byteStore.delete(candidate.content_hash);
          }
          await queryable.query('DELETE FROM asset_blobs WHERE content_hash = $1', [
            candidate.content_hash,
          ]);
          return true;
        });
        if (didCollect) collected += 1;
      } catch (error) {
        throw carryingEntryFailure(collectorFailure(undefined, error), pendingEntryLevelFailure);
      }
    }
    if (trackingFailure) throw trackingFailure;
    if (entryFailure) throw entryFailure.error;
    return {
      collected,
      capped: candidates.rows.length >= this.batchSize,
      ...entries,
    };
  }

  private async referenceTrackingEnabled(): Promise<boolean> {
    try {
      return await assetReferenceTrackingEnabled(this.queryable);
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
  }

  /**
   * The entry level: backfill what the reference table is missing, then
   * release the entries nothing references.
   *
   * Three invariants hold this together, and each is enforced below rather
   * than assumed:
   *
   * (i)   **Nothing is released while any legacy entry exists.** A legacy
   *       entry -- one written before the lifecycle columns existed, so
   *       `committed_at` and `expires_at` are both NULL -- has no reference
   *       rows either, which would make it look eligible while documents still
   *       name it. The gate is re-asked of the database on every pass rather
   *       than remembered, so it cannot be defeated by a restart or by a
   *       deployment that briefly wrote with older code.
   * (ii)  **Legacy entries are marked committed only after every
   *       `document_stages` row has been enumerated.** The walk is bounded per
   *       pass and resumable, and only the pass that reaches its end marks.
   * (iii) **A marked legacy entry that no document names gets
   *       `unreferenced_at = now()`,** not a backdated stamp, so it drains
   *       after the grace period rather than on the same pass -- which leaves
   *       a window for a document write, an undo or a restore to claim it
   *       back.
   *
   * The mark is itself batched (see {@link markLegacyEntries}), and that
   * cannot weaken any of the three. Each batch marks and stamps the same rows
   * in one transaction, so (iii) holds per batch rather than only at the end,
   * and a batch that fails leaves its rows legacy -- which keeps (i)'s gate
   * shut, because the gate is re-asked of the database on this pass and every
   * later one. The gate opens only once NO legacy row is left, which is after
   * the last batch has both marked and stamped; there is no window in which
   * the gate is open over a row that is committed but not yet considered for a
   * stamp, and even if there were, such a row is not a release candidate --
   * `releaseEntries` takes only entries with `expires_at` or `unreferenced_at`
   * set.
   */
  private async entryLevelPass(now: string, cutoff: string): Promise<EntryLevelPass> {
    let backfilledDocuments = 0;
    let legacyEntriesCommitted = 0;
    let legacyEntriesRemain = await this.hasLegacyEntries();
    if (legacyEntriesRemain) {
      backfilledDocuments = await this.backfillChunk();
      if (this.backfillCursor === null) {
        // The walk reached the end on this pass: (ii) is satisfied, so the
        // entries it covered can be marked, and (iii) stamps the ones no
        // document turned out to name.
        legacyEntriesCommitted = await this.markLegacyEntries();
        legacyEntriesRemain = false;
      }
    }
    if (legacyEntriesRemain) {
      // (i): the walk is unfinished, so the reference table is still a subset
      // of the truth and no entry may be released yet.
      return {
        entriesCollected: 0,
        entriesCapped: false,
        backfilledDocuments,
        legacyEntriesCommitted,
      };
    }
    // The gate is open, so a missing reference row now means what it says.
    // One bounded batch of the sweep, then the release.
    await this.stampUnreferencedSweep();
    const released = await this.releaseEntries(now, cutoff);
    return { ...released, backfilledDocuments, legacyEntriesCommitted };
  }

  /**
   * Stamp one bounded batch of committed entries that no document references.
   *
   * This is the standing counterpart of the legacy mark's per-batch stamp, and
   * it exists because that one cannot reach every row that needs stamping.
   * The document store stamps an entry the moment a write drops its last
   * reference, which covers everything that happens through a write. What it
   * cannot cover is a reference row that went missing WITHOUT such a write:
   * rows removed out of band, or a restore that reinstated documents but not
   * the reference table. Such an entry is committed, unstamped and referenced
   * by nothing, and nothing else in the system would ever look at it again --
   * `releaseEntries` takes only entries with `expires_at` or `unreferenced_at`
   * set, and the blob pass refuses a blob any entry still names. The entry,
   * its bytes and its share of the principal's quota would be held forever.
   *
   * NOT a repair for a mixed tracking state, which is the opposite shape and
   * is worth naming so this is not read as covering it. A `deleteDocument`
   * issued by a store with `trackAssetReferences` off deletes the document
   * rows and nothing else -- `document_asset_refs` has no foreign key to
   * `document_stages` -- so that document's reference rows OUTLIVE it. The
   * entry stays referenced, by rows naming a stage that is gone, which is the
   * state this sweep skips by design and nothing in this package reclaims.
   * `docs/reference-server.md` says why the answer is to roll
   * `trackAssetReferences` and `documentReferences` back together rather than
   * to have the collector guess.
   *
   * Gated on the legacy gate being open, which is invariant (i) again rather
   * than caution: while the walk is unfinished the reference table is a subset
   * of the truth, so "no reference row" does not yet mean "no document names
   * it", and stamping on that basis would start a grace period for media a
   * document still holds.
   *
   * ONE batch per pass, `batchSize` rows, paged by an ascending id cursor that
   * wraps to the start when it reaches the end. The cursor lives in memory,
   * like {@link backfillCursor}: a restart re-walks from the start, which is
   * free because the work is idempotent -- a row already stamped no longer
   * matches the predicate, and a row that gained a reference is skipped by the
   * `NOT EXISTS`. The cost is the honest one: every pass locks one bounded,
   * ascending batch of LIVE entry rows for the length of one short
   * transaction, so a concurrent save touching one of them queues behind it,
   * bounded by that transaction rather than by the table. An orphan therefore
   * becomes a release candidate within `ceil(entries / batchSize)` passes
   * rather than never.
   *
   * The two statements are the same discipline as everywhere else in this
   * file: lock the batch ascending with `FOR UPDATE` (the strength that
   * conflicts with an insert-only reference writer's `KEY SHARE`), then stamp
   * in a separate statement whose fresh READ COMMITTED snapshot sees any
   * reference row that committed while the lock was being waited for.
   */
  private async stampUnreferencedSweep(): Promise<void> {
    const candidates = await this.sweepCandidates();
    if (candidates.length === 0) {
      // The end of the table. Wrap, so the next pass starts over and an entry
      // orphaned behind the cursor is reached.
      this.stampSweepCursor = null;
      return;
    }
    this.stampSweepCursor = candidates[candidates.length - 1] ?? null;
    try {
      await this.lockBoundedTransaction(async (queryable) => {
        const locked = await queryable.query<EntryCandidateRow>(
          `SELECT id
             FROM asset_entries
            WHERE id = ANY($1::text[])
              AND committed_at IS NOT NULL AND unreferenced_at IS NULL
            ORDER BY id ASC
              FOR UPDATE`,
          [candidates],
        );
        const ids = locked.rows.map((row) => row.id);
        if (ids.length === 0) return;
        await queryable.query(
          `UPDATE asset_entries AS entries
              SET unreferenced_at = now()
            WHERE entries.id = ANY($1::text[])
              AND entries.unreferenced_at IS NULL
              AND NOT EXISTS (
                    SELECT 1 FROM document_asset_refs AS refs WHERE refs.asset_id = entries.id
                  )`,
          [ids],
        );
      });
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
  }

  /**
   * The next page of the sweep, read without a lock.
   *
   * Unlike {@link legacyCandidates} this one needs a cursor, because a row it
   * visits usually still matches the predicate afterwards -- a referenced
   * entry is left alone and would otherwise be offered again forever, and the
   * sweep would never reach the row behind it.
   */
  private async sweepCandidates(): Promise<string[]> {
    const cursor = this.stampSweepCursor;
    try {
      const page = await this.queryable.query<EntryCandidateRow>(
        cursor === null
          ? `SELECT id
               FROM asset_entries
              WHERE committed_at IS NOT NULL AND unreferenced_at IS NULL
              ORDER BY id ASC
              LIMIT $1`
          : `SELECT id
               FROM asset_entries
              WHERE committed_at IS NOT NULL AND unreferenced_at IS NULL
                AND id > $2
              ORDER BY id ASC
              LIMIT $1`,
        cursor === null ? [this.batchSize] : [this.batchSize, cursor],
      );
      return page.rows.map((row) => row.id);
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
  }

  private async hasLegacyEntries(): Promise<boolean> {
    try {
      const result = await this.queryable.query(
        `SELECT 1
           FROM asset_entries
          WHERE committed_at IS NULL AND expires_at IS NULL
          LIMIT 1`,
      );
      return result.rows.length > 0;
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
  }

  /**
   * Enumerate the next chunk of documents and insert the reference rows they
   * imply, leaving {@link backfillCursor} at the last stage read -- or back at
   * `null` when the chunk saw the end of the table.
   *
   * Additive only: a chunk never deletes a reference row, so a walk that stops
   * halfway leaves the table a subset of the truth. Ordered by stage id, which
   * is the table's primary key and therefore stable under concurrent writes;
   * a stage inserted behind the cursor is not read by this walk, and does not
   * need to be, because the document store maintains its rows itself.
   *
   * Only the ids are paged outside a transaction. Each document is then RE-READ
   * inside the transaction that inserts its rows, under the stage row's
   * `FOR SHARE` lock -- the same row every tracking write path takes `FOR
   * UPDATE` on. Reading outside and inserting inside would let a concurrent
   * save replace a stage between the two and leave this insert resurrecting a
   * row that save had just deleted: not a lost reference, but a leaked entry
   * and its quota, held forever by a walk that runs once. The lock makes
   * "a subset of the truth, never a superset" true rather than nearly true.
   *
   * One id more than the chunk is read and then discarded, purely to learn
   * whether more documents follow. `rows.length < limit` alone cannot say so
   * when the chunk is exactly full, which would cost every backfill one extra
   * empty pass before it could mark -- and, on a deployment whose document
   * count happens to be a multiple of the chunk size, make the number of
   * passes before reclamation starts depend on that coincidence.
   */
  private async backfillChunk(): Promise<number> {
    const limit = this.referenceBackfillBatchSize;
    let page;
    try {
      page = await this.queryable.query<StageIdRow>(
        this.backfillCursor === null
          ? `SELECT id FROM document_stages ORDER BY id ASC LIMIT $1`
          : `SELECT id FROM document_stages WHERE id > $2 ORDER BY id ASC LIMIT $1`,
        this.backfillCursor === null ? [limit + 1] : [limit + 1, this.backfillCursor],
      );
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
    const hasMore = page.rows.length > limit;
    const ids = page.rows.slice(0, limit).map((row) => row.id);
    for (const stageId of ids) {
      try {
        // One transaction per document: a chunk that fails part-way leaves
        // whole documents backfilled rather than half of one, and the walk is
        // restarted from scratch anyway.
        await this.lockBoundedTransaction(async (queryable) => {
          const stage = await queryable.query<OwnedStageWalkRow>(
            `SELECT id, data, owner_id FROM document_stages WHERE id = $1 FOR SHARE`,
            [stageId],
          );
          const stageRow = stage.rows[0];
          // Deleted since the page was read: it holds no references now, and
          // the delete already released whatever it held.
          if (!stageRow) return;
          // Retired with its rows kept. Its stored JSON still names everything
          // it ever named, so walking it would re-reference what the
          // retirement released. This record is the ONLY reason the walk skips
          // a document whose row is still there: a stamped entry is not a
          // reason, because while this walk is behind, an entry an unwalked
          // LIVE document names looks unreferenced to every other writer too.
          // Asked AFTER the stage row is locked, so a withdrawal racing this
          // walk resolves either way: it commits first and is seen here, or it
          // waits and then removes the rows this inserted.
          if (await documentAssetReferencesWithdrawn(queryable, stageId)) return;
          const scenes = await queryable.query<SceneWalkRow>(
            'SELECT stage_id, id, data FROM document_scenes WHERE stage_id = $1',
            [stageId],
          );
          const scopes = [
            stageAssetScope(stageRow.data),
            ...scenes.rows.map((scene) => sceneAssetScope(scene.id, scene.data)),
          ];
          // Every entry this document's inserts will touch, locked ascending
          // in ONE statement first. Each per-scope insert makes the reference
          // table's foreign key take `KEY SHARE` on the entries it names, so
          // without this the walk acquired entry locks in scope order -- as
          // many sequences as the document has scopes -- and could deadlock
          // the ascending mark of a collector on another instance. `KEY SHARE`
          // is exactly what those inserts take, so this adds no conflict; it
          // only fixes when and in what order they are taken.
          await lockBackfillEntries(
            queryable,
            scopes.flatMap((scope) => [...scope.candidates]),
          );
          const principals = this.assetReferencePrincipals?.(stageRow.owner_id ?? null);
          for (const scope of scopes) {
            await backfillDocumentAssetReferences(queryable, {
              stageId,
              scope,
              ...(principals === undefined ? {} : { principals }),
            });
          }
        });
      } catch (error) {
        // Named, but only as a property: see AssetCollectionFailure. The walk
        // stops here and the cursor stays behind this document, so nothing is
        // marked and invariant (i) keeps the entry pass from releasing
        // anything -- a stalled backfill is safe, just stalled.
        throw collectorFailure(stageId, error);
      }
      this.backfillCursor = stageId;
    }
    if (!hasMore) this.backfillCursor = null;
    return ids.length;
  }

  /**
   * Mark the legacy entries committed, then stamp the marked ones no document
   * names -- in bounded batches, never in one transaction over the table.
   *
   * ## Why batches
   *
   * The unbatched form locked every legacy row and then every committed,
   * unstamped row -- that is every healthy entry on the deployment -- in one
   * transaction, and held those locks for as long as the slowest of them took
   * to acquire. Two consequences, both real on a busy deployment and both in
   * the upgrade window rather than in steady state:
   *
   * - Every document write touching an existing entry queued behind it, up to
   *   the `lock_timeout` budget, and a user save that hit the budget failed
   *   with a lock-timeout error the app's HTTP layer does not retry.
   * - The mark held rows it had already locked while it waited for the next,
   *   so it could take part in a lock cycle with a concurrent save's
   *   `commitReferencedEntries` and be chosen, or make the save be chosen, as
   *   the deadlock victim.
   *
   * A batch takes at most `batchSize` row locks, in ascending id order, and
   * commits. A concurrent save can still contend for the rows of the batch in
   * flight, and either side may still hit `lock_timeout` -- what changes is
   * that the wait is bounded by one batch rather than by the whole table, and
   * that a batch which fails costs only itself.
   *
   * ## Why one transaction per batch marks AND stamps
   *
   * Because that is what makes the work resumable from the DATABASE rather
   * than from memory. A row this transaction does not reach stays legacy, so
   * invariant (i) keeps the gate shut, `hasLegacyEntries` still says so on the
   * next pass, and the walk-then-mark runs again and continues where the
   * failure left it. Nothing is remembered between passes and nothing is
   * undone: what a batch marked stays marked, and what it stamped stays
   * stamped, so a lock timeout can never leave the legacy gate closed forever
   * or lose a stamp.
   *
   * Marking and stamping in two separate walks was the other candidate. It
   * fails exactly there: once the marking walk finished, the last legacy row
   * would be gone and with it the only durable record that the stamping walk
   * still had rows to visit, so a stamping walk interrupted half way would
   * simply never resume, and the entries it had not reached -- committed,
   * referenced by nothing, never stamped -- would never become release
   * candidates at all.
   *
   * ## The three statements per batch
   *
   * (1) Lock this batch's ids with `FOR UPDATE`, ascending, re-checking the
   *     legacy predicate. `FOR UPDATE` rather than the `FOR NO KEY UPDATE` an
   *     `UPDATE` takes by itself, because only `FOR UPDATE` conflicts with the
   *     `KEY SHARE` an insert into `document_asset_refs` takes on the entry it
   *     names: an `UPDATE … WHERE NOT EXISTS (refs)` would neither wait for a
   *     concurrent insert-only reference writer nor see it, and would stamp an
   *     entry a backfill on another instance had just given a reference. That
   *     is not a loss (`releaseEntries` re-checks references before deleting
   *     anything), but it under-counts the principal's live bytes and starts a
   *     grace period that should not have started.
   *
   *     Ascending order is what makes a concurrent writer QUEUE rather than
   *     deadlock, and that only holds because every other writer in this
   *     package acquires the entries of one transaction in one ascending
   *     statement too: a document write through `references.ts` takes the
   *     union of the ids it will reference and the ids it will stop
   *     referencing up front (`lockEntriesInOrder`), and the backfill takes
   *     the union of one document's ids at `FOR KEY SHARE`
   *     (`lockBackfillEntries`) before its per-scope inserts. Ordering one
   *     side alone would not have been enough, and was not: while a save still
   *     took its foreign-key `KEY SHARE` locks one scope at a time, a save
   *     whose first scope named a higher id than its second could hold what
   *     this batch wanted and then wait for what this batch held. The residual
   *     is now a writer outside this discipline -- anything that locks several
   *     `asset_entries` rows in more than one statement, or in another order.
   *
   *     Re-checking the predicate under the lock is what keeps a row a
   *     concurrent save committed between the candidate query and the lock out
   *     of the batch entirely: such a row is referenced by that save, so it
   *     must be neither counted nor stamped here.
   *
   * (2) Mark the locked ids committed. Separate from the stamp rather than one
   *     data-modifying CTE: PostgreSQL does not support updating the same row
   *     twice in one statement, and every row this marks is a row the stamp
   *     may touch.
   *
   * (3) Stamp, restricted to the ids just locked and to the ones no document
   *     references. A separate statement takes a fresh snapshot under READ
   *     COMMITTED, so it sees any reference row that committed while (1) was
   *     waiting, and the locks held since (1) keep a later one from arriving.
   *
   * The stamp here reaches exactly the rows this batch marked, which is
   * narrower than the predicate the unbatched form used ("every committed,
   * unstamped, unreferenced entry"). The rest of that breadth has NOT been
   * dropped -- it moved to {@link stampUnreferencedSweep}, which runs on every
   * pass instead of only on the one that finishes the walk. It had to move
   * rather than stay here: a row this predicate cannot match is a row no
   * number of later passes would reach, because once the last legacy row is
   * marked this function is never called again.
   *
   * ## Termination
   *
   * The loop runs until no legacy candidate is left, rather than stopping
   * after a fixed number of batches and reporting a cap. Stopping early would
   * leave legacy rows behind, and invariant (i) would then hold the entry
   * level shut for another whole interval -- which is the deferral this
   * rework exists to prevent -- while making the next pass repeat the document
   * walk before it could continue. It terminates because nothing creates
   * legacy rows: `PgAssetStore.put` writes all three lifecycle columns, so the
   * candidate set only shrinks, by this loop or by a concurrent save that
   * commits one of them.
   */
  private async markLegacyEntries(): Promise<number> {
    let marked = 0;
    for (;;) {
      const candidates = await this.legacyCandidates();
      if (candidates.length === 0) return marked;
      marked += await this.markLegacyBatch(candidates);
    }
  }

  /**
   * The next batch of legacy ids, read without a lock.
   *
   * No cursor: the rows this returns are the ones the batch below removes from
   * the predicate, so the next call starts where this one stopped without
   * having to remember anything, and a row a concurrent writer un-legacies is
   * simply not offered again. `asset_entries_legacy_idx` is the partial index
   * on exactly this predicate, so each call is a short read off its front
   * rather than a scan of the table.
   */
  private async legacyCandidates(): Promise<string[]> {
    try {
      const page = await this.queryable.query<EntryCandidateRow>(
        `SELECT id
           FROM asset_entries
          WHERE committed_at IS NULL AND expires_at IS NULL
          ORDER BY id ASC
          LIMIT $1`,
        [this.batchSize],
      );
      return page.rows.map((row) => row.id);
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
  }

  /** One bounded lock-mark-stamp transaction; see {@link markLegacyEntries}. */
  private async markLegacyBatch(candidates: readonly string[]): Promise<number> {
    try {
      return await this.lockBoundedTransaction(async (queryable) => {
        const locked = await queryable.query<EntryCandidateRow>(
          `SELECT id
             FROM asset_entries
            WHERE id = ANY($1::text[])
              AND committed_at IS NULL AND expires_at IS NULL
            ORDER BY id ASC
              FOR UPDATE`,
          [candidates],
        );
        const ids = locked.rows.map((row) => row.id);
        if (ids.length === 0) return 0;
        await queryable.query(
          `UPDATE asset_entries
              SET committed_at = now()
            WHERE id = ANY($1::text[])`,
          [ids],
        );
        await queryable.query(
          `UPDATE asset_entries AS entries
              SET unreferenced_at = now()
            WHERE entries.id = ANY($1::text[])
              AND entries.unreferenced_at IS NULL
              AND NOT EXISTS (
                    SELECT 1 FROM document_asset_refs AS refs WHERE refs.asset_id = entries.id
                  )`,
          [ids],
        );
        return ids.length;
      });
    } catch (error) {
      throw collectorFailure(undefined, error);
    }
  }

  /**
   * Release at most `batchSize` eligible entries, each locked and re-checked
   * in its own transaction, exactly as the blob pass does.
   *
   * Eligible means pending and past its expiry, or committed and unreferenced
   * for longer than the grace period. Oldest first on whichever of the two
   * timestamps made it eligible, for the same anti-starvation reason the blob
   * pass orders by `unreferenced_at`: both are arrival stamps, so this is
   * arrival order, and the id breaks ties within one timestamp only.
   */
  private async releaseEntries(now: string, cutoff: string): Promise<ReleasedEntries> {
    let candidates;
    try {
      candidates = await this.queryable.query<EntryCandidateRow>(
        `SELECT id
           FROM asset_entries
          WHERE (expires_at IS NOT NULL AND expires_at < $1::timestamptz)
             OR (unreferenced_at IS NOT NULL AND unreferenced_at < $2::timestamptz)
          ORDER BY COALESCE(expires_at, unreferenced_at) ASC, id ASC
          LIMIT $3`,
        [now, cutoff, this.batchSize],
      );
    } catch (error) {
      throw collectorFailure(undefined, error);
    }

    let entriesCollected = 0;
    for (const candidate of candidates.rows) {
      try {
        const didCollect = await this.lockBoundedTransaction(async (queryable) => {
          // TWO statements, deliberately, and the split is load-bearing.
          //
          // The first one locks: it re-checks the entry's own timestamps and
          // takes `FOR UPDATE`. A document write racing the candidate query
          // above both clears those timestamps and inserts a reference row, so
          // when this statement waits on that writer's lock PostgreSQL
          // re-evaluates the predicate against the updated row (EvalPlanQual)
          // and the entry is skipped.
          //
          // The second one asks about references, and it has to be its own
          // statement because that re-evaluation only happens when the LOCKED
          // row changed. The backfill is an insert-only reference writer: it
          // inserts into `document_asset_refs`, which takes `KEY SHARE` on the
          // entry row but never updates it. A `NOT EXISTS` folded into the
          // statement above would therefore block on that lock, be granted it
          // when the backfill commits, find the entry row unchanged, and keep
          // the answer it computed from its own statement-start snapshot --
          // "no reference" -- while a committed reference row existed. The
          // entry would be deleted and the cascade would take the backfill's
          // row with it, leaving a document naming bytes that are gone. Under
          // READ COMMITTED a separate statement takes a fresh snapshot, so it
          // sees that row. (Two collector instances are needed to reach this:
          // one instance runs its backfill and its entry pass in sequence.)
          //
          // Holding `FOR UPDATE` across the second statement is what makes the
          // answer stay true: a reference insert arriving after it needs
          // `KEY SHARE` on this row and blocks until this transaction ends.
          const locked = await queryable.query<EntryLockRow>(
            `SELECT id, content_hash
               FROM asset_entries
              WHERE id = $1
                AND ((expires_at IS NOT NULL AND expires_at < $2::timestamptz)
                  OR (unreferenced_at IS NOT NULL AND unreferenced_at < $3::timestamptz))
              FOR UPDATE`,
            [candidate.id, now, cutoff],
          );
          const entry = locked.rows[0];
          if (!entry) return false;
          const referenced = await queryable.query(
            'SELECT 1 FROM document_asset_refs WHERE asset_id = $1 LIMIT 1',
            [entry.id],
          );
          // What makes "eligible" mean "no document names it" rather than "a
          // column says so".
          if (referenced.rows.length > 0) return false;
          // Exactly what `remove` does, in the same order: delete the one row,
          // then stamp the blob when no entry names those bytes any more. Any
          // reference row would go with it through the table's cascade; the
          // fresh-snapshot check above proves there is none, and the lock held
          // since then proves none has arrived.
          await queryable.query('DELETE FROM asset_entries WHERE id = $1', [entry.id]);
          await queryable.query(
            `UPDATE asset_blobs
                SET unreferenced_at = now()
              WHERE content_hash = $1
                AND NOT EXISTS (
                      SELECT 1 FROM asset_entries WHERE content_hash = $1
                    )`,
            [entry.content_hash],
          );
          return true;
        });
        if (didCollect) entriesCollected += 1;
      } catch (error) {
        throw collectorFailure(undefined, error);
      }
    }
    return {
      entriesCollected,
      entriesCapped: candidates.rows.length >= this.batchSize,
    };
  }
}

export type { AssetByteStore } from './byte-store.js';
export type { Queryable, WithTransaction } from '../runtime/pg.js';
export { StorageLockUnavailableError, type StorageLockUnavailableReason } from '../runtime/pg.js';
