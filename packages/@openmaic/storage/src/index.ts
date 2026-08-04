/**
 * @openmaic/storage — the MAIC pluggable persistence layer.
 *
 * Dependency arrow (kept acyclic): `@openmaic/storage -> @openmaic/dsl` only.
 * The DSL owns *what* persists (document/runtime shape + validation + migration
 * + the asset `StorageProvider` interface); this package owns *where/how* it
 * persists — the KV / asset primitives and their swappable backends. The
 * pluggable seam is the backend, not the database driver.
 *
 * `KVStore` ships a browser backend and an HTTP backend, proven equivalent by
 * one shared contract suite, with one asymmetry: only its `account` scope has
 * an HTTP backend, because `device` values never leave the device.
 *
 * The asset seam ships `BrowserAssetStore`: a global asset pool, in which an
 * allocated `AssetId` names a registry entry and the registry names
 * content-addressed bytes (#1007). Its byte table is embedded in the registry's
 * IndexedDB database so writes, reference counting, and reclamation share one
 * transaction. A replaceable blob interface belongs to the future asset server
 * backend, where consistency is enforced server-side; no HTTP asset backend is
 * exposed here yet.
 */
export type { DeviceSafeKVStore, KVScope, KVStore, LocalKVStore } from './kv/types.js';
export { assertKVScope, DEFAULT_KV_SCOPE, KVScopeViolationError } from './kv/types.js';
export { BrowserKVStore, type BrowserKVStoreOptions } from './kv/browser.js';
export {
  HttpAccountKV,
  HttpKVStore,
  HttpKVStoreError,
  type AccountScope,
  type HttpAccountKVOptions,
  type HttpKVHeadersContext,
  type HttpKVHeadersHook,
  type HttpKVStoreOptions,
} from './kv/http.js';
export { BrowserAssetStore, type BrowserAssetStoreOptions } from './asset/browser-store.js';
export { newAssetId, toAssetId, type AssetId } from './asset/id.js';

export {
  kvPersistStorage,
  type PersistedValue,
  type PersistStorageLike,
} from './zustand/persist.js';

export type {
  DocumentStore,
  MaicDocument,
  DocumentSummary,
  SceneLike,
  SceneValidator,
  StageValidator,
} from './document/types.js';
export { DocumentNotFoundError, DocumentVersionError } from './document/types.js';
export { BrowserDocumentStore, type BrowserDocumentStoreOptions } from './document/browser.js';
export {
  HttpDocumentStore,
  HttpDocumentStoreError,
  type HttpDocumentHeadersContext,
  type HttpDocumentHeadersHook,
  type HttpDocumentStoreOptions,
} from './document/http.js';
export {
  PgDocumentStore,
  DOCUMENT_PG_SCHEMA,
  ensureDocumentSchema,
  type PgDocumentStoreOptions,
} from './document/pg.js';

export type {
  RuntimeStore,
  RuntimeSessionInit,
  RuntimePayloadValidator,
  RuntimeAppendOptions,
  RuntimeTailOptions,
} from './runtime/types.js';
export { RuntimeAppendConflictError } from './runtime/types.js';
export { BrowserRuntimeStore, type BrowserRuntimeStoreOptions } from './runtime/browser.js';

// Re-export the DSL-owned asset contract for convenience, so consumers can get
// the interface and a backend from one import without reaching into the DSL.
export type { AssetRef, AssetMeta, BinaryBlob, StorageProvider } from '@openmaic/dsl';
