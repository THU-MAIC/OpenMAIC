import type { BrowserAssetStore } from '@openmaic/storage';

export type AssetReplacementPool = Pick<BrowserAssetStore, 'resolve' | 'release'>;

type AssetReplacementObserver = (ref: string, pool: AssetReplacementPool) => Promise<void> | void;

const observers = new Set<AssetReplacementObserver>();

export function observeAssetReplacements(observer: AssetReplacementObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export async function notifyAssetReplaced(ref: string, pool: AssetReplacementPool): Promise<void> {
  await Promise.all([...observers].map((observer) => observer(ref, pool)));
}
