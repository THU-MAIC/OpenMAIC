import { BrowserAssetStore, toAssetId } from '@openmaic/storage';
import type { AssetMeta } from '@openmaic/dsl';
import {
  expectStageRealmPresenceBinding,
  releaseStageRealmPresenceBinding,
} from './stage-realm-presence';
import {
  bindAssetReplacementChannel,
  notifyAssetReplaced,
  observeAssetReplacements,
} from './asset-replacement-events';

const ASSET_POOL_DATABASE_NAME = 'maic-asset-pool';
let pool: BrowserAssetStore | undefined;
let clearing: Promise<void> | undefined;

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

/** Lazy browser-wide asset pool. Construction is forbidden during SSR. */
export function getAssetPool(): BrowserAssetStore {
  if (typeof indexedDB === 'undefined') {
    throw new Error('The browser asset pool requires IndexedDB.');
  }
  if (clearing) throw new Error('The browser asset pool is being cleared.');
  return (pool ??= new BrowserAssetStore({ dbName: ASSET_POOL_DATABASE_NAME }));
}

export function putAsset(blob: Blob, meta: AssetMeta = {}): Promise<string> {
  return getAssetPool().put(blob, meta);
}

export async function replaceAsset(ref: string, blob: Blob, meta: AssetMeta = {}): Promise<void> {
  const current = getAssetPool();
  await current.replace(toAssetId(ref), blob, meta);
  await notifyAssetReplaced(ref, current);
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

/** Close the browser-wide singleton and delete every locally generated asset. */
export function clearAssetPool(): Promise<void> {
  if (clearing) return clearing;
  const current = pool;
  clearing = (async () => {
    try {
      if (current) await current.close();
      await deleteAssetPoolDatabase();
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
