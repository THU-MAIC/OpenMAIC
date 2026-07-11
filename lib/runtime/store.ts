/**
 * Lazy app-wide RuntimeStore singleton (#869). One `maic-runtime` IndexedDB
 * per origin, shared by every runtime kind (pbl, chat, quizAttempt, playback)
 * as they migrate onto the runtime layer. Nothing reads or writes it yet
 * except the stage-deletion cascade; Part C2 adds the first real writer.
 *
 * Client-only: the store lazily opens IndexedDB. Server code must not import
 * this module without injecting its own `RuntimeStore`.
 */
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

// BrowserRuntimeStore's default dbName; passed explicitly below so the probe
// in deleteStageRuntimeSafely and the store itself can never drift apart.
const RUNTIME_DB_NAME = 'maic-runtime';

let store: RuntimeStore | undefined;

export function getRuntimeStore(): RuntimeStore {
  return (store ??= new BrowserRuntimeStore({ dbName: RUNTIME_DB_NAME }));
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
 * runtime rows, which are inert today (nothing reads them yet); a startup
 * sweep is deliberately deferred to Part C2, when the store gains real
 * readers.
 */
export async function deleteStageRuntimeSafely(
  stageId: string,
  runtimeStore?: RuntimeStore,
): Promise<void> {
  try {
    // Probe + cascade share the try/catch and the timeout envelope: a hanging
    // `databases()` must not brick deletion any more than a hanging store.
    const work = (async () => {
      if (!(await runtimeDbExists())) return; // nothing to clean
      const cascade = (runtimeStore ?? getRuntimeStore()).deleteStageRuntime(stageId);
      // A rejection landing after the timeout already won the race would have
      // no listener left — swallow that branch so it cannot surface as an
      // unhandled rejection (the await below still reports it if it lands in
      // time).
      cascade.catch(() => {});
      await cascade;
    })();
    await withTimeout(work, STAGE_RUNTIME_DELETE_TIMEOUT_MS);
  } catch (error) {
    console.warn(`Failed to delete runtime data for stage ${stageId}:`, error);
  }
}
