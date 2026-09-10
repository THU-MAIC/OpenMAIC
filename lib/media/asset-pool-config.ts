import type { AssetId } from '@openmaic/storage';
import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';

/** Common browser-facing surface implemented by local and HTTP asset stores. */
export interface AssetPoolStore {
  put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef>;
  resolve(ref: AssetRef): Promise<string | null>;
  invalidate(ref: AssetRef): Promise<void>;
  remove(ref: AssetRef): Promise<void>;
  replace(ref: AssetId, data: BinaryBlob, meta?: AssetMeta): Promise<void>;
  release(ref: AssetRef): Promise<void>;
  /**
   * Metadata-only existence probe. Optional for test doubles; production
   * stores implement it with a HEAD (HTTP) or an entry lookup (browser), so
   * migration-time checks never download bytes.
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
  /**
   * Whether references can be held outside this browser. Remote stores must
   * fail closed for ownership proofs and must never be deleted by local-cache
   * cleanup.
   */
  serverBacked?: boolean;
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
 * across backends. Omitting the store retains the existing IndexedDB pool.
 */
export function configureAssetPoolStorage(next: AssetPoolStorageOptions): void {
  assertAssetPoolStorageConfigurable();
  // Snapshot the options so later caller mutation cannot swap a sealed backend
  // or weaken its ownership scope.
  options = { store: next.store, serverBacked: next.serverBacked };
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

/**
 * Whether asset references may be held outside this browser.
 *
 * Reading the mode seals configuration just like resolving the store: an
 * ownership decision must not race a later backend change.
 */
export function isAssetPoolServerBacked(): boolean {
  resolutionStarted = true;
  return options?.serverBacked === true;
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
