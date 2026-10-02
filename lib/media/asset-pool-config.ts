import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';

/** The browser-facing asset pool surface (implemented by the HTTP asset store). */
export interface AssetPoolStore {
  put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef>;
  resolve(ref: AssetRef): Promise<string | null>;
  invalidate(ref: AssetRef): Promise<void>;
  remove(ref: AssetRef): Promise<void>;
  release(ref: AssetRef): Promise<void>;
  /**
   * Metadata-only existence probe. Optional for test doubles; the production
   * store implements it with a HEAD, so migration-time checks never download
   * bytes.
   */
  exists?(ref: AssetRef): Promise<boolean>;
  close(): Promise<void>;
}

export type AssetPoolStoreFactory = () => AssetPoolStore;

export interface AssetPoolStorageOptions {
  /**
   * An asset pool instance, or a factory evaluated on each resolution.
   *
   * Prefer the factory form: a concrete instance is single-lifecycle.
   * `clearAssetPool()` closes whatever instance the pool held, so a pool
   * configured with an instance cannot reopen — the next resolution refuses
   * loudly instead of reinstalling the closed object — while a factory simply
   * builds a fresh one.
   */
  store?: AssetPoolStore | AssetPoolStoreFactory;
}

let options: AssetPoolStorageOptions | undefined;
let resolutionStarted = false;
let concreteStoreHandedOut = false;

/**
 * Configure the browser-wide asset pool backend.
 *
 * This is a client-bootstrap-only, single-shot API. Call it at module-level
 * bootstrap before any asset consumer runs. A second call always throws, and
 * resolution seals the configuration so one live app cannot split assets
 * across backends. The browser persistence bootstrap
 * (`lib/persistence/bootstrap.ts`) is the production caller; without a
 * configured store, the asset pool does not resolve.
 */
export function configureAssetPoolStorage(next: AssetPoolStorageOptions): void {
  assertAssetPoolStorageConfigurable();
  // Snapshot the options so later caller mutation cannot swap a sealed backend.
  options = { store: next.store };
}

/** @internal Synchronous bootstrap preflight for atomic multi-seam configuration. */
export function assertAssetPoolStorageConfigurable(): void {
  if (resolutionStarted) {
    throw new Error(
      'configureAssetPoolStorage must be called at module-level bootstrap, before any asset consumer runs — a component effect is too late. Asset pool resolution has already started; configuration remains sealed even if resolution failed. Retry the asset consumer to retry resolution.',
    );
  }
  if (options) {
    throw new Error('Asset pool storage has already been configured');
  }
}

/** Whether client bootstrap has supplied asset-pool configuration. */
export function isAssetPoolStorageConfigured(): boolean {
  return options !== undefined;
}

type AssetPoolStorageResetHook = () => void;
const resetHooks: AssetPoolStorageResetHook[] = [];

/** @internal Register a clearer for singleton state derived from this seam. */
export function registerAssetPoolStorageResetHook(hook: AssetPoolStorageResetHook): void {
  resetHooks.push(hook);
}

/** @internal Test-only reset for configuration and latched consumers. */
export function resetAssetPoolStorageForTests(): void {
  options = undefined;
  resolutionStarted = false;
  concreteStoreHandedOut = false;
  for (const hook of resetHooks) hook();
}

/** @internal Resolve and seal the configured pool override, if any. */
export function resolveConfiguredAssetPoolStore(): AssetPoolStore | undefined {
  resolutionStarted = true;
  const configured = options?.store;
  if (typeof configured === 'function') return configured();
  if (!configured) return undefined;
  // A concrete instance gets one lifetime. The first resolution installs it as
  // the pool; clearAssetPool() then closes it. Resolving the same object again
  // would reinstall a closed store as the live pool, so the second handout
  // refuses and names the fix. A factory has no such state and is called
  // afresh on every resolution.
  if (concreteStoreHandedOut) {
    throw new Error(
      'The configured asset pool store instance was closed by clearAssetPool() and cannot be reopened. Configure the pool with a factory -- store: () => new ... -- so a cleared pool resolves to a fresh store.',
    );
  }
  concreteStoreHandedOut = true;
  return configured;
}
