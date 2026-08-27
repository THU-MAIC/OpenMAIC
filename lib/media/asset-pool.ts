import '@/lib/persistence/bootstrap';

import { BrowserAssetStore, toAssetId } from '@openmaic/storage';
import {
  isAssetPoolServerBacked,
  registerAssetPoolStorageResetHook,
  resolveConfiguredAssetPoolStore,
  type AssetPoolStore,
} from './asset-pool-config';
import {
  expectStageRealmPresenceBinding,
  releaseStageRealmPresenceBinding,
} from './stage-realm-presence';
import { bindAssetReplacementChannel, observeAssetReplacements } from './asset-replacement-events';

const ASSET_POOL_DATABASE_NAME = 'maic-asset-pool';
let pool: AssetPoolStore | undefined;
let clearing: Promise<void> | undefined;

registerAssetPoolStorageResetHook(() => {
  pool = undefined;
  clearing = undefined;
});

export {
  configureAssetPoolStorage,
  isAssetPoolStorageConfigured,
  resetAssetPoolStorageForTests,
} from './asset-pool-config';
export type { AssetPoolStorageOptions, AssetPoolStore } from './asset-pool-config';

export class AssetPoolDeletionDeferredError extends Error {
  override readonly name = 'AssetPoolDeletionDeferredError';

  constructor() {
    super('Asset pool deletion is deferred until other database connections close.');
  }
}

// Replacement notifications originate here, so registration must not depend
// on a renderer importing the React lease module first.
observeAssetReplacements(async (ref, current) => {
  const { invalidateAssetUrlLeaseCache } = await import('./use-asset-url');
  await invalidateAssetUrlLeaseCache(ref, current);
});

// A realm that only renders a classroom never sends a replacement, so binding
// the channel here — at module load, alongside the observer — is what makes a
// passive tab receive peers' invalidations. The pool is resolved lazily so this
// stays SSR-safe.
if (typeof window !== 'undefined') {
  bindAssetReplacementChannel(() => getAssetPool());
  // Answering presence probes is what lets a peer decide it cannot replace an
  // asset in place, so every realm that touches the pool must respond. The
  // binding is asynchronous, so the intent is declared synchronously first —
  // a probe issued in that window then waits for it instead of concluding that
  // presence is unavailable.
  expectStageRealmPresenceBinding();
  void import('./stage-realm-presence')
    .then(({ bindStageRealmPresence }) =>
      import('@/lib/store/stage').then(({ useStageStore }) =>
        bindStageRealmPresence(() => useStageStore.getState().stage?.id),
      ),
    )
    .catch(() => {
      // Releasing the gate keeps probes from waiting forever; they report
      // `unknown`, which callers already treat as "cannot replace in place".
      releaseStageRealmPresenceBinding();
    });
}

/** Lazy browser-wide asset pool. Default construction is forbidden during SSR. */
export function getAssetPool(): AssetPoolStore {
  if (clearing) throw new Error('The browser asset pool is being cleared.');
  return (pool ??= (() => {
    const configured = resolveConfiguredAssetPoolStore();
    if (configured) return configured;
    if (typeof indexedDB === 'undefined') {
      throw new Error('The browser asset pool requires IndexedDB.');
    }
    return new BrowserAssetStore({ dbName: ASSET_POOL_DATABASE_NAME });
  })());
}

export function removeAsset(ref: string): Promise<void> {
  return getAssetPool().remove(toAssetId(ref));
}

function deleteAssetPoolDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(ASSET_POOL_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete the asset pool.'));
    request.onblocked = () => reject(new AssetPoolDeletionDeferredError());
  });
}

/**
 * Clear local asset storage without ever treating server assets as cache.
 *
 * A server-backed pool only closes its client, which revokes every locally
 * minted object URL. Calling `remove` here would destroy durable user data in
 * response to a local-cache action, so no remote deletion is attempted.
 */
export function clearAssetPool(): Promise<void> {
  if (clearing) return clearing;
  const current = pool;
  const serverBacked = isAssetPoolServerBacked();
  clearing = (async () => {
    try {
      if (current) await current.close();
      if (!serverBacked) await deleteAssetPoolDatabase();
    } catch (error) {
      // A blocked delete stays pending until every other connection closes.
      // Keep the closed singleton installed so writes fail loudly instead of
      // opening a connection that queues indefinitely behind that delete.
      if (!(error instanceof AssetPoolDeletionDeferredError) && pool === current) {
        pool = undefined;
      }
      throw error;
    }
    if (pool === current) {
      pool = undefined;
    }
  })().finally(() => {
    clearing = undefined;
  });
  return clearing;
}
