/**
 * The app's document-persistence seam over `@openmaic/storage`'s
 * DocumentStore: AppDocument types, validators, legacy canonicalizers, the
 * lazy client store singleton, locked lazy migration, and the device-scoped
 * current-scene position. Distinct from `lib/document/` (server-side content
 * extraction), which must never enter the client bundle.
 */
export type { AppDocument, AppDocumentOutline, AppStage } from './persistence-types';
export {
  canonicalizeLegacyOutline,
  canonicalizeLegacyScene,
  canonicalizeLegacyStage,
} from './canonicalize';
export { getDocumentStore, type DocumentStoreDeps } from './store';
export {
  accessDocument,
  documentLockName,
  getLegacyDocumentStore,
  mutateDocument,
  withDocumentLock,
  DocumentLockUnavailableError,
  DocumentStorageGenerationChangedError,
  type DocumentAccessResult,
  type DocumentMigrationDeps,
  type LegacyDocumentSnapshot,
  type LegacyDocumentStore,
} from './migration';
export { bumpGeneration, readGeneration } from './storage-generation';
export {
  clearCurrentScene,
  loadCurrentScene,
  saveCurrentScene,
  type CurrentSceneDeps,
  type CurrentSceneValue,
} from './current-scene';
export { validateAppScene, validateAppStage } from './validators';
