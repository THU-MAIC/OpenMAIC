export interface ClearCacheSteps {
  /** Device-local IndexedDB storage and the in-memory asset client. */
  clearLocalCache: () => Promise<void>;
  clearLocalStorage: () => void;
  clearSessionStorage: () => void;
  clearPersistedStores: () => Promise<void>;
}

/**
 * Clear everything this browser keeps for itself. Server data (courses, chat
 * history, learner progress, media) is durable user data and is not part of
 * any step.
 */
export async function runClearCache(steps: ClearCacheSteps): Promise<void> {
  await steps.clearLocalCache();
  steps.clearLocalStorage();
  steps.clearSessionStorage();
  await steps.clearPersistedStores();
}
