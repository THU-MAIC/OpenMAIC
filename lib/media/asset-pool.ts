import '@/lib/persistence/bootstrap';

import type { AssetMeta, BinaryBlob } from '@openmaic/dsl';
import {
  registerAssetPoolStorageResetHook,
  resolveConfiguredAssetPoolStore,
  type AssetPoolStore,
} from './asset-pool-config';
import {
  expectStageRealmPresenceBinding,
  releaseStageRealmPresenceBinding,
} from './stage-realm-presence';
import { bindAssetReplacementChannel, observeAssetReplacements } from './asset-replacement-events';
import { clearAssetStorageFull } from './asset-storage-full';

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

/**
 * Lazy browser-wide asset pool: the server-backed store the persistence
 * bootstrap configures. There is no browser-storage backend.
 */
export function getAssetPool(): AssetPoolStore {
  if (clearing) throw new Error('The browser asset pool is being cleared.');
  return (pool ??= (() => {
    const configured = resolveConfiguredAssetPoolStore();
    if (!configured) {
      throw new Error(
        'The asset pool is not configured: the browser persistence bootstrap configures it',
      );
    }
    return configured;
  })());
}

export interface PutAssetOptions {
  /**
   * The course these bytes belong to.
   *
   * Supplied so a write that goes through can retire that course's "the store
   * had no room" note. Optional because a caller outside a course has nothing
   * to retire, not because it is discretionary.
   */
  readonly stageId?: string;
}

/**
 * Store bytes and get back the reference a document may hold.
 *
 * Callers go through this rather than through the pool object so URL leasing
 * and release stay owned by `use-asset-url`, which is the only module allowed
 * to hold a resolved URL's lifetime.
 *
 * A write that the store accepted is also the one thing that disproves "the
 * store is full", and that is stated here rather than at each caller. It used
 * to be enforced at three separate sites under slightly different conditions,
 * which made it a convention: the next path that writes to the pool and forgets
 * would leave every course standing down its generation while the store had
 * room. There is one place a successful write can happen, so there is one place
 * the note is retired.
 */
export async function putAsset(
  data: BinaryBlob,
  meta?: AssetMeta,
  options?: PutAssetOptions,
): Promise<string> {
  const ref = await getAssetPool().put(data, meta);
  // Best-effort device metadata, and never allowed to turn a stored asset into
  // a failed one: the bytes are in the pool either way.
  if (options?.stageId) await clearAssetStorageFull(options.stageId);
  return ref;
}

/**
 * Close the local asset client without ever treating server assets as cache.
 *
 * Closing revokes every locally minted object URL. The assets themselves are
 * durable user data on the server: calling `remove` here would destroy them in
 * response to a local-cache action, so no remote deletion is attempted.
 */
export function clearAssetPool(): Promise<void> {
  if (clearing) return clearing;
  const current = pool;
  clearing = (async () => {
    try {
      if (current) await current.close();
    } finally {
      if (pool === current) pool = undefined;
    }
  })().finally(() => {
    clearing = undefined;
  });
  return clearing;
}
