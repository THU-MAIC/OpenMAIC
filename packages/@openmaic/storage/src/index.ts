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
 * transaction, and its inline reclamation is what keeps them there. A server
 * backend collects bytes offline instead, which lets its byte layer be
 * pluggable — a column of the transactional store, or an object store keyed by
 * content hash. The HTTP backend downloads bytes through authenticated fetches
 * and mints object URLs locally.
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
export {
  HttpAssetStore,
  HttpAssetStoreError,
  type HttpAssetHeadersContext,
  type HttpAssetHeadersHook,
  type HttpAssetStoreOptions,
} from './asset/http.js';
export { newAssetId, toAssetId, type AssetId } from './asset/id.js';
export {
  ASSET_DESCRIPTOR_MEDIA_TYPE,
  AssetNotFoundError,
  AssetQuotaExceededError,
  DEFAULT_RENDERABLE_TYPES,
  EXCLUDED_RENDERABLE_TYPES,
  type AssetBytes,
  type AssetIdentity,
  type AssetIndirectRead,
  type AssetIndirectReadRequest,
  type AssetPrincipal,
  type AssetStore,
} from './asset/types.js';
export type { AssetByteStore, AssetSignedReadHeaders } from './asset/byte-store.js';
export {
  ASSET_PG_SCHEMA,
  PgAssetStore,
  ensureAssetSchema,
  type PgAssetStoreOptions,
} from './asset/pg.js';
export { PgAssetByteStore } from './asset/pg-bytes.js';
export {
  AssetCollector,
  assertSignedUrlTtlWithinGrace,
  DEFAULT_ASSET_COLLECTION_BATCH_SIZE,
  DEFAULT_ASSET_COLLECTION_GRACE_MS,
  type AssetCollectionPass,
  type AssetCollectorOptions,
} from './asset/collector.js';

export {
  kvPersistStorage,
  type PersistedValue,
  type PersistStorageLike,
} from './zustand/persist.js';

export type {
  DocumentStore,
  MaicDocument,
  DocumentSummary,
  DocumentFolder,
  DocumentFolderStore,
  SceneLike,
  SceneValidator,
  StageValidator,
  StageSceneManifest,
  StageFreshnessManifest,
  StageFreshnessManifestStore,
} from './document/types.js';
export {
  DocumentFolderLimitError,
  DocumentNotFoundError,
  DocumentVersionError,
} from './document/types.js';
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
  readStageFreshnessManifest,
  splitSqlStatements,
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

export {
  AGENT_SESSION_LIFECYCLE,
  AGENT_SESSION_STATUSES,
  AGENT_SESSION_URL_SOURCES,
  OWNER_SESSION_EVENT_TYPES,
  AgentSessionAccessError,
  AgentSessionEntryTreeError,
  AgentSessionLeaseLostError,
  extractObservedUrls,
  normalizeObservedUrl,
  type AgentSessionClaimReason,
  type AgentSessionCompactionEntry,
  type AgentSessionCustomMessageEntry,
  type AgentSessionEntry,
  type AgentSessionEntryBase,
  type AgentSessionEntryTree,
  type AgentSessionEntryTreeHandle,
  type AgentSessionEventLog,
  type AgentSessionHooks,
  type AgentSessionLabelEntry,
  type AgentSessionLeafEntry,
  type AgentSessionLease,
  type AgentSessionLifecycleEventType,
  type AgentSessionMessageEntry,
  type AgentSessionMeta,
  type AgentSessionStatus,
  type AgentSessionStore,
  type AgentSessionTitleStore,
  type AgentSessionTransaction,
  type AgentSessionUrlSource,
  type AgentSessionUrlStore,
  type AgentSessionUserMessage,
  type ClaimedAgentSession,
  type ClaimAgentSessionOptions,
  type CreateAgentSessionInput,
  type FinishAgentSessionPatch,
  type NewAgentSessionEvent,
  type NewOwnerSessionEvent,
  type OwnerSessionEventProjection,
  type OwnerSessionEventType,
  type PersistedAgentSessionEvent,
  type PersistedOwnerSessionEvent,
  type PostAgentUserMessageOptions,
  type PostAgentUserMessageResult,
} from './agent-session/types.js';

// Re-export the DSL-owned asset contract for convenience, so consumers can get
// the interface and a backend from one import without reaching into the DSL.
export type { AssetRef, AssetMeta, BinaryBlob, StorageProvider } from '@openmaic/dsl';

export {
  USER_SKILL_EDITABLE_PATHS,
  USER_SKILL_LIMIT,
  USER_SKILL_CONTENT_MAX_BYTES,
  USER_SKILL_NAME_PATTERN,
  UserSkillError,
  applyOpsOnce,
  applyUserSkillPatchOps,
  hasUnpairedSurrogate,
  normalizeUserSkillFields,
  validateUserSkillFields,
  validateUserSkillInput,
  type AppliedUserSkillOp,
  type UserSkillEditablePath,
  type UserSkillErrorCode,
  type UserSkillFields,
  type UserSkillPatchOpInput,
  type UserSkillPatchOutcome,
  type UserSkillRecord,
  type UserSkillStore,
} from './skill/types.js';
export {
  DEFAULT_USER_SKILL_TABLE_NAMES,
  PgUserSkillStore,
  USER_SKILL_PG_SCHEMA,
  ensureUserSkillSchema,
  type PgUserSkillStoreOptions,
  type UserSkillTableNames,
} from './skill/pg.js';

export {
  AGENT_SESSION_MATERIAL_KINDS,
  AgentSessionMaterialError,
  createMaterialId,
  isAgentSessionMaterialKind,
  MATERIAL_EXTRACTION_STATUSES,
  MAX_MATERIAL_EXTRACTION_RETRIES,
  type AgentSessionMaterial,
  type AgentSessionMaterialKind,
  type AgentSessionMaterialStore,
  type CreateAgentSessionMaterialInput,
  type ListAgentSessionMaterialsOptions,
  type MaterialExtractionStatus,
  type MaterialExtractionState,
  type MaterialExtractionStats,
  type ClaimedMaterialExtraction,
  type ClaimMaterialExtractionOptions,
  type CompleteMaterialExtractionInput,
  type MaterialExtractionFailureSettlement,
} from './material/types.js';
export {
  AGENT_SESSION_MATERIAL_PG_SCHEMA,
  DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES,
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
  type AgentSessionMaterialTableNames,
  type PgAgentSessionMaterialStoreOptions,
} from './material/pg.js';
