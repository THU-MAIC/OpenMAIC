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
 * The DSL owns only the minimal `put` / `resolve` / `remove` interface.
 * Concrete backends — IndexedDB + object URLs in the browser, object storage /
 * CDN on a server — live in `@openmaic/storage`, keeping this package
 * dependency- and DOM-free. Implementations may offer richer registry
 * operations (for example an atomic byte replacement behind a stable ref)
 * without the DSL contract growing them.
 */

/**
 * A stable, backend-agnostic handle to a stored asset: an identifier the
 * provider **allocated** at `put` time, opaque to everyone else. A plain string
 * so it embeds cleanly in DSL documents (e.g. `PPTImageElement.src`,
 * `PPTVideoElement.mediaRef`).
 *
 * Allocated, not derived: a ref says nothing about the bytes behind it. That is
 * what lets a richer implementation regenerate or replace those bytes without
 * invalidating a single document pointing at the ref, and lets one set of
 * bytes carry several refs with different metadata. A provider may still store
 * identical bytes once internally, but that is a property of its storage
 * layer, not of the ref.
 *
 * The ref domain is unconstrained: any string may be handed to `resolve` or
 * `remove`, and a ref the provider never issued is simply one that resolves to
 * nothing.
 */
export type AssetRef = string;

/**
 * Optional metadata recorded alongside an asset.
 *
 * Every value must be structured-cloneable so browser backends can persist the
 * object in IndexedDB.
 */
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
 * The blob-resolution contract: store bytes, get back an allocated ref, and
 * resolve a ref to a URL usable as an `<img>` / `<audio>` / `<video>` `src`.
 *
 * `put` allocates. Every successful call returns a *new* ref, and every value
 * returned and branch taken on that success path is independent of whether
 * those bytes were already stored. This is a contract requirement rather than
 * an implementation preference: a provider that handed back an existing ref
 * for repeated bytes would let any caller test whether arbitrary bytes are
 * already present, which is an existence oracle over data the caller never
 * stored.
 *
 * Resource-accounting channels remain outside this guarantee: quota errors,
 * storage estimates, and server-side billing or metering may disclose
 * existence. A server deployment must budget those channels per principal.
 */
export interface StorageProvider {
  /** Store bytes and return a newly allocated ref to them. */
  put: (data: BinaryBlob, meta?: AssetMeta) => Promise<AssetRef>;
  /** Resolve a ref to a URL, or `null` if no asset is stored under it. */
  resolve: (ref: AssetRef) => Promise<string | null>;
  /** Remove the asset stored under a ref (a no-op if none exists). */
  remove: (ref: AssetRef) => Promise<void>;
}
