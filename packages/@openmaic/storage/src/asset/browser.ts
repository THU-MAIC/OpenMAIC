import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';

export interface BrowserAssetProviderOptions {
  /** IndexedDB factory. Defaults to the ambient `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  /** Database name. Defaults to `maic-assets`. */
  dbName?: string;
}

const STORE = 'assets';

interface StoredAsset {
  bytes: ArrayBuffer;
  contentType: string;
}

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Browser `StorageProvider` backend: bytes live in IndexedDB, and `resolve`
 * hands back a `blob:` object URL for use as a media `src`. Refs are
 * content-addressed (`sha256-<hex>`), so identical bytes de-duplicate to one
 * stored asset and one stable ref.
 */
export class BrowserAssetProvider implements StorageProvider {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private dbPromise?: Promise<IDBDatabase>;
  /**
   * ref → the in-flight/settled object-URL resolution. Keyed on the promise so
   * concurrent `resolve(ref)` calls share one `URL.createObjectURL` (never
   * orphaning a second URL), and repeated `resolve` returns one stable URL.
   */
  private readonly urls = new Map<AssetRef, Promise<string | null>>();

  constructor(options: BrowserAssetProviderOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-assets';
  }

  private openDb(): Promise<IDBDatabase> {
    // Do NOT cache a rejected open: a transient failure (private-mode IDB, a
    // one-off VersionError) would otherwise brick the provider for the whole
    // session. Clear the memo on failure so the next call retries.
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = undefined;
      throw err;
    });
    return this.dbPromise;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const req = run(transaction.objectStore(STORE));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      // Resolve on commit, not on the request success: a write that succeeds
      // as a request can still abort at commit (e.g. QuotaExceededError), and
      // reporting that as success would claim durability the store never gave.
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? req.error);
      transaction.onabort = () => reject(transaction.error ?? req.error);
    });
  }

  private async computeRef(data: BinaryBlob): Promise<{ ref: AssetRef; bytes: ArrayBuffer }> {
    const bytes = await data.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { ref: `sha256-${toHex(digest)}`, bytes };
  }

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    const { ref, bytes } = await this.computeRef(data);
    const asset: StoredAsset = { bytes, contentType: meta?.contentType ?? data.type ?? '' };
    await this.tx('readwrite', (store) => store.put(asset, ref));
    // A re-put with the same bytes but different metadata (e.g. a corrected
    // contentType) overwrites the stored asset; drop any cached object URL for
    // this ref so resolve() reflects the latest write instead of a stale one.
    // Without this, resolved MIME would depend on cache warmth (a fresh
    // provider would see the new type, this one the old).
    await this.invalidateUrl(ref);
    return ref;
  }

  /** Revoke and forget the cached object URL for a ref, if any. */
  private async invalidateUrl(ref: AssetRef): Promise<void> {
    const pending = this.urls.get(ref);
    if (!pending) return;
    this.urls.delete(ref);
    const url = await pending.catch(() => null);
    if (url) URL.revokeObjectURL(url);
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    const cached = this.urls.get(ref);
    if (cached) return cached;
    const pending = this.readAsUrl(ref);
    this.urls.set(ref, pending);
    try {
      const url = await pending;
      // Don't cache a miss: a later put(sameBytes) + resolve must succeed. Only
      // a real URL stays memoized (and is revoked on remove).
      if (url === null) this.urls.delete(ref);
      return url;
    } catch (err) {
      // Don't cache a transient failure either — otherwise every later
      // resolve(ref) replays the same rejection, defeating openDb's retry.
      this.urls.delete(ref);
      throw err;
    }
  }

  private async readAsUrl(ref: AssetRef): Promise<string | null> {
    const asset = await this.tx<StoredAsset | undefined>('readonly', (store) => store.get(ref));
    if (!asset) return null;
    return URL.createObjectURL(new Blob([asset.bytes], { type: asset.contentType }));
  }

  async remove(ref: AssetRef): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(ref));
    await this.invalidateUrl(ref);
  }
}
