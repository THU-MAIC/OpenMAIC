import { BrowserAssetStore, toAssetId } from '@openmaic/storage';
import type { AssetMeta } from '@openmaic/dsl';

let pool: BrowserAssetStore | undefined;

/** Lazy browser-wide asset pool. Construction is forbidden during SSR. */
export function getAssetPool(): BrowserAssetStore {
  if (typeof indexedDB === 'undefined') {
    throw new Error('The browser asset pool requires IndexedDB.');
  }
  return (pool ??= new BrowserAssetStore({ dbName: 'maic-asset-pool' }));
}

export function putAsset(blob: Blob, meta: AssetMeta = {}): Promise<string> {
  return getAssetPool().put(blob, meta);
}

export function replaceAsset(ref: string, blob: Blob, meta: AssetMeta = {}): Promise<void> {
  return getAssetPool().replace(toAssetId(ref), blob, meta);
}

export function removeAsset(ref: string): Promise<void> {
  return getAssetPool().remove(toAssetId(ref));
}
