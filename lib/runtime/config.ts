import type { RuntimeStore } from '@openmaic/storage';

export interface RuntimeStorageOptions {
  /** A RuntimeStore instance, or a factory evaluated lazily until it first succeeds. */
  store?: RuntimeStore | (() => RuntimeStore);
  /** Resolves the client session's learner partition key on first resolution. */
  learnerKey?: () => string | Promise<string>;
}

let options: RuntimeStorageOptions | undefined;
let resolutionStarted = false;

/**
 * Configure the app-wide runtime persistence backend and learner identity.
 *
 * This is a client-bootstrap-only, single-shot API. It is not SSR-safe and is
 * not intended for request-scoped stores or identity. Call it at module-level
 * bootstrap, before rendering any runtime consumer; a component effect is too
 * late. A second call always throws, even if runtime storage has not been used
 * yet. Once resolution has started, configuration stays sealed so a live app
 * cannot split data across backends or learner partitions. Omitted fields
 * retain the browser IndexedDB backend and anonymous device-key behavior.
 *
 * A store factory is called lazily by `getRuntimeStore()` until it first
 * succeeds. The configured learner-key provider is invoked only on first
 * resolution; concurrent callers share that resolution and its first resolved
 * value is retained for the client session. Identity changes mid-session are
 * the application layer's responsibility (reload or a `mergeLearner` flow).
 *
 * Dev-mode limitation: configuration and consumer caches live in separate
 * modules, so partial HMR replacement can fragment their module-level state.
 * Reload the page after changing bootstrap configuration.
 *
 * @example
 * ```ts
 * configureRuntimeStorage({
 *   store: new HttpRuntimeStore({ baseUrl: '/api' }),
 *   learnerKey: () => clientSessionStore.getState().userId,
 * });
 * ```
 */
export function configureRuntimeStorage(next: RuntimeStorageOptions): void {
  if (resolutionStarted) {
    throw new Error(
      'configureRuntimeStorage must be called at module-level bootstrap, before any runtime consumer runs — a component effect is too late. Runtime storage resolution has already started; configuration remains sealed even if resolution failed. Retry the runtime consumer to retry resolution.',
    );
  }
  if (options) {
    throw new Error('Runtime storage has already been configured');
  }
  // Snapshot: a caller mutating its options object after configuring must not
  // be able to swap the backend or identity behind the sealed configuration.
  options = { store: next.store, learnerKey: next.learnerKey };
}

/** Whether client bootstrap has supplied runtime storage configuration. */
export function isRuntimeStorageConfigured(): boolean {
  return options !== undefined;
}

type RuntimeStorageResetHook = () => void;
const resetHooks: RuntimeStorageResetHook[] = [];

/**
 * @internal Modules that latch singleton caches derived from this
 * configuration (the store singleton, the learner-key in-flight promise)
 * register a clearer so the test reset below leaves no stale cache behind.
 */
export function registerRuntimeStorageResetHook(hook: RuntimeStorageResetHook): void {
  resetHooks.push(hook);
}

/** @internal Test-only reset: clears configuration AND every latched consumer cache. */
export function resetRuntimeStorageForTests(): void {
  options = undefined;
  resolutionStarted = false;
  for (const hook of resetHooks) hook();
}

/** @internal Resolve and seal the configured store override, if any. */
export function resolveConfiguredRuntimeStore(): RuntimeStore | undefined {
  resolutionStarted = true;
  const configured = options?.store;
  return typeof configured === 'function' ? configured() : configured;
}

/** @internal Resolve and seal the configured learner-key override, if any. */
export function resolveConfiguredLearnerKey(): Promise<string> | undefined {
  resolutionStarted = true;
  const provider = options?.learnerKey;
  return provider ? Promise.resolve().then(provider) : undefined;
}
