import { clearAssetPool } from '@/lib/media/asset-pool';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import { LEARNER_KEY_KV_KEY } from '@/lib/runtime/learner-key';

import { clearDeviceStorage } from './database';

/**
 * Clear what this browser keeps for itself: the device-local database (media
 * and narration cache, staged images, undo history, voice profiles) and the
 * in-memory asset client. Courses, chat history, learner progress and media on
 * the server are durable user data and are not touched; neither is the
 * pre-server browser database, which the one-way importer still has to read.
 */
export async function clearLocalCache(): Promise<void> {
  clearPendingMediaAllocations();
  await clearAssetPool();
  await clearDeviceStorage();
}

/**
 * The localStorage key under which browser storage kept its learner key (the
 * `device` KV scope of the `maic` namespace). Runtime data written before
 * persistence moved to the server is partitioned by it.
 */
const LEGACY_LEARNER_KEY_STORAGE_KEY = `maic:device:${LEARNER_KEY_KV_KEY}`;

/**
 * The localStorage prefix of the one-way importer's completion ledgers (one
 * per server owner, `lib/legacy-browser-import/ledger.ts`). They record what
 * has already moved to the server, so clearing the cache must keep them:
 * without them, a course the user deleted on the server after it was imported
 * could be imported again from the untouched browser copy.
 */
export const LEGACY_IMPORT_LEDGER_PREFIX = 'maic:legacy-import:';

/**
 * `localStorage.clear()`, except for the values the one-way importer needs:
 * the learner key that finds this browser's pre-server runtime data, and the
 * importer's ledgers. Clearing the cache must not orphan data the user has not
 * moved to the server yet, nor bring back data the user removed after it was
 * moved.
 */
export function clearLocalStorageKeepingImportState(storage: Storage = localStorage): void {
  const kept = new Map<string, string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    if (key === LEGACY_LEARNER_KEY_STORAGE_KEY || key.startsWith(LEGACY_IMPORT_LEDGER_PREFIX)) {
      const value = storage.getItem(key);
      if (value !== null) kept.set(key, value);
    }
  }
  storage.clear();
  for (const [key, value] of kept) storage.setItem(key, value);
}
