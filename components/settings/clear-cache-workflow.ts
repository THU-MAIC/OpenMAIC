import { AssetPoolDeletionDeferredError } from '@/lib/media/asset-pool';

export interface ClearCacheSteps {
  clearDatabase: () => Promise<void>;
  clearLocalStorage: () => void;
  clearSessionStorage: () => void;
  clearPersistedStores: () => Promise<void>;
}

export type ClearCacheResult =
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
