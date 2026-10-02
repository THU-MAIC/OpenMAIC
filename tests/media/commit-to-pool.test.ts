/**
 * The one client-side pool commit sequence, and its one refusal rule.
 *
 * Three paths reach the pool from this browser and each used to spell the
 * sequence — and, worse, the meaning of a refusal — for itself. This suite pins
 * what the shared primitive now guarantees for all of them: the order of the
 * four steps, the difference between "the store had no room" and any other
 * failure, and the promise `refused-retained` makes about where the bytes are
 * by the time the caller reads it.
 *
 * The pool is doubled at the store rather than at `putAsset`, deliberately: the
 * stage seam that retires a course's "store is full" note lives inside
 * `putAsset`, and this module must go through it rather than around it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolPut: vi.fn(),
}));

vi.mock('@/lib/media/asset-pool-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/asset-pool-config')>();
  return {
    ...actual,
    resolveConfiguredAssetPoolStore: () =>
      ({ put: mocks.poolPut }) as unknown as import('@/lib/media/asset-pool-config').AssetPoolStore,
  };
});

import { commitToPool } from '@/lib/media/commit-to-pool';
import {
  isAssetStorageFull,
  markAssetStorageFull,
  setAssetStorageFullStoreForTests,
} from '@/lib/media/asset-storage-full';

const stageId = 'commit-stage';

function quotaRefusal(): Error {
  return Object.assign(new Error('asset quota exceeded for this principal'), {
    status: 507,
    code: 'ASSET_QUOTA_EXCEEDED',
  });
}

/** The device KV the storage-full marker lives in, in memory. */
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

function plan(overrides: Record<string, unknown> = {}) {
  return {
    stageId,
    slot: 'gen_img_3',
    bytes: new Blob(['generated-bytes'], { type: 'image/png' }),
    mimeType: 'image/png',
    writeBack: vi.fn().mockResolvedValue('written'),
    mirror: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('commitToPool', () => {
  beforeEach(() => {
    mocks.poolPut.mockReset().mockResolvedValue('ast_allocated');
  });

  it('stores, writes back and mirrors, in that order', async () => {
    const order: string[] = [];
    mocks.poolPut.mockImplementation(async () => {
      order.push('put');
      return 'ast_allocated';
    });
    const current = plan({
      meta: { durationSeconds: 2.5 },
      writeBack: vi.fn().mockImplementation(async () => {
        order.push('writeBack');
        return 'held';
      }),
      mirror: vi.fn().mockImplementation(async () => {
        order.push('mirror');
      }),
    });

    await expect(commitToPool(current)).resolves.toEqual({
      status: 'stored',
      assetId: 'ast_allocated',
      placement: 'held',
    });

    expect(order).toEqual(['put', 'writeBack', 'mirror']);
    const [, meta] = mocks.poolPut.mock.calls[0] as [Blob, Record<string, unknown>];
    expect(meta).toEqual({ contentType: 'image/png', durationSeconds: 2.5 });
    expect(current.writeBack).toHaveBeenCalledWith('ast_allocated');
    expect(current.mirror).toHaveBeenCalledWith('ast_allocated', 'held');
  });

  // A refusal is an answer, not an exception: each caller has a different thing
  // to do with it, and one of them (adoption) treats it as an ordinary step.
  it('reports a full store as refused-retained rather than throwing', async () => {
    const error = quotaRefusal();
    mocks.poolPut.mockRejectedValue(error);
    const retain = vi.fn().mockResolvedValue(undefined);
    const current = plan({ retain });

    const outcome = await commitToPool(current);

    expect(outcome).toMatchObject({
      status: 'refused-retained',
      code: 'ASSET_QUOTA_EXCEEDED',
      error,
      refused: { slot: 'gen_img_3', mimeType: 'image/png', error },
    });
    // Awaited before the outcome is reported, so the name is a statement about
    // what is on disk rather than about what was scheduled.
    expect(retain).toHaveBeenCalledTimes(1);
    expect(current.writeBack).not.toHaveBeenCalled();
    expect(current.mirror).not.toHaveBeenCalled();
  });

  // The bytes leave with the outcome whether or not a sink was supplied: the
  // media pass carries them out to the failure record it writes around them.
  it('hands the refused bytes back even with no retain sink', async () => {
    mocks.poolPut.mockRejectedValue(quotaRefusal());

    const outcome = await commitToPool(plan());

    expect(outcome.status).toBe('refused-retained');
    if (outcome.status !== 'refused-retained') return;
    await expect(outcome.refused.bytes.text()).resolves.toBe('generated-bytes');
  });

  // `refused-retained` is what a caller reads before stamping `slot` into
  // something durable. A sink that could not keep the bytes leaves nothing to
  // read back, so the outcome must not claim otherwise.
  it('demotes a refusal to failed when the bytes could not be kept', async () => {
    mocks.poolPut.mockRejectedValue(quotaRefusal());
    const retentionError = new Error('local quota exceeded');
    const current = plan({ retain: vi.fn().mockRejectedValue(retentionError) });

    await expect(commitToPool(current)).resolves.toEqual({
      status: 'failed',
      error: retentionError,
    });

    expect(current.writeBack).not.toHaveBeenCalled();
    expect(current.mirror).not.toHaveBeenCalled();
  });

  // By the time the mirror runs the bytes are in the pool and the document
  // names them, so a cache this browser could not write costs a re-download and
  // nothing else. Holding that here rather than at each caller is what keeps
  // the next caller from failing a commit that already happened.
  it('reports stored even when the local mirror fails', async () => {
    const current = plan({ mirror: vi.fn().mockRejectedValue(new Error('cache unavailable')) });

    await expect(commitToPool(current)).resolves.toEqual({
      status: 'stored',
      assetId: 'ast_allocated',
      placement: 'written',
    });

    expect(current.mirror).toHaveBeenCalledTimes(1);
  });

  // Anything that is not the store saying "no room" says nothing about a later
  // attempt, so nothing is kept under a key a later attempt would read.
  it('keeps nothing for a failure that is not a refusal for room', async () => {
    const error = new Error('asset store unavailable');
    mocks.poolPut.mockRejectedValue(error);
    const retain = vi.fn().mockResolvedValue(undefined);
    const current = plan({ retain });

    await expect(commitToPool(current)).resolves.toEqual({ status: 'failed', error });

    expect(retain).not.toHaveBeenCalled();
    expect(current.writeBack).not.toHaveBeenCalled();
    expect(current.mirror).not.toHaveBeenCalled();
  });

  // A code that is not the storage contract's is not a refusal for room either,
  // however it arrived.
  it('treats an unrelated structured code as an ordinary failure', async () => {
    mocks.poolPut.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'CONTENT_SENSITIVE' }),
    );

    await expect(commitToPool(plan())).resolves.toMatchObject({ status: 'failed' });
  });

  // `errorCode` is the generation routes' field, on an error class a pool write
  // cannot raise. Accepting it here would widen the predicate past anything
  // `putAsset` can throw, on values from another contract.
  it('does not read the generation routes\u2019 errorCode field', async () => {
    mocks.poolPut.mockRejectedValue(
      Object.assign(new Error('nope'), { errorCode: 'ASSET_QUOTA_EXCEEDED' }),
    );

    await expect(commitToPool(plan())).resolves.toMatchObject({ status: 'failed' });
  });

  // The write-back's errors are the caller's: only it knows whether the
  // allocation was retained, which decides what may be reclaimed.
  it('lets a write-back failure propagate, and mirrors nothing', async () => {
    const current = plan({ writeBack: vi.fn().mockRejectedValue(new Error('document refused')) });

    await expect(commitToPool(current)).rejects.toThrow('document refused');

    expect(current.mirror).not.toHaveBeenCalled();
  });

  // The marker belongs to the seam and to the paths that spend provider money.
  // The primitive reads neither and writes neither: a successful write retires
  // it because `putAsset` does that, and a refusal here sets nothing.
  it('retires the course marker through the seam, and never sets one', async () => {
    setAssetStorageFullStoreForTests(memoryKv());
    try {
      await markAssetStorageFull(stageId);
      await expect(isAssetStorageFull(stageId)).resolves.toBe(true);

      await expect(commitToPool(plan())).resolves.toMatchObject({ status: 'stored' });
      await expect(isAssetStorageFull(stageId)).resolves.toBe(false);

      mocks.poolPut.mockRejectedValue(quotaRefusal());
      await expect(commitToPool(plan())).resolves.toMatchObject({ status: 'refused-retained' });
      await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
    } finally {
      setAssetStorageFullStoreForTests(undefined);
    }
  });

  // A caller outside a course has no course marker to retire, so the seam is
  // handed no stage rather than a made-up one.
  it('omits the stage seam when the caller has no course', async () => {
    await expect(commitToPool(plan({ stageId: undefined }))).resolves.toMatchObject({
      status: 'stored',
    });
  });
});
