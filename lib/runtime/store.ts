/**
 * Lazy app-wide RuntimeStore singleton (#869). One `maic-runtime` IndexedDB
 * per origin, shared by every runtime kind (pbl, chat, quizAttempt, playback)
 * as they migrate onto the runtime layer. PBL events and chat sessions use it
 * today; the stage-deletion cascade clears every kind together.
 *
 * Client-only: the store lazily opens IndexedDB. Server code must not import
 * this module without injecting its own `RuntimeStore`.
 */
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import { registerRuntimeStorageResetHook, resolveConfiguredRuntimeStore } from './config';

export {
  configureRuntimeStorage,
  isRuntimeStorageConfigured,
  resetRuntimeStorageForTests,
} from './config';
export type { RuntimeStorageOptions } from './config';

// BrowserRuntimeStore's default dbName; passed explicitly below so the probe
// in deleteStageRuntimeSafely and the store itself can never drift apart.
const RUNTIME_DB_NAME = 'maic-runtime';

let store: RuntimeStore | undefined;

registerRuntimeStorageResetHook(() => {
  store = undefined;
});
let usesDefaultBrowserStore = false;

function createRuntimeStore(): RuntimeStore {
  const configured = resolveConfiguredRuntimeStore();
  usesDefaultBrowserStore = configured === undefined;
  return configured ?? new BrowserRuntimeStore({ dbName: RUNTIME_DB_NAME });
}

export function getRuntimeStore(): RuntimeStore {
  // `??=` assigns only after resolution succeeds: if a configured factory
  // throws, the next call retries it rather than caching the failure.
  return (store ??= createRuntimeStore());
}

/** How long the deletion cascade may run before the caller moves on. */
const STAGE_RUNTIME_DELETE_TIMEOUT_MS = 5000;

/**
 * True unless the probe API positively says the runtime DB was never created.
 * Opening the store would CREATE the database, so a deletion on a device that
 * never wrote runtime data must not touch it. Where `indexedDB.databases` is
 * unavailable (older Firefox), assume it exists — the timeout already bounds
 * the degraded case, and skipping would strand real cleanup.
 */
async function runtimeDbExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return true;
  }
  const databases = await indexedDB.databases();
  return databases.some((db) => db.name === RUNTIME_DB_NAME);
}

/** Reject after `ms`, clearing the timer once the raced promise settles. */
async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cascade a stage deletion into the runtime store without ever throwing or
 * hanging. The runtime layer lives in a separate IndexedDB database
 * (`maic-runtime`), so a broken or hung runtime DB must not brick stage
 * deletion in the main app DB — the cascade is bounded by a timeout, and any
 * failure warns and moves on. A failed or timed-out cascade leaves orphaned
 * runtime rows; they are not reachable through normal navigation once the
 * stage is gone, and a future startup sweep can reclaim them.
 */
export async function deleteStageRuntimeSafely(
  stageId: string,
  runtimeStore?: RuntimeStore,
): Promise<void> {
  await beginStageRuntimeDeletionSafely(stageId, runtimeStore).completion;
}

export interface StageRuntimeDeletion {
  /** Bounded, fail-soft caller-visible completion. */
  completion: Promise<void>;
  /** Fail-soft actual settlement, used to retain destructive maintenance locks. */
  settlement: Promise<void>;
}

/** Start one bounded deletion while keeping a handle to its real settlement. */
export function beginStageRuntimeDeletionSafely(
  stageId: string,
  runtimeStore?: RuntimeStore,
): StageRuntimeDeletion {
  // Probe + cascade share the same underlying work: a hanging databases()
  // probe is just as important to retain behind maintenance as a hanging delete.
  const work = (async () => {
    if (runtimeStore) {
      await runtimeStore.deleteStageRuntime(stageId);
      return;
    }

    const resolvedStore = getRuntimeStore();
    if (usesDefaultBrowserStore && !(await runtimeDbExists())) return;
    await resolvedStore.deleteStageRuntime(stageId);
  })();
  let reported = false;
  const report = (error: unknown): void => {
    if (reported) return;
    reported = true;
    console.warn(`Failed to delete runtime data for stage ${stageId}:`, error);
  };
  const settlement = work.catch(report);
  const completion = withTimeout(work, STAGE_RUNTIME_DELETE_TIMEOUT_MS).catch(report);
  return { completion, settlement };
}
