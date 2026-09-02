import { IDBFactory } from 'fake-indexeddb';
import { HttpAssetStore } from '@openmaic/storage';
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
    const { BrowserAssetStore } = await import('@openmaic/storage');

    expect(second).toBe(first);
    expect(first).toBeInstanceOf(BrowserAssetStore);
    expect(await indexedDB.databases()).toEqual([]);

    await first.put(new Blob(['asset'], { type: 'text/plain' }));
    expect((await indexedDB.databases()).map((entry) => entry.name)).toContain('maic-asset-pool');
    await first.close();
  });

  it('fails loudly while deletion is deferred, then reopens after a successful retry', async () => {
    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.resetModules();
    const { AssetPoolDeletionDeferredError, clearAssetPool, getAssetPool } =
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
      getAssetPool().put(new Blob(['blocked'], { type: 'text/plain' })),
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('putAsset hung behind the pending delete.')), 100);
      }),
    ]);
    await expect(blockedPut).rejects.toThrow('BrowserAssetStore is closed.');
    blocker.close();

    await expect(clearAssetPool()).resolves.toBeUndefined();
    const fresh = getAssetPool();
    expect(fresh).not.toBe(first);
    await expect(fresh.put(new Blob(['new'], { type: 'text/plain' }))).resolves.toMatch(/^ast_/);
    await fresh.close();
  });

  it('uses a configured instance and seals the seam after resolution', async () => {
    const injected = {
      put: vi.fn(),
      resolve: vi.fn(),
      invalidate: vi.fn(),
      remove: vi.fn(),
      replace: vi.fn(),
      release: vi.fn(),
      close: vi.fn(),
    } as never;
    const config = await import('@/lib/media/asset-pool-config');
    config.configureAssetPoolStorage({ store: injected, serverBacked: true });
    const { getAssetPool } = await import('@/lib/media/asset-pool');

    expect(getAssetPool()).toBe(injected);
    expect(() => config.configureAssetPoolStorage({ store: injected })).toThrow(
      'configureAssetPoolStorage must be called at module-level bootstrap, before any asset consumer runs — a component effect is too late.',
    );
  });

  it('closes server clients and revokes local URLs without deleting remote assets', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new Error('remote asset deletion was attempted');
      return new Response(new Blob(['server-bytes'], { type: 'image/png' }), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-asset-revision': '1',
        },
      });
    });
    const client = new HttpAssetStore({ baseUrl: '/api/persistence', fetch });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:server-asset');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const remove = vi
      .spyOn(client, 'remove')
      .mockRejectedValue(new Error('remote asset deletion was attempted'));
    const close = vi.spyOn(client, 'close');
    const config = await import('@/lib/media/asset-pool-config');
    config.configureAssetPoolStorage({ store: client, serverBacked: true });
    const { clearAssetPool, getAssetPool } = await import('@/lib/media/asset-pool');

    await expect(getAssetPool().resolve('ast_server')).resolves.toBe('blob:server-asset');
    await expect(clearAssetPool()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:server-asset');
    expect(remove).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true);
  });

  it('rebuilds a fresh usable server client after clear', async () => {
    const makeClient = (url: string) => ({
      put: vi.fn(),
      resolve: vi.fn().mockResolvedValue(url),
      invalidate: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      replace: vi.fn(),
      release: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const firstClient = makeClient('blob:first-client');
    const secondClient = makeClient('blob:second-client');
    const factory = vi.fn().mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);
    const config = await import('@/lib/media/asset-pool-config');
    config.configureAssetPoolStorage({ store: factory, serverBacked: true });
    const { clearAssetPool, getAssetPool } = await import('@/lib/media/asset-pool');

    const first = getAssetPool();
    await expect(clearAssetPool()).resolves.toBeUndefined();
    const reopened = getAssetPool();

    expect(first).toBe(firstClient);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(reopened).toBe(secondClient);
    expect(reopened).not.toBe(first);
    await expect(reopened.resolve('ast_reopened')).resolves.toBe('blob:second-client');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('refuses to reinstall a concrete store after clear instead of reviving the closed one', async () => {
    // The factory form above reopens cleanly; a concrete instance cannot, and
    // silently reinstalling it would put a closed store back in service.
    const injected = {
      put: vi.fn(),
      resolve: vi.fn(),
      invalidate: vi.fn(),
      remove: vi.fn(),
      replace: vi.fn(),
      release: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    const config = await import('@/lib/media/asset-pool-config');
    config.configureAssetPoolStorage({ store: injected, serverBacked: true });
    const { clearAssetPool, getAssetPool } = await import('@/lib/media/asset-pool');

    expect(getAssetPool()).toBe(injected);
    await expect(clearAssetPool()).resolves.toBeUndefined();

    expect(() => getAssetPool()).toThrow(/cannot be reopened[\s\S]*factory/);
  });
});
