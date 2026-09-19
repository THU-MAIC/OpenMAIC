import type { DocumentStore, SceneValidator, StageValidator } from '@openmaic/storage';

import type { AppScene } from '@/lib/types/stage';

import type { AppStage } from './persistence-types';
import { validateAppScene, validateAppStage } from './validators';

export interface DocumentStorageValidators {
  validateScene: SceneValidator;
  validateStage: StageValidator;
}

export type DocumentStoreFactory = (
  validators: DocumentStorageValidators,
) => DocumentStore<AppScene, AppStage>;

export interface DocumentStorageOptions {
  /**
   * A DocumentStore instance, or a factory evaluated lazily until it first
   * succeeds. Factories receive the app validators and must inject them into
   * server-backed stores so every backend preserves the app write boundary.
   */
  store?: DocumentStore<AppScene, AppStage> | DocumentStoreFactory;
}

let options: DocumentStorageOptions | undefined;
let resolutionStarted = false;

/**
 * Configure the app-wide document persistence backend.
 *
 * This is a client-bootstrap-only, single-shot API. It is not SSR-safe and is
 * not intended for request-scoped stores. Call it at module-level bootstrap,
 * before rendering any document consumer; a component effect is too late. A
 * second call always throws, even if document storage has not been used yet.
 * Once resolution has started, configuration stays sealed so a live app cannot
 * split documents across backends. Omitting the store retains the browser
 * IndexedDB backend.
 *
 * A store factory is called lazily by `getDocumentStore()` until it first
 * succeeds. It receives `validateAppScene` and `validateAppStage`; inject those
 * validators into a server-backed store (for example, `HttpDocumentStore`) so
 * the app's widened scene union and stage rules remain enforced at the client
 * write boundary.
 *
 * Dev-mode limitation: configuration and consumer caches live in separate
 * modules, so partial HMR replacement can fragment their module-level state.
 * Reload the page after changing bootstrap configuration.
 *
 * @example
 * ```ts
 * configureDocumentStorage({
 *   store: ({ validateScene, validateStage }) =>
 *     new HttpDocumentStore({ baseUrl: '/api', validateScene, validateStage }),
 * });
 * ```
 */
export function configureDocumentStorage(next: DocumentStorageOptions): void {
  assertDocumentStorageConfigurable();
  // Snapshot: a caller mutating its options object after configuring must not
  // be able to swap the backend behind the sealed configuration.
  options = { store: next.store };
}

/**
 * @internal Synchronous bootstrap preflight used to make multi-seam
 * configuration atomic.
 */
export function assertDocumentStorageConfigurable(): void {
  if (resolutionStarted) {
    throw new Error(
      'configureDocumentStorage must be called at module-level bootstrap, before any document consumer runs — a component effect is too late. Document storage resolution has already started; configuration remains sealed even if resolution failed. Retry the document consumer to retry resolution.',
    );
  }
  if (options) {
    throw new Error('Document storage has already been configured');
  }
}

/** Whether client bootstrap has supplied document storage configuration. */
export function isDocumentStorageConfigured(): boolean {
  return options !== undefined;
}

type DocumentStorageResetHook = () => void;
const resetHooks: DocumentStorageResetHook[] = [];

/**
 * @internal Modules that latch singleton caches derived from this
 * configuration register a clearer so the test reset below leaves no stale
 * cache behind.
 */
export function registerDocumentStorageResetHook(hook: DocumentStorageResetHook): void {
  resetHooks.push(hook);
}

/** @internal Test-only reset: clears configuration AND every latched consumer cache. */
export function resetDocumentStorageForTests(): void {
  options = undefined;
  resolutionStarted = false;
  for (const hook of resetHooks) hook();
}

/** @internal Resolve and seal the configured store override, if any. */
export function resolveConfiguredDocumentStore(): DocumentStore<AppScene, AppStage> | undefined {
  resolutionStarted = true;
  const configured = options?.store;
  return typeof configured === 'function'
    ? configured({ validateScene: validateAppScene, validateStage: validateAppStage })
    : configured;
}
