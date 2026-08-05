import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('getAssetPool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('binds the replacement channel on load so a passive realm receives peers', async () => {
    // Pins the production wiring: a tab that only renders never calls
    // notifyAssetReplaced, so loading this module must be what starts listening.
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('window', globalThis as unknown as Window);
    vi.resetModules();
    await import('@/lib/media/asset-pool');
    const { observeAssetReplacements, __resetAssetReplacementChannelForTesting } =
      await import('@/lib/media/asset-replacement-events');

    const received: string[] = [];
    const stop = observeAssetReplacements((ref) => {
      received.push(ref);
    });
    const peer = new BroadcastChannel('maic-asset-replacements');
    peer.postMessage('ast_peer_replacement');
    await new Promise((resolve) => setTimeout(resolve, 10));

    try {
      expect(received).toEqual(['ast_peer_replacement']);
    } finally {
      peer.close();
      stop();
      __resetAssetReplacementChannelForTesting();
    }
  });

  it('is lazy, singleton-scoped, and does not construct during SSR', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.resetModules();
    const { getAssetPool } = await import('@/lib/media/asset-pool');

    expect(() => getAssetPool()).toThrow(/requires IndexedDB/);

    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    const first = getAssetPool();
    const second = getAssetPool();

    expect(second).toBe(first);
    expect(await indexedDB.databases()).toEqual([]);

    await first.put(new Blob(['asset'], { type: 'text/plain' }));
    expect((await indexedDB.databases()).map((entry) => entry.name)).toContain('maic-asset-pool');
    await first.close();
  });

  it('fails loudly while deletion is deferred, then reopens after a successful retry', async () => {
    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.resetModules();
    const { AssetPoolDeletionDeferredError, clearAssetPool, getAssetPool, putAsset } =
      await import('@/lib/media/asset-pool');
    const first = getAssetPool();
    await first.put(new Blob(['old'], { type: 'text/plain' }));
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('maic-asset-pool');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await expect(clearAssetPool()).rejects.toBeInstanceOf(AssetPoolDeletionDeferredError);
    const blockedPut = Promise.race([
      putAsset(new Blob(['blocked'], { type: 'text/plain' })),
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('putAsset hung behind the pending delete.')), 100);
      }),
    ]);
    await expect(blockedPut).rejects.toThrow('BrowserAssetStore is closed.');
    blocker.close();

    await expect(clearAssetPool()).resolves.toBeUndefined();
    const fresh = getAssetPool();
    expect(fresh).not.toBe(first);
    await expect(putAsset(new Blob(['new'], { type: 'text/plain' }))).resolves.toMatch(/^ast_/);
    await fresh.close();
  });
});
