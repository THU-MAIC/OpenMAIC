import {
  LEGACY_AGENT_REGISTRY_KEY,
  legacyAgentImportIsComplete,
} from '@/lib/legacy-browser-import/agents-import';
import { LEDGER_KEY, legacyImportIsComplete } from '@/lib/legacy-browser-import/ledger';
import { MODEL_SETTINGS_IMPORT_KEY } from '@/lib/legacy-browser-import/model-settings';
import { MODEL_SETTINGS_UNIMPORTED_KEY } from '@/lib/legacy-browser-import/model-settings-unimported';
import { clearAssetPool } from '@/lib/media/asset-pool';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import {
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
  DRAFT_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
} from '@/lib/quiz/persistence';
import { LEARNER_KEY_KV_KEY } from '@/lib/runtime/learner-key';

import { clearDeviceStorage } from './database';

/**
 * Clear what this browser keeps for itself: the device-local database (media
 * and narration cache, course thumbnails, undo history, voice profiles) and the
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
 * The localStorage key of the one-way importer's completion ledger. It records
 * what has already moved to the server, so clearing the cache must keep it:
 * without it, a course the user deleted on the server after it was imported
 * could be imported again from the untouched browser copy. It holds no owner
 * information.
 */
export const LEGACY_IMPORT_LEDGER_KEY = LEDGER_KEY;

/**
 * Pre-runtime quiz state (drafts, answers, results, attempt ids) that earlier
 * builds kept in localStorage. It exists nowhere else, and the importer copies
 * it to the server with the course, so it is kept until the import is complete.
 */
const LEGACY_QUIZ_KEY_PREFIXES = [
  DRAFT_KEY_PREFIX,
  ANSWERS_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
];

/**
 * `localStorage.clear()`, except for the values the one-way importer needs:
 * the learner key that finds this browser's pre-server runtime data, the
 * importer's ledger, the model settings still waiting to be imported and the
 * ones that could not be (they exist nowhere else), the old agent registry
 * until the ledger records its custom agents as imported, and, until the
 * ledger records the import as complete, the pre-runtime quiz keys. Clearing
 * the cache must not orphan data the user has not moved to the server yet,
 * nor bring back data the user removed after it was moved.
 */
export function clearLocalStorageKeepingImportState(storage: Storage = localStorage): void {
  const keepQuizState = !legacyImportIsComplete(storage);
  const keepAgents = !legacyAgentImportIsComplete(storage);
  const kept = new Map<string, string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    const keep =
      key === LEGACY_LEARNER_KEY_STORAGE_KEY ||
      key === LEGACY_IMPORT_LEDGER_KEY ||
      key === MODEL_SETTINGS_IMPORT_KEY ||
      key === MODEL_SETTINGS_UNIMPORTED_KEY ||
      (keepAgents && key === LEGACY_AGENT_REGISTRY_KEY) ||
      (keepQuizState && LEGACY_QUIZ_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
    if (keep) {
      const value = storage.getItem(key);
      if (value !== null) kept.set(key, value);
    }
  }
  storage.clear();
  for (const [key, value] of kept) storage.setItem(key, value);
}
