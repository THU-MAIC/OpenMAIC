import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('getAssetPool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
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
});
