/**
 * The asset-storage seam the DSL owns the *shape* of.
 *
 * Large binaries (generated images / audio / video) never live inside a DSL
 * document — a document embeds only a stable {@link AssetRef}, and a
 * {@link StorageProvider} resolves that ref to a URL at render time. The
 * indirection is what keeps a document portable: a raw URL would bake in a
 * particular provider and an expiry assumption, so it cannot travel with the
 * document to another runtime. `@openmaic/renderer` already consumes resolved
 * URLs via its media slots; `@openmaic/exporter` will consume the set of refs a
 * document touches as its asset manifest.
 *
 * The DSL owns only this interface (the contract). Concrete backends —
 * IndexedDB + object URLs in the browser, object storage / CDN on a server —
 * live in `@openmaic/storage`, keeping this package dependency- and DOM-free.
 */

/**
 * A stable, backend-agnostic handle to a stored asset. A plain string so it
 * embeds cleanly in DSL documents (e.g. `PPTImageElement.src`,
 * `PPTVideoElement.mediaRef`). Opaque to consumers: only the issuing
 * {@link StorageProvider} interprets it.
 */
export type AssetRef = string;

/** Optional metadata recorded alongside an asset. */
export interface AssetMeta {
  /** MIME type, e.g. `image/png`. */
  contentType?: string;
  [key: string]: unknown;
}

/**
 * The minimal structural view of a binary blob the storage contract needs,
 * satisfied by the platform `Blob` (browser and Node ≥18) without binding this
 * pure package to the DOM lib. Backends in `@openmaic/storage` accept a real
 * `Blob`; the DSL stays `lib: ES2022` (no DOM) as designed.
 */
export interface BinaryBlob {
  /** Size in bytes. */
  readonly size: number;
  /** MIME type (`''` when unknown), mirroring `Blob.type`. */
  readonly type: string;
  /** The blob's bytes. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The blob-resolution contract: store bytes, get back a stable ref, and resolve
 * a ref to a URL usable as an `<img>` / `<audio>` / `<video>` `src`.
 * Implementations decide the ref scheme (content-addressed hashing is
 * recommended so identical bytes de-duplicate).
 */
export interface StorageProvider {
  /** Store bytes and return a stable ref to them. */
  put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef>;
  /** Resolve a ref to a URL, or `null` if no asset is stored under it. */
  resolve(ref: AssetRef): Promise<string | null>;
  /** Remove the asset stored under a ref (a no-op if none exists). */
  remove(ref: AssetRef): Promise<void>;
}
