import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { BrowserAssetProvider } from '../src/index.js';
import { blobForObjectUrl } from './setup.js';
import { runStorageProviderContract } from './asset-contract.js';

runStorageProviderContract(
  'BrowserAssetProvider',
  () => new BrowserAssetProvider({ indexedDB: new IDBFactory(), dbName: 'test-assets' }),
  async (url) => {
    const b = blobForObjectUrl(url);
    if (!b) throw new Error(`no blob registered for object URL ${url}`);
    return new Uint8Array(await b.arrayBuffer());
  },
);

// Re-putting the same bytes with a corrected contentType must not leave a
// stale cached object URL: resolve() has to reflect the latest write, not
// whatever was cached first (otherwise MIME depends on cache warmth).
test('BrowserAssetProvider re-put updates the resolved contentType', async () => {
  const provider = new BrowserAssetProvider({ indexedDB: new IDBFactory(), dbName: 'mime-db' });
  const ref = await provider.put(new Blob(['pixels'], { type: '' }));
  const first = await provider.resolve(ref);
  expect(blobForObjectUrl(first!)?.type).toBe('');

  await provider.put(new Blob(['pixels'], { type: 'image/png' }));
  const second = await provider.resolve(ref);
  expect(blobForObjectUrl(second!)?.type).toBe('image/png');
});

// A transient failure in resolve() must not be cached: the next resolve(ref)
// has to retry, not replay the rejection.
test('BrowserAssetProvider recovers after a transient resolve failure', async () => {
  const real = new IDBFactory();
  const ref = await new BrowserAssetProvider({ indexedDB: real, dbName: 'flaky-db' }).put(
    new Blob(['seed'], { type: 'text/plain' }),
  );

  let failNextOpen = true;
  const flaky = {
    open: (name: string, version?: number) => {
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('transient open failure');
      }
      return real.open(name, version);
    },
    deleteDatabase: real.deleteDatabase.bind(real),
    cmp: real.cmp.bind(real),
    databases: real.databases?.bind(real),
  } as unknown as IDBFactory;

  const provider = new BrowserAssetProvider({ indexedDB: flaky, dbName: 'flaky-db' });
  await expect(provider.resolve(ref)).rejects.toThrow(); // first open throws
  const url = await provider.resolve(ref); // retry must succeed, not replay the rejection
  expect(url).not.toBeNull();
});

// Backend-specific: the content-addressing contract asserts identical bytes
// yield the same ref; this asserts they actually collapse to ONE stored row,
// so a backend that appended duplicates couldn't pass silently.
test('BrowserAssetProvider stores identical bytes exactly once', async () => {
  const idb = new IDBFactory();
  const provider = new BrowserAssetProvider({ indexedDB: idb, dbName: 'dedup-db' });
  await provider.put(new Blob(['dup me'], { type: 'text/plain' }));
  await provider.put(new Blob(['dup me'], { type: 'text/plain' }));

  const count = await new Promise<number>((resolve, reject) => {
    const open = idb.open('dedup-db', 1);
    open.onsuccess = () => {
      const req = open.result.transaction('assets', 'readonly').objectStore('assets').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
  expect(count).toBe(1);
});
