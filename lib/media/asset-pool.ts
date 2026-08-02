import { BrowserAssetStore, toAssetId } from '@openmaic/storage';
import type { AssetMeta } from '@openmaic/dsl';
import { notifyAssetReplaced } from './asset-replacement-events';

const ASSET_POOL_DATABASE_NAME = 'maic-asset-pool';
let pool: BrowserAssetStore | undefined;
let clearing: Promise<void> | undefined;

/** Lazy browser-wide asset pool. Construction is forbidden during SSR. */
export function getAssetPool(): BrowserAssetStore {
  if (typeof indexedDB === 'undefined') {
    throw new Error('The browser asset pool requires IndexedDB.');
  }
  if (clearing) throw new Error('The browser asset pool is being cleared.');
  return (pool ??= new BrowserAssetStore({ dbName: ASSET_POOL_DATABASE_NAME }));
}

export function putAsset(blob: Blob, meta: AssetMeta = {}): Promise<string> {
  return getAssetPool().put(blob, meta);
}

export async function replaceAsset(ref: string, blob: Blob, meta: AssetMeta = {}): Promise<void> {
  const current = getAssetPool();
  await current.replace(toAssetId(ref), blob, meta);
  await notifyAssetReplaced(ref, current);
}

export function removeAsset(ref: string): Promise<void> {
  return getAssetPool().remove(toAssetId(ref));
}

function deleteAssetPoolDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(ASSET_POOL_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete the asset pool.'));
    request.onblocked = () => reject(new Error('Asset pool deletion was blocked.'));
  });
}

/** Close the browser-wide singleton and delete every locally generated asset. */
export function clearAssetPool(): Promise<void> {
  if (clearing) return clearing;
  const current = pool;
  clearing = (async () => {
    if (current) await current.close();
    await deleteAssetPoolDatabase();
    if (pool === current) pool = undefined;
  })().finally(() => {
    clearing = undefined;
  });
  return clearing;
}
