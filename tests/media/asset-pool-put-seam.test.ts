/**
 * What a successful pool write means, stated once.
 *
 * "The store accepted a write, so it is not out of room" was enforced at three
 * call sites under slightly different conditions — the media commit, narration
 * adoption, and generated narration — which made it a convention rather than an
 * invariant. The next path that writes to the pool and forgets would leave
 * every course of that browser standing down its generation while the store
 * actually had room, and nothing would say why.
 *
 * There is one place a write can succeed, so that is where the note is retired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ put: vi.fn() }));

vi.mock('@/lib/media/asset-pool-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/asset-pool-config')>();
  return {
    ...actual,
    resolveConfiguredAssetPoolStore: () =>
      ({ put: mocks.put }) as unknown as import('@/lib/media/asset-pool-config').AssetPoolStore,
  };
});

import { putAsset } from '@/lib/media/asset-pool';
import {
  isAssetStorageFull,
  markAssetStorageFull,
  setAssetStorageFullStoreForTests,
} from '@/lib/media/asset-storage-full';

function memoryKv() {
  const entries = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (entries.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    remove: async (key: string) => {
      entries.delete(key);
    },
    keys: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)),
  };
}

describe('storing bytes in the pool', () => {
  beforeEach(() => {
    setAssetStorageFullStoreForTests(memoryKv());
    mocks.put.mockReset().mockResolvedValue('ast_stored');
  });

  afterEach(() => {
    setAssetStorageFullStoreForTests(undefined);
  });

  it('retires the course’s "no room" note, whoever asked for the write', async () => {
    await markAssetStorageFull('course-a');
    await markAssetStorageFull('course-b');

    await expect(
      putAsset(new Blob(['bytes']), { contentType: 'image/png' }, { stageId: 'course-a' }),
    ).resolves.toBe('ast_stored');

    await expect(isAssetStorageFull('course-a')).resolves.toBe(false);
    // The store checks each write against the headroom it has left, so one
    // course's accepted write says nothing about a write another course would
    // make. Retiring both would be the deployment-wide reading this key does
    // not have.
    await expect(isAssetStorageFull('course-b')).resolves.toBe(true);
  });

  it('leaves the note alone when the write is refused', async () => {
    await markAssetStorageFull('course-a');
    mocks.put.mockRejectedValue(
      Object.assign(new Error('asset quota exceeded for this principal'), {
        status: 507,
        code: 'ASSET_QUOTA_EXCEEDED',
      }),
    );

    await expect(
      putAsset(new Blob(['bytes']), { contentType: 'image/png' }, { stageId: 'course-a' }),
    ).rejects.toThrow('asset quota exceeded');

    await expect(isAssetStorageFull('course-a')).resolves.toBe(true);
  });

  it('stores without a course, and retires nothing', async () => {
    await markAssetStorageFull('course-a');

    await expect(putAsset(new Blob(['bytes']))).resolves.toBe('ast_stored');

    expect(mocks.put).toHaveBeenCalledTimes(1);
    await expect(isAssetStorageFull('course-a')).resolves.toBe(true);
  });
});
