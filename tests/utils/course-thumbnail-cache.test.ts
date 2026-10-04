import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';

const mocks = vi.hoisted(() => ({
  learnerKey: vi.fn<() => Promise<string>>(),
  loadFirstSlideThumbnail:
    vi.fn<
      (stageId: string, signal?: AbortSignal) => Promise<{ slide: Slide | null; complete: boolean }>
    >(),
}));

vi.mock('@/lib/persistence/bootstrap', () => ({ getPersistenceLearnerKey: mocks.learnerKey }));
vi.mock('@/lib/utils/stage-storage', () => ({
  loadFirstSlideThumbnail: mocks.loadFirstSlideThumbnail,
}));
vi.mock('@/lib/media/asset-pool', () => ({ clearAssetPool: vi.fn(async () => {}) }));
vi.mock('@/lib/media/pending-media-allocations', () => ({
  clearPendingMediaAllocations: vi.fn(),
}));

import { clearLocalCache } from '@/lib/device-storage/clear-local-cache';
import { db } from '@/lib/device-storage/database';
import {
  COURSE_THUMBNAIL_FORMAT,
  __resetCourseThumbnailOwnerKeyForTesting,
  evictCourseThumbnails,
  loadCourseThumbnail,
} from '@/lib/utils/course-thumbnail-cache';

/** A first slide with one image whose bytes the load minted an object URL for. */
function loadedSlide(bytes: string): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {},
    elements: [
      {
        id: 'image-1',
        type: 'image',
        src: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })),
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        fixedRatio: true,
      },
      {
        id: 'image-2',
        type: 'image',
        src: 'https://cdn.example/remote.png',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        fixedRatio: true,
      },
    ],
  } as unknown as Slide;
}

function imageSrc(slide: Slide | null, index: number): string {
  return (slide!.elements[index] as { src: string }).src;
}

async function bytesAt(url: string): Promise<string> {
  return (await fetch(url)).text();
}

/** The fire-and-forget cache write of a server load has landed. */
async function cached(stageId: string, version: number): Promise<void> {
  await vi.waitFor(async () => {
    const records = await db.courseThumbnails.where('usedAt').above(0).toArray();
    expect(records.some((r) => r.stageId === stageId && r.version === version)).toBe(true);
  });
}

const signal = () => new AbortController().signal;

beforeEach(async () => {
  __resetCourseThumbnailOwnerKeyForTesting();
  await db.courseThumbnails.clear();
  mocks.learnerKey.mockReset().mockResolvedValue('anon:owner-a');
  mocks.loadFirstSlideThumbnail
    .mockReset()
    .mockImplementation(async () => ({ slide: loadedSlide('server-bytes'), complete: true }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('course thumbnail cache', () => {
  it('serves a course at the cached version without reading it from the server', async () => {
    const first = await loadCourseThumbnail('stage-1', 10, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(1);
    await cached('stage-1', 10);

    const second = await loadCourseThumbnail('stage-1', 10, signal());

    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(1);
    // The media comes back as a fresh object URL over the same bytes; other
    // values are kept as they were.
    expect(imageSrc(second, 0)).toMatch(/^blob:/);
    expect(imageSrc(second, 0)).not.toBe(imageSrc(first, 0));
    expect(await bytesAt(imageSrc(second, 0))).toBe('server-bytes');
    expect(imageSrc(second, 1)).toBe('https://cdn.example/remote.png');
  });

  it('reads a course again when its entry was derived the old way', async () => {
    await loadCourseThumbnail('stage-1', 10, signal());
    await cached('stage-1', 10);
    // An entry from before this derivation, e.g. one that kept a video
    // without a poster, which the page would load as a <video>.
    const [record] = await db.courseThumbnails.toArray();
    await db.courseThumbnails.put({ ...record, format: undefined });

    await loadCourseThumbnail('stage-1', 10, signal());

    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      const [rewritten] = await db.courseThumbnails.toArray();
      expect(rewritten.format).toBe(COURSE_THUMBNAIL_FORMAT);
    });
    await loadCourseThumbnail('stage-1', 10, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
  });

  it('caches a course without a slide too', async () => {
    mocks.loadFirstSlideThumbnail.mockResolvedValueOnce({ slide: null, complete: true });
    expect(await loadCourseThumbnail('stage-empty', 1, signal())).toBeNull();
    await cached('stage-empty', 1);

    expect(await loadCourseThumbnail('stage-empty', 1, signal())).toBeNull();
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(1);
  });

  it('reads a course again when its updatedAt changed, and replaces the entry', async () => {
    await loadCourseThumbnail('stage-1', 10, signal());
    await cached('stage-1', 10);

    mocks.loadFirstSlideThumbnail.mockResolvedValueOnce({
      slide: loadedSlide('edited-bytes'),
      complete: true,
    });
    const edited = await loadCourseThumbnail('stage-1', 11, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
    expect(await bytesAt(imageSrc(edited, 0))).toBe('edited-bytes');
    await cached('stage-1', 11);
    expect(await db.courseThumbnails.count()).toBe(1);

    const again = await loadCourseThumbnail('stage-1', 11, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
    expect(await bytesAt(imageSrc(again, 0))).toBe('edited-bytes');
  });

  it('does not keep a thumbnail whose media could not be read', async () => {
    mocks.loadFirstSlideThumbnail.mockResolvedValueOnce({
      slide: loadedSlide('partial'),
      complete: false,
    });
    await loadCourseThumbnail('stage-1', 10, signal());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.courseThumbnails.count()).toBe(0);

    await loadCourseThumbnail('stage-1', 10, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
  });

  it('is emptied by Clear Local Cache', async () => {
    await loadCourseThumbnail('stage-1', 10, signal());
    await cached('stage-1', 10);

    await clearLocalCache();

    expect(await db.courseThumbnails.count()).toBe(0);
    await loadCourseThumbnail('stage-1', 10, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
  });

  it('never shows one owner the thumbnails another owner cached', async () => {
    await loadCourseThumbnail('stage-1', 10, signal());
    await cached('stage-1', 10);

    // The page now belongs to another owner (a claim, a retired anonymous owner).
    __resetCourseThumbnailOwnerKeyForTesting();
    mocks.learnerKey.mockResolvedValue('user:owner-b');
    mocks.loadFirstSlideThumbnail.mockResolvedValueOnce({
      slide: loadedSlide('owner-b-bytes'),
      complete: true,
    });

    const forB = await loadCourseThumbnail('stage-1', 10, signal());

    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
    expect(await bytesAt(imageSrc(forB, 0))).toBe('owner-b-bytes');
    await vi.waitFor(async () => expect(await db.courseThumbnails.count()).toBe(2));
    // The partition is a digest: the owner id, an anonymous library's only
    // key, is never written to the device.
    const ownerKeys = (await db.courseThumbnails.toArray()).map((record) => record.ownerKey);
    expect(new Set(ownerKeys).size).toBe(2);
    for (const key of ownerKeys) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain('owner-a');
      expect(key).not.toContain('owner-b');
    }

    // Owner A still gets its own entry back.
    __resetCourseThumbnailOwnerKeyForTesting();
    mocks.learnerKey.mockResolvedValue('anon:owner-a');
    const forA = await loadCourseThumbnail('stage-1', 10, signal());
    expect(mocks.loadFirstSlideThumbnail).toHaveBeenCalledTimes(2);
    expect(await bytesAt(imageSrc(forA, 0))).toBe('server-bytes');
  });

  it('loads from the server when the owner cannot be resolved, and caches nothing', async () => {
    mocks.learnerKey.mockRejectedValue(new Error('offline'));

    const slide = await loadCourseThumbnail('stage-1', 10, signal());

    expect(await bytesAt(imageSrc(slide, 0))).toBe('server-bytes');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await db.courseThumbnails.count()).toBe(0);
  });

  it('evicts the least recently used thumbnails beyond its bounds', async () => {
    for (const [index, stageId] of ['old', 'mid', 'new'].entries()) {
      await db.courseThumbnails.put({
        ownerKey: 'o',
        stageId,
        version: 1,
        slide: null,
        media: [],
        bytes: 100,
        usedAt: index + 1,
      });
    }

    await evictCourseThumbnails(10, 250);
    expect((await db.courseThumbnails.toArray()).map((r) => r.stageId).sort()).toEqual([
      'mid',
      'new',
    ]);

    await evictCourseThumbnails(1, 10_000);
    expect((await db.courseThumbnails.toArray()).map((r) => r.stageId)).toEqual(['new']);
  });
});
