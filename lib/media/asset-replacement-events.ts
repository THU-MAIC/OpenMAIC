import type { BrowserAssetStore } from '@openmaic/storage';

export type AssetReplacementPool = Pick<BrowserAssetStore, 'resolve' | 'release'>;

type AssetReplacementObserver = (ref: string, pool: AssetReplacementPool) => Promise<void> | void;

const observers = new Set<AssetReplacementObserver>();

/**
 * Same-id replacement changes bytes without changing the reference, so a mounted
 * consumer has nothing to re-resolve on its own. Observers live per realm, so a
 * second tab showing the same classroom would keep its lease pinned to the old
 * immutable blob URL. The channel carries the ref across realms; each receiving
 * tab then runs its local observers, which invalidate and re-resolve their leases.
 */
const REPLACEMENT_CHANNEL = 'maic-asset-replacements';

let channel: BroadcastChannel | undefined;
let receivingPool: (() => AssetReplacementPool) | undefined;

/**
 * Binds the realm to the channel. A passive tab never sends anything, so this
 * must run when it starts observing or opens its pool — binding only from the
 * sender path would leave read-only realms deaf to peers.
 */
export function bindAssetReplacementChannel(pool: () => AssetReplacementPool): void {
  receivingPool = pool;
  if (channel || typeof BroadcastChannel !== 'function') return;
  try {
    channel = new BroadcastChannel(REPLACEMENT_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const ref = typeof event.data === 'string' ? event.data : undefined;
      // A peer only tells us which ref changed; the bytes are read from this
      // realm's own pool, so a spoofed message can at worst force a re-resolve.
      if (!ref || !receivingPool) return;
      let pool: AssetReplacementPool;
      try {
        pool = receivingPool();
      } catch {
        // The pool may be unavailable (clearing, or no IndexedDB); the next
        // resolve in this realm picks up the new bytes anyway.
        return;
      }
      void notifyLocalObservers(ref, pool);
    };
  } catch {
    // Cross-tab invalidation is an enhancement; a realm without a usable channel
    // still refreshes on its next resolve.
    channel = undefined;
  }
}

/**
 * Notifications run after the durable write has committed, so an observer
 * failure must never turn a successful replacement into a reported failure.
 */
async function notifyLocalObservers(ref: string, pool: AssetReplacementPool): Promise<void> {
  // An observer may throw synchronously, which would escape Promise.allSettled
  // before it ever sees the array, so each call is wrapped at the call itself.
  const results = await Promise.allSettled(
    [...observers].map(async (observer) => observer(ref, pool)),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[asset-replacement] observer failed for', ref, result.reason);
    }
  }
}

export function observeAssetReplacements(observer: AssetReplacementObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export async function notifyAssetReplaced(ref: string, pool: AssetReplacementPool): Promise<void> {
  try {
    channel?.postMessage(ref);
  } catch {
    // A closed or failing channel must never fail the replacement itself.
  }
  await notifyLocalObservers(ref, pool);
}

/** Test seam: drops the channel so a suite can model separate realms. */
export function __resetAssetReplacementChannelForTesting(): void {
  channel?.close();
  channel = undefined;
  receivingPool = undefined;
}
