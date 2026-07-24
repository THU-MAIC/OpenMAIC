import '@/lib/persistence/bootstrap';

import { BrowserDocumentStore, type DocumentStore } from '@openmaic/storage';

import type { AppScene } from '@/lib/types/stage';

import { registerDocumentStorageResetHook, resolveConfiguredDocumentStore } from './config';
import type { AppStage } from './persistence-types';
import { validateAppScene, validateAppStage } from './validators';

export {
  configureDocumentStorage,
  isDocumentStorageConfigured,
  resetDocumentStorageForTests,
} from './config';
export type {
  DocumentStorageOptions,
  DocumentStorageValidators,
  DocumentStoreFactory,
} from './config';

const DOCUMENT_DB_NAME = 'maic-documents';

export interface DocumentStoreDeps {
  /** A complete store override takes precedence over browser construction. */
  store?: DocumentStore<AppScene, AppStage>;
  /** IndexedDB factory for isolated browser tests. */
  indexedDB?: IDBFactory;
  /** Database name override for isolated browser tests. */
  dbName?: string;
}

let defaultStore: DocumentStore<AppScene, AppStage> | undefined;

registerDocumentStorageResetHook(() => {
  defaultStore = undefined;
});

function createBrowserStore(
  deps: Omit<DocumentStoreDeps, 'store'>,
): DocumentStore<AppScene, AppStage> {
  // Capability probe, not an environment probe: node test runners inject a
  // fake `indexedDB` global; a true server render has neither and must throw.
  if (!deps.indexedDB && typeof indexedDB === 'undefined') {
    throw new Error('Document persistence requires IndexedDB (client-only)');
  }
  return new BrowserDocumentStore<AppScene, AppStage>({
    indexedDB: deps.indexedDB,
    dbName: deps.dbName ?? DOCUMENT_DB_NAME,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

/** Resolve the app document store without opening IndexedDB at module import. */
export function getDocumentStore(deps: DocumentStoreDeps = {}): DocumentStore<AppScene, AppStage> {
  if (deps.store) return deps.store;
  if (deps.indexedDB || deps.dbName) return createBrowserStore(deps);
  // `??=` assigns only after resolution succeeds: if a configured factory
  // throws, the next call retries it rather than caching the failure.
  return (defaultStore ??= resolveConfiguredDocumentStore() ?? createBrowserStore({}));
}
