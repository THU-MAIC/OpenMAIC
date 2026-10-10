import type { Slide } from '@openmaic/dsl';

import { db } from '@/lib/device-storage/database';
import { sha256Hex } from '@/lib/legacy-browser-import/digest';
import { createLogger } from '@/lib/logger';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';
import { getPersistenceLearnerKey } from '@/lib/persistence/bootstrap';
import { loadFirstSlideThumbnail } from '@/lib/utils/stage-storage';

/**
 * The home library's thumbnail cache, in the device cache (`courseThumbnails`
 * in `maic-device-cache`).
 *
 * A thumbnail costs a whole course document read plus its first slide's media
 * bytes, and the server answers none of them from the browser's HTTP cache. The
 * thumbnail is derived data, so this keeps the derived result instead: the
 * first slide and the bytes of its media, per course, valid for exactly the
 * course version (`updatedAt`) it was derived from. A reload then shows
 * unchanged courses' thumbnails without a request; a course whose `updatedAt`
 * moved is read again and its entry replaced.
 *
 * Entries are partitioned by owner: the key is a one-way digest of the
 * server-derived owner key (the learner key), so a claimed or switched owner
 * never sees another owner's thumbnails, and the owner id, which is the only
 * key to an anonymous library, is not written to disk. Clearing the local
 * cache deletes the whole database, these entries included. The cache is
 * bounded ({@link MAX_THUMBNAIL_CACHE_ENTRIES}, {@link MAX_THUMBNAIL_CACHE_BYTES})
 * and evicts the least recently used entries first.
 *
 * The cache only ever saves work: every failure to read or write it is logged
 * and the thumbnail is loaded from the server as before.
 */

const log = createLogger('CourseThumbnailCache');

export const MAX_THUMBNAIL_CACHE_ENTRIES = 300;
export const MAX_THUMBNAIL_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * The derivation the cached entries follow. Bump it when a thumbnail would be
 * derived differently, so entries derived the old way are loaded again.
 *
 * 2: a video without a poster carries its opening frame as one.
 */
export const COURSE_THUMBNAIL_FORMAT = 2;

/** How long after a write the bounds are enforced (writes come in bursts). */
const EVICTION_DELAY_MS = 1000;

let ownerKeyPromise: Promise<string> | undefined;

/** The cache partition of this page's owner. Not cached on failure. */
export function courseThumbnailOwnerKey(): Promise<string> {
  return (ownerKeyPromise ??= getPersistenceLearnerKey().then(
    (learnerKey) => sha256Hex(`course-thumbnail-owner:${learnerKey}`),
    (error: unknown) => {
      ownerKeyPromise = undefined;
      throw error;
    },
  ));
}

/** @internal Forget the memoized owner partition (tests). */
export function __resetCourseThumbnailOwnerKeyForTesting(): void {
  ownerKeyPromise = undefined;
}

/**
 * A cached thumbnail of `stageId` at `version`: the slide (its media as fresh
 * object URLs the caller owns, like a loaded one), null for a course without a
 * slide, or undefined on a miss.
 */
export async function readCachedCourseThumbnail(
  ownerKey: string,
  stageId: string,
  version: number,
): Promise<Slide | null | undefined> {
  const record = await db.courseThumbnails.get([ownerKey, stageId]);
  if (!record || record.version !== version || record.format !== COURSE_THUMBNAIL_FORMAT) {
    return undefined;
  }
  void db.courseThumbnails
    .update([ownerKey, stageId], { usedAt: Date.now() })
    .catch((error: unknown) => log.warn('Could not touch a cached thumbnail:', error));
  if (!record.slide) return null;
  const slide = structuredClone(record.slide);
  const bytesBySlot = new Map(record.media.map((entry) => [entry.slot, entry.blob]));
  let index = 0;
  for (const slot of slideMediaReferenceSlots(slide)) {
    const blob = bytesBySlot.get(index++);
    if (blob) slot.write(URL.createObjectURL(blob));
  }
  return slide;
}

/**
 * Keep the thumbnail of `stageId` at `version`, replacing whatever the cache
 * held for the course. Media slots holding object URLs are stored as their
 * bytes; everything else in the slide is stored as is.
 */
export async function writeCachedCourseThumbnail(
  ownerKey: string,
  stageId: string,
  version: number,
  slide: Slide | null,
): Promise<void> {
  const stored = slide ? structuredClone(slide) : null;
  // Every object URL is fetched before the first await: a fetch resolves its
  // blob URL when it starts, so the caller may revoke them right after.
  const reads: Array<Promise<{ slot: number; blob: Blob }>> = [];
  if (stored) {
    let index = 0;
    for (const slot of slideMediaReferenceSlots(stored)) {
      const slotIndex = index++;
      const value = slot.read();
      if (!value?.startsWith('blob:')) continue;
      reads.push(
        fetch(value).then(async (response) => ({ slot: slotIndex, blob: await response.blob() })),
      );
      slot.write('');
    }
  }
  const media = await Promise.all(reads);
  const bytes = media.reduce((sum, entry) => sum + entry.blob.size, 0);
  await db.courseThumbnails.put({
    ownerKey,
    stageId,
    version,
    format: COURSE_THUMBNAIL_FORMAT,
    slide: stored,
    media,
    bytes,
    usedAt: Date.now(),
  });
  scheduleEviction();
}

let evictionTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleEviction(): void {
  if (evictionTimer !== undefined) return;
  evictionTimer = setTimeout(() => {
    evictionTimer = undefined;
    void evictCourseThumbnails().catch((error: unknown) =>
      log.warn('Could not trim the thumbnail cache:', error),
    );
  }, EVICTION_DELAY_MS);
}

/** Drop least recently used thumbnails until the cache is within its bounds. */
export async function evictCourseThumbnails(
  maxEntries = MAX_THUMBNAIL_CACHE_ENTRIES,
  maxBytes = MAX_THUMBNAIL_CACHE_BYTES,
): Promise<void> {
  await db.transaction('rw', db.courseThumbnails, async () => {
    const entries: Array<{ key: [string, string]; bytes: number }> = [];
    await db.courseThumbnails
      .orderBy('usedAt')
      .each((record) =>
        entries.push({ key: [record.ownerKey, record.stageId], bytes: record.bytes }),
      );
    let count = entries.length;
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const evicted: Array<[string, string]> = [];
    for (const entry of entries) {
      if (count <= maxEntries && total <= maxBytes) break;
      evicted.push(entry.key);
      count -= 1;
      total -= entry.bytes;
    }
    if (evicted.length > 0) await db.courseThumbnails.bulkDelete(evicted);
  });
}

/**
 * Load a course's thumbnail at `version` (its `updatedAt`): from the cache
 * when it holds that version, otherwise from the server, keeping a complete
 * result for the next visit.
 */
export async function loadCourseThumbnail(
  stageId: string,
  version: number,
  signal: AbortSignal,
): Promise<Slide | null> {
  let ownerKey: string | undefined;
  try {
    ownerKey = await courseThumbnailOwnerKey();
    const cached = await readCachedCourseThumbnail(ownerKey, stageId, version);
    if (cached !== undefined) return cached;
  } catch (error) {
    log.warn(`Could not read the cached thumbnail of ${stageId}:`, error);
  }
  signal.throwIfAborted();
  const { slide, complete } = await loadFirstSlideThumbnail(stageId, signal);
  if (ownerKey !== undefined && complete && !signal.aborted) {
    // Not awaited: the card shows the thumbnail now. The write reads the
    // slide's object URLs synchronously, before the loader can release them.
    void writeCachedCourseThumbnail(ownerKey, stageId, version, slide).catch((error: unknown) =>
      log.warn(`Could not cache the thumbnail of ${stageId}:`, error),
    );
  }
  return slide;
}
