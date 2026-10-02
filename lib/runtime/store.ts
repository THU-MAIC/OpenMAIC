import '@/lib/persistence/bootstrap';

/**
 * Lazy app-wide RuntimeStore singleton (#869), shared by every runtime kind
 * (pbl, chat, quizAttempt, playback). In the browser it is the server-backed
 * store the persistence bootstrap configures; there is no browser-storage
 * backend. Server code must not import this without injecting its own
 * `RuntimeStore`.
 */
import type { RuntimeStore } from '@openmaic/storage';

import { registerRuntimeStorageResetHook, resolveConfiguredRuntimeStore } from './config';

export {
  configureRuntimeStorage,
  isRuntimeStorageConfigured,
  resetRuntimeStorageForTests,
} from './config';
export type { RuntimeStorageOptions } from './config';

let store: RuntimeStore | undefined;

registerRuntimeStorageResetHook(() => {
  store = undefined;
});

function createRuntimeStore(): RuntimeStore {
  const configured = resolveConfiguredRuntimeStore();
  if (!configured) {
    throw new Error(
      'Runtime storage is not configured: the browser persistence bootstrap configures it, and code outside the browser must inject a store',
    );
  }
  return configured;
}

export function getRuntimeStore(): RuntimeStore {
  // `??=` assigns only after resolution succeeds: if a configured factory
  // throws, the next call retries it rather than caching the failure.
  return (store ??= createRuntimeStore());
}

/** How long the deletion cascade may run before the caller moves on. */
const STAGE_RUNTIME_DELETE_TIMEOUT_MS = 5000;

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
 * hanging. The runtime is a separate store from the document, so a failing or
 * hung runtime request must not brick stage deletion -- the cascade is bounded
 * by a timeout, and any failure warns and moves on. A failed or timed-out
 * cascade leaves orphaned runtime rows; they are not reachable through normal
 * navigation once the stage is gone.
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
  const work = (async () => {
    await (runtimeStore ?? getRuntimeStore()).deleteStageRuntime(stageId);
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
