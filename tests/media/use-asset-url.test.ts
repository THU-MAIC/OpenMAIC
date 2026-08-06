import { IDBFactory } from 'fake-indexeddb';
import { BrowserAssetStore } from '@openmaic/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAssetPool, putAsset, replaceAsset } from '@/lib/media/asset-pool';
import { resolveMediaRef } from '@/lib/media/resolve-media-ref';
import {
  assetRefExists,
  createAssetUrlLeaseBatchPublisher,
  invalidateAssetUrlLeaseCache,
  trackAssetUrl,
  withAssetUrl,
} from '@/lib/media/use-asset-url';

describe('asset URL ownership', () => {
  let created: Blob[];

  beforeEach(() => {
    created = [];
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        created.push(blob);
        return `blob:test-${created.length}`;
      }),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('balances resolve and release on cleanup', async () => {
    const pool = new BrowserAssetStore({ indexedDB: new IDBFactory(), dbName: 'asset-url-one' });
    const ref = await pool.put(new Blob(['first'], { type: 'text/plain' }));
    let cleanup!: () => void;
    const resolved = new Promise<string | null>((resolve) => {
      cleanup = trackAssetUrl(ref, resolve, pool);
    });

    expect(await resolved).toBe('blob:test-1');
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    await pool.close();
  });

  it('releases the old ref before owning a changed ref', async () => {
    const pool = new BrowserAssetStore({ indexedDB: new IDBFactory(), dbName: 'asset-url-change' });
    const oldRef = await pool.put(new Blob(['old'], { type: 'text/plain' }));
    const newRef = await pool.put(new Blob(['new'], { type: 'text/plain' }));

    let finishOld!: (url: string | null) => void;
    const oldResolved = new Promise<string | null>((resolve) => {
      finishOld = resolve;
    });
    const cleanupOld = trackAssetUrl(oldRef, finishOld, pool);
    expect(await oldResolved).toBe('blob:test-1');
    cleanupOld();

    let finishNew!: (url: string | null) => void;
    const newResolved = new Promise<string | null>((resolve) => {
      finishNew = resolve;
    });
    const cleanupNew = trackAssetUrl(newRef, finishNew, pool);
    expect(await newResolved).toBe('blob:test-2');
    cleanupNew();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-2');
    await pool.close();
  });

  it('does not release a renderer-owned snapshot during an existence probe', async () => {
    const pool = new BrowserAssetStore({ indexedDB: new IDBFactory(), dbName: 'asset-url-probe' });
    const ref = await pool.put(new Blob(['shared'], { type: 'text/plain' }));
    let cleanup!: () => void;
    await new Promise<string | null>((resolve) => {
      cleanup = trackAssetUrl(ref, resolve, pool);
    });

    await expect(assetRefExists(ref, pool)).resolves.toBe(true);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    await pool.close();
  });

  it('evicts the settled cache entry after the final lease is released', async () => {
    const pool = new BrowserAssetStore({ indexedDB: new IDBFactory(), dbName: 'asset-url-evict' });
    const ref = await pool.put(new Blob(['old'], { type: 'text/plain' }));

    await expect(withAssetUrl(ref, (url) => url, pool)).resolves.toBe('blob:test-1');
    await pool.replace(ref, new Blob(['new'], { type: 'text/plain' }));
    await expect(withAssetUrl(ref, (url) => url, pool)).resolves.toBe('blob:test-2');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);

    await pool.close();
  });

  it('publishes same-id replacement bytes to an active lease', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const ref = await putAsset(new Blob(['old'], { type: 'text/plain' }));
    const urls: string[] = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const cleanup = trackAssetUrl(ref, (url) => {
      if (!url) return;
      urls.push(url);
      if (urls.length === 1) resolveFirst();
      if (urls.length === 2) resolveSecond();
    });

    await first;
    await replaceAsset(ref, new Blob(['new'], { type: 'text/plain' }));
    await second;

    expect(urls).toEqual(['blob:test-1', 'blob:test-2']);
    await expect(Promise.all(created.map((blob) => blob.text()))).resolves.toEqual(['old', 'new']);

    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clearAssetPool();
  });

  it('waits for an in-flight final release before reacquiring the ref', async () => {
    let finishRelease!: () => void;
    let releaseStarted!: () => void;
    const releasing = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const pool = {
      resolve: vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce('blob:first')
        .mockResolvedValueOnce('blob:second'),
      release: vi.fn(async () => {
        releaseStarted();
        await releasing;
      }),
    };

    const first = withAssetUrl('asset', (url) => url, pool);
    await started;
    const second = withAssetUrl('asset', (url) => url, pool);
    await Promise.resolve();

    expect(pool.resolve).toHaveBeenCalledTimes(1);
    finishRelease();
    await expect(first).resolves.toBe('blob:first');
    await expect(second).resolves.toBe('blob:second');
    expect(pool.resolve).toHaveBeenCalledTimes(2);
    expect(pool.release).toHaveBeenCalledTimes(2);
  });

  it('publishes a complete initial batch and every later replacement snapshot', () => {
    const publications: Array<Readonly<Record<string, unknown>>> = [];
    const publish = createAssetUrlLeaseBatchPublisher(['asset-a', 'asset-b'], (leases) => {
      publications.push(leases);
    });

    publish('asset-a', 'blob:a-old');
    expect(publications).toEqual([]);
    publish('asset-b', 'blob:b');
    expect(publications).toEqual([
      {
        'asset-a': { status: 'resolved', url: 'blob:a-old' },
        'asset-b': { status: 'resolved', url: 'blob:b' },
      },
    ]);

    publish('asset-a', 'blob:a-new');
    expect(publications[0]).not.toBe(publications[1]);
    expect(publications.at(-1)).toEqual({
      'asset-a': { status: 'resolved', url: 'blob:a-new' },
      'asset-b': { status: 'resolved', url: 'blob:b' },
    });
    expect(
      resolveMediaRef(
        'asset-a',
        { status: 'done', objectUrl: 'blob:task-new', retryCount: 1 },
        publications.at(-1)?.['asset-a'] as {
          status: 'resolved';
          url: string;
        },
      ),
    ).toEqual({ kind: 'url', url: 'blob:a-new' });
  });

  it('does not let an early replacement complete a batch before every ref resolves', () => {
    const publications: Array<Readonly<Record<string, unknown>>> = [];
    const publish = createAssetUrlLeaseBatchPublisher(['asset-a', 'asset-b'], (leases) => {
      publications.push(leases);
    });

    publish('asset-a', 'blob:a-old');
    publish('asset-a', 'blob:a-new');
    expect(publications).toEqual([]);
    publish('asset-b', 'blob:b');

    expect(publications).toEqual([
      {
        'asset-a': { status: 'resolved', url: 'blob:a-new' },
        'asset-b': { status: 'resolved', url: 'blob:b' },
      },
    ]);
  });

  it('serializes replacement refresh behind an unmount release before a new mount resolves', async () => {
    let finishRelease!: () => void;
    let releaseStarted!: () => void;
    const releasing = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const events: string[] = [];
    const pool = {
      resolve: vi
        .fn<() => Promise<string | null>>()
        .mockImplementationOnce(async () => {
          events.push('resolve-old');
          return 'blob:old';
        })
        .mockImplementation(async () => {
          events.push('resolve-new');
          return 'blob:new';
        }),
      release: vi.fn(async () => {
        events.push('release-start');
        releaseStarted();
        await releasing;
        events.push('release-finish');
      }),
    };

    let cleanupOld!: () => void;
    await new Promise<string | null>((resolve) => {
      cleanupOld = trackAssetUrl('asset', resolve, pool);
    });
    cleanupOld();
    await started;

    const mountedUrls: Array<string | null> = [];
    const cleanupNew = trackAssetUrl('asset', (url) => mountedUrls.push(url), pool);
    const invalidation = invalidateAssetUrlLeaseCache('asset', pool);
    await Promise.resolve();
    expect(pool.resolve).toHaveBeenCalledTimes(1);

    finishRelease();
    await invalidation;
    await vi.waitFor(() => expect(mountedUrls).toEqual(['blob:new']));
    expect(events.indexOf('release-finish')).toBeLessThan(events.indexOf('resolve-new'));

    cleanupNew();
    await vi.waitFor(() => expect(pool.release).toHaveBeenCalledTimes(2));
  });

  it('evicts a rejected replacement refresh so a later acquirer can recover', async () => {
    const pool = {
      resolve: vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce('blob:old')
        .mockRejectedValueOnce(new Error('transient resolve failure'))
        .mockResolvedValueOnce('blob:recovered'),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const updates: Array<string | null> = [];
    let cleanup!: () => void;
    await new Promise<void>((resolve) => {
      cleanup = trackAssetUrl(
        'asset',
        (url) => {
          updates.push(url);
          resolve();
        },
        pool,
      );
    });

    await invalidateAssetUrlLeaseCache('asset', pool);
    await vi.waitFor(() => expect(updates).toEqual(['blob:old', null]));
    await expect(withAssetUrl('asset', (url) => url, pool)).resolves.toBe('blob:recovered');
    expect(pool.resolve).toHaveBeenCalledTimes(3);

    cleanup();
  });
});
