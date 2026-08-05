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
let channelPool: AssetReplacementPool | undefined;

function ensureChannel(pool: AssetReplacementPool): void {
  channelPool = pool;
  if (channel || typeof BroadcastChannel !== 'function') return;
  try {
    channel = new BroadcastChannel(REPLACEMENT_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const ref = typeof event.data === 'string' ? event.data : undefined;
      // A peer only tells us which ref changed; the bytes are read from this
      // realm's own pool, so a spoofed message can at worst force a re-resolve.
      if (!ref || !channelPool) return;
      void notifyLocalObservers(ref, channelPool);
    };
  } catch {
    // Cross-tab invalidation is an enhancement; a realm without a usable channel
    // still refreshes on its next resolve.
    channel = undefined;
  }
}

async function notifyLocalObservers(ref: string, pool: AssetReplacementPool): Promise<void> {
  await Promise.all([...observers].map((observer) => observer(ref, pool)));
}

export function observeAssetReplacements(observer: AssetReplacementObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export async function notifyAssetReplaced(ref: string, pool: AssetReplacementPool): Promise<void> {
  ensureChannel(pool);
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
  channelPool = undefined;
}
