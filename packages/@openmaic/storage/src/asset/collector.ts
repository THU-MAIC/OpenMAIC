/** Offline reclamation for unreferenced server asset bytes. */
import type { ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';
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

export interface AssetCollectorOptions {
  /** Pin each per-blob callback to a fresh PostgreSQL transaction. */
  withTransaction: WithTransaction;
  /** Minimum age of an unreferenced row before collection. Defaults to one hour. */
  graceMs?: number;
  /** Most blobs one `collect` takes. Defaults to one thousand. */
  batchSize?: number;
  /** Clock override for deterministic hosts and tests. */
  now?: () => Date;
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
}

interface CandidateRow extends Record<string, unknown> {
  content_hash: ContentHash;
}

interface TransactionalByteDeleter extends AssetByteStore {
  deleteWith(queryable: Queryable, hash: ContentHash): Promise<void>;
}

function hasTransactionalDeleter(store: AssetByteStore): store is TransactionalByteDeleter {
  return 'deleteWith' in store && typeof store.deleteWith === 'function';
}

function collectorFailure(): Error {
  return new Error('@openmaic/storage: asset collection failed');
}

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
 * Re-runnable collector for the byte rows left behind by request operations.
 *
 * This is the only component that calls `AssetByteStore.delete`. Hosts must
 * schedule it: leaving it unscheduled lets unreferenced storage grow without
 * bound.
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
    this.transactionHook = options.withTransaction;
    this.graceMs = graceMs;
    this.batchSize = batchSize;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Run one bounded pass and resolve to the number of blobs it deleted, which
   * is never above `batchSize`.
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
    const cutoff = new Date(this.now().getTime() - this.graceMs).toISOString();
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
    } catch {
      throw collectorFailure();
    }

    let collected = 0;
    for (const candidate of candidates.rows) {
      try {
        const didCollect = await this.transactionHook(async (queryable) => {
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
      } catch {
        throw collectorFailure();
      }
    }
    return { collected, capped: candidates.rows.length >= this.batchSize };
  }
}

export type { AssetByteStore } from './byte-store.js';
export type { Queryable, WithTransaction } from '../runtime/pg.js';
