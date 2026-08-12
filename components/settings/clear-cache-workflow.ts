import { AssetPoolDeletionDeferredError } from '@/lib/media/asset-pool';

export interface ClearCacheSteps {
  clearDatabase: () => Promise<void>;
  clearLocalStorage: () => void;
  clearSessionStorage: () => void;
  clearPersistedStores: () => Promise<void>;
}

export type ClearCacheResult =
  // "cleared" describes local cache state. In server-backed asset mode the
  // pool closes and revokes local object URLs, but durable remote assets remain
  // untouched and this result deliberately makes no claim that they were deleted.
  | { readonly status: 'cleared' }
  | { readonly status: 'asset-pool-deferred'; readonly error: AssetPoolDeletionDeferredError };

/** Complete all independent cleanup after an asset-pool delete is blocked by another tab. */
export async function runClearCache(steps: ClearCacheSteps): Promise<ClearCacheResult> {
  let deferredError: AssetPoolDeletionDeferredError | undefined;
  try {
    await steps.clearDatabase();
  } catch (error) {
    if (!(error instanceof AssetPoolDeletionDeferredError)) throw error;
    deferredError = error;
  }

  steps.clearLocalStorage();
  steps.clearSessionStorage();
  await steps.clearPersistedStores();

  return deferredError
    ? { status: 'asset-pool-deferred', error: deferredError }
    : { status: 'cleared' };
}

/**
 * Whether the page should reload after a clear.
 *
 * A deferred deletion leaves the asset-pool database on disk while the guidance
 * asks the user to close the other tab and retry; reloading would discard that
 * state and drop them back into settings with the cache still present. Only a
 * completed clear reloads, which also keeps short the window in which live
 * stores could persist themselves again from memory.
 */
export function shouldReloadAfterClear(result: ClearCacheResult): boolean {
  return result.status === 'cleared';
}
