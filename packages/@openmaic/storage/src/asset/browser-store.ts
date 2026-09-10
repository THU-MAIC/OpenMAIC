/**
 * Browser asset pool: an **allocated-id registry with an embedded
 * content-addressed byte table**, both in one IndexedDB database.
 *
 * The reference chain is `assetId → contentHash → bytes`, deliberately neither
 * pure content-addressing nor pure allocation:
 *
 * - **Stable identity.** A document embeds the allocated `assetId`. Replacing
 *   the bytes behind an entry with {@link BrowserAssetStore.replace} does not
 *   invalidate the references pointing at it, and one set of bytes may back
 *   several entries with different ids and different metadata.
 * - **Byte de-duplication.** Identical bytes occupy one `blobs` row no matter
 *   how many registry entries name them.
 * - **The hash is never a reference.** `contentHash` lives only inside the
 *   registry and is never returned, logged in an error, or accepted as an
 *   input. The threat that pure content-addressing has to defend against —
 *   "whoever knows the hash can reach the bytes" — structurally does not arise,
 *   which is what lets the byte table stay global and metadata-free.
 *
 * Two object stores, one database, so a `put` and a `remove` that touch the
 * same bytes are serialized by IndexedDB rather than racing across two
 * databases: reference counting happens *inside* the same transaction that
 * deletes the entry, so the last entry's removal can never reclaim bytes a
 * concurrent `put` has just adopted. The byte table is deliberately not a
 * replaceable backend *here*: byte writes, reference counting, and reclamation
 * must share this transaction, because this store reclaims **inline** — a
 * `remove` that drops the last reference deletes the bytes in the same
 * transaction. Bytes outside that transaction could be deleted while a
 * concurrent `put` adopted them, with nothing able to serialize the two.
 *
 * The server backend is not bound this way, and the difference is reclamation
 * rather than storage. It collects offline, so no request path ever deletes
 * bytes, and its byte layer is genuinely pluggable — a column of the
 * transactional store or an object store keyed by content hash.
 *
 * On successful `put` calls, every returned value and every branch taken
 * reveals nothing about whether the bytes already existed — see
 * {@link BrowserAssetStore.put}. Resource-accounting channels such as quota
 * failures and storage estimates remain outside that guarantee.
 *
 * Object URLs are deliberately minted per asset id, not per content hash.
 * Sharing one URL across ids that name identical bytes would let a holder of
 * both ids discover byte equality by comparing the returned strings. Each
 * `replace` followed by `resolve` adds one retired snapshot that only `release`
 * for that id or `close` reclaims. Each ref retains at most one current
 * snapshot plus that retired history. A returned URL is an immutable snapshot:
 * it pins its full Blob in this instance until that explicit reclamation.
 * Mutations affect future resolutions but never revoke an already-issued
 * snapshot; media-heavy applications should release snapshots they no longer
 * use or close the store.
 *
 * Every `resolve` spends one IndexedDB round trip checking the registry entry,
 * and a warm URL is valid only while the entry still names the content hash
 * from which that URL was minted. This per-resolve identity check is the whole
 * cross-instance correctness mechanism. After external tampering deletes a
 * blob row but leaves its entry, a warm instance may keep serving its
 * already-minted URL while a cold instance reports a miss. Store operations
 * cannot create that state because `put`, `replace`, and `remove` update both
 * rows atomically.
 */
import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { contentHashOf, ObjectUrlCache, type ContentHash } from './blob.js';
import { newAssetId, type AssetId } from './id.js';

/**
 * Browser asset-store persistence options.
 *
 * Asset ids are always allocated by the package's secure id source and are
 * deliberately not configurable per store instance.
 */
export interface BrowserAssetStoreOptions {
  /** IndexedDB factory. Defaults to the ambient `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  /** Database name. Defaults to `maic-asset-pool`. */
  dbName?: string;
}

/** Registry table: `assetId → entry`. */
const ASSETS = 'assets';
/** Blob table: `contentHash → bytes`. */
const BLOBS = 'blobs';
/** Index over {@link AssetEntry.contentHash}, the reference count `remove` reads. */
const BY_CONTENT_HASH = 'by-content-hash';

function incompatibleSchemaError(dbName: string): Error {
  return new Error(
    `IndexedDB database "${dbName}" has an incompatible asset schema. ` +
      'It may have been created by the 0.1.x content-addressed BrowserAssetProvider or another incompatible version. ' +
      'Use a fresh dbName, or wait for or request the explicit one-time import helper.',
  );
}

/**
 * One registry row. `mime` is a column, not a partition: images, audio and
 * video share one id space and one table, because splitting by medium is
 * exactly the fault this layer exists to remove.
 *
 * There is deliberately **no `principal` column here**. A principal is a
 * server-side concept derived from an authenticated session — the browser
 * backend has no session to derive one from, so modelling it here would mean
 * storing a value the client itself supplies, which authorizes nothing. The
 * registry gains its principal column when it gains a server backend.
 */
interface AssetEntry {
  contentHash: ContentHash;
  /**
   * Resolved MIME type, from `meta.contentType` or the blob's own type.
   * This browser-only Part 1 backend trusts its same-app caller; a server
   * backend must validate or allowlist content types before serving bytes.
   */
  mime: string;
  /** Caller-owned provenance (prompt, model, dimensions, filename, …). */
  meta: AssetMeta;
}

interface RegistryObjectUrlIdentity {
  contentHash: ContentHash;
  mime: string;
}

/**
 * Promisify a single IndexedDB request.
 *
 * Awaiting one of these inside a multi-step transaction cannot strand the
 * caller: aborting a transaction fires `error` at every request still in its
 * request list, and a request issued *after* the abort throws synchronously on
 * the now-inactive transaction. Either way the step settles.
 */
function reqP<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function cloneMeta(meta: AssetMeta): AssetMeta {
  try {
    return structuredClone(meta);
  } catch (cause) {
    throw new TypeError('Asset metadata values must be structured-cloneable.', { cause });
  }
}

interface AssetStores {
  assets: IDBObjectStore;
  blobs: IDBObjectStore;
}

/**
 * The exported browser backend for the DSL asset seam ({@link StorageProvider}).
 */
export class BrowserAssetStore implements StorageProvider {
  private readonly idb?: IDBFactory;
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;
  private readonly urls = new ObjectUrlCache<RegistryObjectUrlIdentity>(
    (left, right) => left.contentHash === right.contentHash && left.mime === right.mime,
  );
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: BrowserAssetStoreOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-asset-pool';
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('BrowserAssetStore is closed.');
  }

  private openDb(): Promise<IDBDatabase> {
    this.assertOpen();
    if (!this.idb) {
      throw new Error(
        'IndexedDB is unavailable; BrowserAssetStore cannot operate in this environment.',
      );
    }
    const idb = this.idb;
    // Do NOT cache a rejected open: a transient failure (private-mode IDB, a
    // one-off VersionError) would otherwise brick the store for the whole
    // session. Clear the memo on failure so the next call retries.
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(this.dbName, 1);
      // Add future schema migrations in the onupgradeneeded ladder for version 2.
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(ASSETS)) {
          const assets = db.createObjectStore(ASSETS);
          assets.createIndex(BY_CONTENT_HASH, 'contentHash', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        try {
          const hasExpectedStores =
            db.objectStoreNames.contains(ASSETS) && db.objectStoreNames.contains(BLOBS);
          const hasExpectedIndex =
            hasExpectedStores &&
            db
              .transaction(ASSETS, 'readonly')
              .objectStore(ASSETS)
              .indexNames.contains(BY_CONTENT_HASH);
          if (!hasExpectedStores || !hasExpectedIndex) {
            db.close();
            reject(incompatibleSchemaError(this.dbName));
            return;
          }
          resolve(db);
        } catch {
          db.close();
          reject(incompatibleSchemaError(this.dbName));
        }
      };
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = undefined;
      throw err;
    });
    return this.dbPromise;
  }

  /**
   * Run a multi-step transaction spanning both stores.
   *
   * `run` may await between requests: every await inside it settles from an
   * IndexedDB event, which keeps the transaction alive. Anything slower (a
   * `crypto.subtle.digest`, a network call) must happen *before* the
   * transaction opens, or the transaction auto-commits mid-step.
   *
   * Resolves on commit, not on request success: a write that succeeds as a
   * request can still abort at commit (e.g. `QuotaExceededError`), and
   * reporting that as success would claim durability the store never gave —
   * the durability rule for this store.
   */
  private async tx<T>(
    mode: IDBTransactionMode,
    run: (stores: AssetStores) => Promise<T>,
  ): Promise<T> {
    const db = await this.openDb();
    const transaction = db.transaction([ASSETS, BLOBS], mode);
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB error'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    const outcome = await run({
      assets: transaction.objectStore(ASSETS),
      blobs: transaction.objectStore(BLOBS),
    }).then(
      (value) => ({ value }),
      (error: unknown) => {
        // Never leave a half-applied transaction open behind a thrown step.
        try {
          transaction.abort();
        } catch {
          /* already finished — nothing to abort */
        }
        return { error };
      },
    );
    if ('error' in outcome) {
      await committed.catch(() => undefined);
      throw outcome.error;
    }
    await committed;
    return outcome.value;
  }

  /**
   * Store bytes and return a **newly allocated** id for them.
   *
   * Every call allocates a fresh id and writes a fresh registry entry, whether
   * or not these bytes were already in the pool. On the success path there is
   * no branch on existence to observe. The blob write is an unconditional
   * overwrite rather than a read-then-write, so the two cases run the same
   * statements, issue the same IndexedDB requests, and return the same shape —
   * a fresh id, indistinguishable from any other.
   *
   * Resource-accounting channels are not hidden: quota errors, storage
   * estimates, and server-side billing or metering may disclose whether bytes
   * were already present. Server deployments must budget those channels per
   * principal. Wall-clock timing is likewise not claimed to be constant.
   */
  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetId> {
    this.assertOpen();
    const storedMeta = meta === undefined ? {} : cloneMeta(meta);
    const dataType = data.type ?? '';
    const { contentHash, bytes } = await contentHashOf(data);
    const entry: AssetEntry = {
      contentHash,
      mime: storedMeta.contentType ?? dataType,
      meta: storedMeta,
    };
    const id = newAssetId();
    await this.tx('readwrite', async ({ assets, blobs }) => {
      await reqP(blobs.put(bytes, contentHash));
      await reqP(assets.add(entry, id));
    });
    return id;
  }

  /**
   * Resolve an id to a `blob:` URL, or `null` when nothing is stored under it.
   *
   * The id is treated as an opaque string. An id this store never allocated,
   * an id from another id space, an empty string, a string with a NUL in it —
   * all are misses, none are errors. There is no id validator to disagree with
   * (see `toAssetId`).
   *
   * Every call reads the registry entry and compares its content hash and MIME
   * with the identity recorded alongside this instance's current URL. A
   * missing entry retires that snapshot and returns `null`; a changed identity
   * retires it and mints from the current row. Retired snapshots remain alive,
   * so a URL already returned to a caller is immutable and mutations affect
   * future resolutions only.
   *
   * A cold resolution reads the registry a second time in the same transaction
   * as its blob bytes. The returned URL is therefore a snapshot of either the
   * old or new committed entry when `replace` races the resolve; folding the
   * first row into a later blob-only read would let reclamation remove those
   * bytes between transactions.
   *
   * A resolve that passes the open check but races `close` may return a
   * non-null URL that `close` has already revoked; callers tearing down should
   * not race resolve against close.
   */
  async resolve(ref: AssetRef): Promise<string | null> {
    this.assertOpen();
    const entry = await this.tx('readonly', async ({ assets }) => {
      return reqP<AssetEntry | undefined>(assets.get(ref));
    });
    if (!entry) {
      await this.urls.invalidate(ref);
      return null;
    }
    this.assertOpen();
    const identity: RegistryObjectUrlIdentity = {
      contentHash: entry.contentHash,
      mime: entry.mime,
    };
    return this.urls.resolve(ref, identity, () => this.readAsUrl(ref));
  }

  /**
   * Revoke this instance's current and retired snapshots for `ref` without
   * changing the registry.
   *
   * This is an owner-level operation: it is safe only when the caller owns
   * every consumer of every URL returned for that ref in this instance.
   * Concurrent resolves deliberately share the current URL, and replaced
   * identities remain pinned as retired snapshots until this call. Idempotent;
   * an unknown or uncached ref is a no-op.
   */
  async release(ref: AssetRef): Promise<void> {
    this.assertOpen();
    await this.openDb();
    await this.urls.release(ref);
  }

  /** Retire this instance's cached snapshot without revoking any issued URL. */
  async invalidate(ref: AssetRef): Promise<void> {
    this.assertOpen();
    await this.openDb();
    await this.urls.invalidate(ref);
  }

  /**
   * Metadata-only existence probe: the registry entry lookup alone, with no
   * blob read and no URL minted. This is what migration-time checks should
   * use; resolve downloads and pins.
   */
  async exists(ref: AssetRef): Promise<boolean> {
    this.assertOpen();
    const entry = await this.tx('readonly', async ({ assets }) => {
      return reqP<AssetEntry | undefined>(assets.get(ref));
    });
    return entry !== undefined;
  }

  /**
   * Replace the bytes behind an allocated id without changing that id.
   *
   * The digest is computed before the transaction. The blob write, registry
   * update, old-hash reference count, and possible old-blob reclamation then
   * commit in one transaction. Like `put`, the success path unconditionally
   * writes the new bytes and does not reveal whether they were already pooled.
   * Replacing an unallocated id is a caller error and rejects loudly.
   *
   * MIME and metadata travel together. When metadata is supplied, MIME comes
   * from its cloned `contentType`, then the blob type. When metadata is omitted,
   * the old metadata is retained and a typed blob updates MIME while an
   * untyped regenerated blob inherits the old MIME.
   */
  async replace(ref: AssetId, data: BinaryBlob, meta?: AssetMeta): Promise<void> {
    this.assertOpen();
    const storedMeta = meta === undefined ? undefined : cloneMeta(meta);
    const dataType = data.type ?? '';
    const { contentHash, bytes } = await contentHashOf(data);
    await this.tx('readwrite', async ({ assets, blobs }) => {
      const oldEntry = await reqP<AssetEntry | undefined>(assets.get(ref));
      if (!oldEntry) throw new Error('Cannot replace an unknown asset id.');

      await reqP(blobs.put(bytes, contentHash));
      const nextEntry: AssetEntry = {
        contentHash,
        mime:
          storedMeta === undefined
            ? dataType || oldEntry.mime
            : (storedMeta.contentType ?? dataType),
        meta: storedMeta ?? oldEntry.meta,
      };
      await reqP(assets.put(nextEntry, ref));

      const remaining = await reqP<number>(
        assets.index(BY_CONTENT_HASH).count(oldEntry.contentHash),
      );
      if (remaining === 0) await reqP(blobs.delete(oldEntry.contentHash));
    });
    await this.urls.invalidate(ref);
  }

  private async readAsUrl(
    ref: AssetRef,
  ): Promise<{ identity: RegistryObjectUrlIdentity; url: string } | null> {
    const asset = await this.tx('readonly', async ({ assets, blobs }) => {
      const entry = await reqP<AssetEntry | undefined>(assets.get(ref));
      if (!entry) return null;
      const bytes = await reqP<ArrayBuffer | undefined>(blobs.get(entry.contentHash));
      // A registry entry whose bytes are gone resolves to a miss rather than
      // throwing: to the caller it is the same "no asset here" as an unknown
      // id, and inventing an error would make byte reclamation observable.
      if (!bytes) return null;
      return { bytes, contentHash: entry.contentHash, mime: entry.mime };
    });
    if (!asset) return null;
    // Mint only after the readonly transaction commits, so an aborted read
    // cannot leak an object URL that no caller ever receives.
    return {
      identity: {
        contentHash: asset.contentHash,
        mime: asset.mime,
      },
      url: URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime })),
    };
  }

  /**
   * Drop the registry entry for an id, reclaiming its bytes if it was the last
   * entry naming them. Idempotent: removing an unknown or already-removed id
   * is a no-op, not an error.
   *
   * The reference count is read *inside* the same transaction as the delete,
   * over the `contentHash` index. That is what makes reclamation safe against a
   * concurrent `put` of the same bytes: IndexedDB serializes readwrite
   * transactions over the same stores, so the count either already includes the
   * new entry (and the bytes stay) or the new entry's transaction has not begun
   * (and it will rewrite the bytes itself, unconditionally).
   */
  async remove(ref: AssetRef): Promise<void> {
    this.assertOpen();
    await this.tx('readwrite', async ({ assets, blobs }) => {
      const entry = await reqP<AssetEntry | undefined>(assets.get(ref));
      if (!entry) return;
      await reqP(assets.delete(ref));
      const remaining = await reqP<number>(assets.index(BY_CONTENT_HASH).count(entry.contentHash));
      if (remaining === 0) await reqP(blobs.delete(entry.contentHash));
    });
    await this.urls.invalidate(ref);
  }

  /**
   * Close this store instance.
   *
   * Closing is idempotent. It closes any opened IndexedDB connection and
   * revokes every current, in-flight, and retired object-URL snapshot. A mint
   * that settles after shutdown begins is revoked immediately. Every later
   * operation fails loudly with a "store is closed" error. If an unawaited
   * `release` is already in flight, its last URL may be revoked one microtask
   * after this call resolves.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const closeDb = this.dbPromise
      ? this.dbPromise.then(
          (db) => db.close(),
          () => undefined,
        )
      : Promise.resolve();
    this.closePromise = Promise.all([this.urls.close(), closeDb]).then(() => undefined);
    return this.closePromise;
  }
}
