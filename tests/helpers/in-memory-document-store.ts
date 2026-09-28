/**
 * In-memory app stores for tests.
 *
 * The app has no browser-storage backend: in production every document goes
 * through the server-backed store. Tests that need a real, validating store
 * without a server get the package's IndexedDB implementations over an
 * isolated fake-indexeddb factory, which keeps every byte in memory.
 */
import { IDBFactory } from 'fake-indexeddb';
import { BrowserAssetStore, BrowserDocumentStore, type DocumentStore } from '@openmaic/storage';

import type { AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppScene } from '@/lib/types/stage';

export function inMemoryDocumentStore(
  dbName: string,
  indexedDB: IDBFactory = new IDBFactory(),
): DocumentStore<AppScene, AppStage> {
  return new BrowserDocumentStore<AppScene, AppStage>({
    indexedDB,
    dbName,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

/**
 * Configure the app asset pool with an in-memory asset store for one test.
 * Returns the store and a teardown that clears the pool and the seam again.
 */
export async function useInMemoryAssetPool(): Promise<{
  readonly pool: BrowserAssetStore;
  readonly teardown: () => Promise<void>;
}> {
  const { configureAssetPoolStorage, resetAssetPoolStorageForTests } =
    await import('@/lib/media/asset-pool-config');
  const { clearAssetPool } = await import('@/lib/media/asset-pool');
  const pool = new BrowserAssetStore({
    indexedDB: new IDBFactory(),
    dbName: `test-asset-pool-${crypto.randomUUID()}`,
  });
  resetAssetPoolStorageForTests();
  configureAssetPoolStorage({ store: pool });
  return {
    pool,
    teardown: async () => {
      await clearAssetPool();
      resetAssetPoolStorageForTests();
    },
  };
}
