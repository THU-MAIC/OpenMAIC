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
 * `localStorage.clear()`, except for the one value the one-way importer needs
 * to find this browser's pre-server runtime data. Clearing the cache must not
 * orphan data the user has not moved to the server yet.
 */
export function clearLocalStorageKeepingImportState(storage: Storage = localStorage): void {
  const legacyLearnerKey = storage.getItem(LEGACY_LEARNER_KEY_STORAGE_KEY);
  storage.clear();
  if (legacyLearnerKey !== null) storage.setItem(LEGACY_LEARNER_KEY_STORAGE_KEY, legacyLearnerKey);
}
