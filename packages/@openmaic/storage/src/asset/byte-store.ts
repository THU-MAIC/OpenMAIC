/**
 * The pluggable byte layer beneath a server asset registry.
 *
 * The registry — ids, owners, media types, metadata, and the reference count —
 * always lives in a transactional store. The bytes do not have to: they may sit
 * in a column of that store, or in an object store addressed by content hash.
 * Two implementations ship, which is why this interface exists at all. An
 * interface with one implementation is not a seam, and this package has removed
 * one such seam before rather than carry it.
 *
 * What makes the layer separable is that **reclamation is offline**. If a
 * request could delete bytes, a concurrent write deduplicating onto those same
 * bytes could commit against them, and a byte layer outside the registry's
 * transaction would have no way to serialize the two — which is exactly what
 * would force bytes into that transaction. With collection moved out of every
 * request path, what remains is an ordering rule rather than an atomicity one:
 *
 * - bytes are written **before** the row that references them, so a crash
 *   between the two costs storage and loses nothing (the reverse order would
 *   leave a registry entry pointing at bytes that were never stored);
 * - bytes are deleted **after** the last row referencing them, and only by the
 *   offline collector;
 * - the reference count and the decision to collect are serialized on the blob
 *   row, which every implementation keeps regardless of where bytes live.
 *
 * Note what this interface deliberately does not have: no reference counting,
 * no ownership, no deduplication decision. Those belong to the registry. A byte
 * layer stores and returns bytes under a hash and knows nothing about who
 * references them, which is what keeps the global byte pool free of principals.
 */
import type { ContentHash } from './blob.js';

export interface AssetByteStore {
  /**
   * Store bytes under their content hash.
   *
   * Unconditional and idempotent: writing bytes that are already stored MUST
   * succeed and MUST NOT report that they were present. The registry above
   * relies on this to keep its two write paths indistinguishable, so an
   * implementation must not read first, and must not return anything that
   * varies with prior presence.
   */
  write(hash: ContentHash, bytes: Uint8Array): Promise<void>;

  /**
   * Read the bytes stored under a hash, or `null` if there are none.
   *
   * A miss is not an error. A registry entry whose bytes have been collected
   * out from under it resolves to a miss, and inventing an error here would
   * make collection observable.
   */
  read(hash: ContentHash): Promise<Uint8Array | null>;

  /**
   * Delete the bytes stored under a hash.
   *
   * **Only the offline collector calls this.** No request path may, which is
   * the property that lets bytes live outside the registry's transaction at
   * all. Idempotent: deleting bytes that are absent succeeds.
   */
  delete(hash: ContentHash): Promise<void>;
}
