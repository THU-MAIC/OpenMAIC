/**
 * @openmaic/storage — the MAIC pluggable persistence layer.
 *
 * Dependency arrow (kept acyclic): `@openmaic/storage -> @openmaic/dsl` only.
 * The DSL owns *what* persists (document/runtime shape + validation + migration
 * + the asset `StorageProvider` interface); this package owns *where/how* it
 * persists — the KV / asset primitives and their swappable backends. The
 * pluggable seam is the backend, not the database driver.
 *
 * Part 1 ships the browser backends (zero server) and the primitive contracts;
 * the HTTP backend + reference server and the DocumentStore / RuntimeStore
 * follow in later parts (see the tracking issue).
 */
export type { KVScope, KVStore } from './kv/types.js';
export { DEFAULT_KV_SCOPE } from './kv/types.js';
export { BrowserKVStore, type BrowserKVStoreOptions } from './kv/browser.js';
export { BrowserAssetProvider, type BrowserAssetProviderOptions } from './asset/browser.js';

export {
  kvPersistStorage,
  type PersistedValue,
  type PersistStorageLike,
} from './zustand/persist.js';

// Re-export the DSL-owned asset contract for convenience, so consumers can get
// the interface and a backend from one import without reaching into the DSL.
export type { AssetRef, AssetMeta, BinaryBlob, StorageProvider } from '@openmaic/dsl';
