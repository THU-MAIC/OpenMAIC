/** Offline reclamation for unreferenced server asset bytes. */
import type { ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';
import type { Queryable, WithTransaction } from '../runtime/pg.js';

/** One hour. A deployment may choose a longer retention window. */
export const DEFAULT_ASSET_COLLECTION_GRACE_MS = 60 * 60 * 1000;

export interface AssetCollectorOptions {
  /** Pin each per-blob callback to a fresh PostgreSQL transaction. */
  withTransaction: WithTransaction;
  /** Minimum age of an unreferenced row before collection. Defaults to one hour. */
  graceMs?: number;
  /** Clock override for deterministic hosts and tests. */
  now?: () => Date;
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

/**
 * Re-runnable collector for the byte rows left behind by request operations.
 *
 * This is the only component that calls `AssetByteStore.delete`. Hosts must
 * schedule it: leaving it unscheduled lets unreferenced storage grow without
 * bound.
 */
export class AssetCollector {
  private readonly transactionHook: WithTransaction;
  private readonly graceMs: number;
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
    this.transactionHook = options.withTransaction;
    this.graceMs = graceMs;
    this.now = options.now ?? (() => new Date());
  }

  async collect(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.graceMs).toISOString();
    let candidates;
    try {
      candidates = await this.queryable.query<CandidateRow>(
        `SELECT content_hash
           FROM asset_blobs
          WHERE unreferenced_at < $1::timestamptz
          ORDER BY unreferenced_at ASC, content_hash ASC`,
        [cutoff],
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
    return collected;
  }
}

export type { AssetByteStore } from './byte-store.js';
export type { Queryable, WithTransaction } from '../runtime/pg.js';
