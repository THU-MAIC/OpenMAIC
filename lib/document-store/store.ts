import '@/lib/persistence/bootstrap';

import type { DocumentStore } from '@openmaic/storage';

import type { AppScene } from '@/lib/types/stage';

import { registerDocumentStorageResetHook, resolveConfiguredDocumentStore } from './config';
import type { AppStage } from './persistence-types';
import {
  resetPlainJsonDocumentWritesForTests,
  withPlainJsonDocumentWrites,
} from './plain-json-store';

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

export interface DocumentStoreDeps {
  /** A complete store override (tests, server-side callers). */
  store?: DocumentStore<AppScene, AppStage>;
}

let defaultStore: DocumentStore<AppScene, AppStage> | undefined;

registerDocumentStorageResetHook(() => {
  defaultStore = undefined;
  resetPlainJsonDocumentWritesForTests();
});

/**
 * Resolve the app document store: the server-backed store the browser
 * persistence bootstrap configures. There is no browser-storage backend; a
 * caller outside the browser (a server render, a test) must inject its own.
 */
export function getDocumentStore(deps: DocumentStoreDeps = {}): DocumentStore<AppScene, AppStage> {
  if (deps.store) return withPlainJsonDocumentWrites(deps.store);
  // `??=` assigns only after resolution succeeds: if a configured factory
  // throws, the next call retries it rather than caching the failure.
  return (defaultStore ??= (() => {
    const configured = resolveConfiguredDocumentStore();
    if (!configured) {
      throw new Error(
        'Document storage is not configured: the browser persistence bootstrap configures it, and code outside the browser must inject a store',
      );
    }
    return withPlainJsonDocumentWrites(configured);
  })());
}
