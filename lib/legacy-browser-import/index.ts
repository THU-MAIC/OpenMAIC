/**
 * One-way import of what earlier builds stored in this browser into the
 * server, automatically and silently.
 *
 * TEMPORARY: this module exists only to carry existing browsers across the
 * move to server-backed persistence, and is deleted a few releases later. It
 * is self-contained so that removal is mechanical; see ./README.md for the
 * steps.
 *
 * What it guarantees:
 *
 * - Read-only on legacy data. It reads the pre-server databases through the
 *   read-only legacy module (`lib/legacy-browser-storage`) and the pre-runtime
 *   quiz keys, and never writes, clears or deletes any of them. What it writes
 *   goes to the server (through the app's own persistence seams), to the
 *   device cache, to device-scoped positions (playback, editor scene), and to
 *   its own ledger.
 * - Silent. No UI: a course simply appears in the library once it is on the
 *   server. Problems are reported with `console.warn` under a stable prefix.
 * - Off the critical path. It starts after the page has loaded and the
 *   browser is idle, and never blocks rendering.
 * - Idempotent and resumable. One ledger for the browser (`./ledger.ts`)
 *   records every step; a crash or reload resumes, and nothing is imported
 *   twice. Tabs are serialized with the Web Locks API. A browser without it
 *   runs tabs side by side: ledger writes merge, the library is listed again
 *   right before each course is placed, and fresh ids are derived from a salt
 *   the tabs share, so a second tab finds the first tab's copy instead of
 *   making another.
 * - Once per browser. The data belongs to whoever used this browser before
 *   the upgrade, so the first owner the import runs for claims it and any
 *   other owner gets nothing, unless the claiming owner was claimed into it
 *   (retired into an account), in which case the account continues the
 *   unfinished items. The ledger records the owner only as a SHA-256 digest.
 *
 * Transient failures (network, 5xx, 409, 503 OWNER_BUSY, 401) leave work pending
 * and a later page load retries it with a bounded backoff. Permanent ones are
 * recorded per item with the reason. See ./README.md for the full table.
 */
import { getDocumentStore } from '@/lib/document-store';
import { hasLegacyBrowserStorage } from '@/lib/legacy-browser-storage';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { assetRefExists } from '@/lib/media/use-asset-url';
import {
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
  DRAFT_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
} from '@/lib/quiz/persistence';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import {
  createFolder,
  LIBRARY_CHANGED_EVENT,
  listFolders,
  listStages,
  setStageFolder,
} from '@/lib/utils/stage-storage';

import {
  createKv,
  importLegacyCourse,
  legacySceneIds,
  type CourseImportContext,
  type OwnedStage,
} from './course';
import { copyAutoVoiceCache } from './device-rows';
import { classifyFailure, ImportRunStop } from './errors';
import { importFolders, legacyMembership, type FolderApi } from './folders';
import { sha256Hex } from './digest';
import {
  backoffMs,
  ensureLedger,
  ledgerIsSettled,
  loadLedger,
  saveLedger,
  type ImportLedger,
} from './ledger';
import {
  legacyMediaCourseIndex,
  legacySpeechHolders,
  listLegacyCourseIds,
  openLegacySources,
} from './sources';

/** The prefix of every console line the importer writes. */
export const LOG_PREFIX = '[legacy-browser-import]';

/** The Web Lock that serializes runs across tabs of one browser profile. */
export const IMPORT_LOCK_NAME = 'openmaic:legacy-browser-import';

export interface LegacyImportOptions {
  /** localStorage by default. Holds the ledger and reads the legacy keys. */
  storage?: Storage;
  /** `navigator.locks` by default; `null` runs without cross-tab locking. */
  locks?: LockManager | null;
  now?: () => number;
  /** The server-resolved owner id (it is the runtime learner key). */
  ownerId?: () => Promise<string>;
  /** This owner's library (`GET /api/stages`). */
  listOwnedStages?: () => Promise<OwnedStage[]>;
  folders?: FolderApi;
  /** Whether the server's asset pool serves this id. */
  assetExists?: (ref: string) => Promise<boolean>;
  log?: (message: string, ...details: unknown[]) => void;
}

export type LegacyImportStatus =
  /** No pre-server database in this browser. */
  | 'no-legacy-data'
  /** Server persistence could not be reached; a later load tries again. */
  | 'unavailable'
  /** This browser's import finished on an earlier load. */
  | 'already-complete'
  /** Backing off after a failed run. */
  | 'deferred'
  /** Another tab holds the import lock. */
  | 'busy-elsewhere'
  /** Everything is imported (or settled as skipped / failed). */
  | 'complete'
  /** Some items are pending; a later load continues. */
  | 'pending'
  /** The owner refused writes or asked to wait; see the ledger's reason. */
  | 'stopped'
  /** Another owner claimed this browser's legacy data; nothing is imported. */
  | 'claimed-by-another-owner';

export interface LegacyImportOutcome {
  status: LegacyImportStatus;
  ownerId?: string;
  ledger?: ImportLedger;
}

function defaultLog(message: string, ...details: unknown[]): void {
  console.warn(`${LOG_PREFIX} ${message}`, ...details);
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const defaultFolders: FolderApi = {
  list: listFolders,
  create: createFolder,
  setMembership: (stageId, folderId) => setStageFolder(stageId, folderId),
};

/** Scene ids the pre-runtime quiz keys name. */
function quizKeySceneIds(storage: Storage): Set<string> {
  const prefixes = [
    DRAFT_KEY_PREFIX,
    ANSWERS_KEY_PREFIX,
    RESULTS_KEY_PREFIX,
    ATTEMPT_ID_KEY_PREFIX,
  ];
  const scenes = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const prefix = key && prefixes.find((candidate) => key.startsWith(candidate));
    if (key && prefix) scenes.add(key.slice(prefix.length));
  }
  return scenes;
}

async function withImportLock<T>(
  locks: LockManager | null | undefined,
  work: () => Promise<T>,
): Promise<T | 'busy-elsewhere'> {
  if (!locks) return work();
  return locks.request(IMPORT_LOCK_NAME, { ifAvailable: true }, async (lock) =>
    lock ? work() : ('busy-elsewhere' as const),
  );
}

/** Whether the claiming owner has written anything to the server yet. */
function claimHasWritten(ledger: ImportLedger): boolean {
  return (
    Object.values(ledger.courses).some((entry) => entry.steps.document === 'done') ||
    Object.values(ledger.folders).some((entry) => entry.serverId !== undefined)
  );
}

/** Courses or folders the importer created that the current owner now holds. */
async function holdsImportedWork(
  ledger: ImportLedger,
  owned: ReadonlyMap<string, unknown>,
  listFolderIds: () => Promise<Set<string>>,
): Promise<boolean> {
  const course = Object.values(ledger.courses).some(
    (entry) =>
      entry.origin === 'created' &&
      entry.target !== undefined &&
      entry.steps.document === 'done' &&
      owned.has(entry.target),
  );
  if (course) return true;
  const folderIds = Object.values(ledger.folders)
    .map((entry) => entry.serverId)
    .filter((id): id is string => id !== undefined);
  if (folderIds.length === 0) return false;
  const held = await listFolderIds();
  return folderIds.some((id) => held.has(id));
}

/**
 * Whose import this is. The first owner claims the browser's legacy data. A
 * different owner takes over only when the claiming owner is gone into it:
 * observed retired (403 OWNER_RETIRED), or the current owner holds what the
 * importer created (a claim moves an anonymous owner's courses and folders
 * into the account), or the claiming owner never wrote anything.
 */
async function decideOwnership(
  ledger: ImportLedger,
  digest: string,
  owned: ReadonlyMap<string, unknown>,
  listFolderIds: () => Promise<Set<string>>,
): Promise<'mine' | 'taken-over' | 'other-owner'> {
  if (ledger.ownerDigest === undefined) {
    ledger.ownerDigest = digest;
    return 'mine';
  }
  if (ledger.ownerDigest === digest) return 'mine';
  if (
    ledger.ownerRetired ||
    !claimHasWritten(ledger) ||
    (await holdsImportedWork(ledger, owned, listFolderIds))
  ) {
    ledger.ownerDigest = digest;
    delete ledger.ownerRetired;
    return 'taken-over';
  }
  return 'other-owner';
}

async function runLocked(
  ownerId: string,
  storage: Storage,
  options: LegacyImportOptions,
): Promise<LegacyImportOutcome> {
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  // Re-read inside the lock: another tab may have finished meanwhile.
  const ledger = ensureLedger(storage);
  if (ledger.completedAt) return { status: 'already-complete', ownerId, ledger };
  const checkpoint = () => saveLedger(storage, ledger);
  const listOwned = options.listOwnedStages ?? listStages;

  const sources = await openLegacySources(storage);
  let context: CourseImportContext | undefined;
  let stopped: ImportRunStop | undefined;
  try {
    const owned = new Map<string, OwnedStage>();
    const refreshOwned = async () => {
      const listed = await listOwned();
      owned.clear();
      for (const stage of listed) {
        owned.set(stage.id, {
          id: stage.id,
          ...(stage.folderId ? { folderId: stage.folderId } : {}),
        });
      }
    };
    await refreshOwned();

    const folders = options.folders ?? defaultFolders;
    const ownership = await decideOwnership(ledger, sha256Hex(ownerId), owned, async () => {
      return new Set((await folders.list()).map((folder) => folder.id));
    });
    if (ownership === 'other-owner') {
      // This browser's legacy data was claimed by another owner. Nothing is
      // imported for this one, and the ledger is left for the claiming owner.
      return { status: 'claimed-by-another-owner', ownerId, ledger };
    }
    if (ownership === 'taken-over') {
      log('The owner that started this import was claimed into this one; continuing for it');
    }
    checkpoint();

    const legacyIds = await listLegacyCourseIds(sources);

    const quizKeyScenes = quizKeySceneIds(storage);
    const quizScenes = new Map<string, Set<string>>();
    if (quizKeyScenes.size > 0) {
      for (const legacyStageId of legacyIds) {
        for (const sceneId of await legacySceneIds(sources, legacyStageId)) {
          if (!quizKeyScenes.has(sceneId)) continue;
          const holders = quizScenes.get(sceneId) ?? new Set<string>();
          holders.add(legacyStageId);
          quizScenes.set(sceneId, holders);
        }
      }
    }
    let speechHolders: Promise<Map<string, Set<string>>> | undefined;

    context = {
      ownerId,
      storage,
      kv: createKv(storage),
      sources,
      documents: getDocumentStore(),
      runtime: getRuntimeStore(),
      initiallyOwned: new Set(owned.keys()),
      owned,
      refreshOwned,
      speechHolders: () => (speechHolders ??= legacySpeechHolders(sources, legacyIds)),
      folders,
      membership: await legacyMembership(),
      quizScenes,
      ledger,
      checkpoint,
      assetExists:
        options.assetExists ??
        // A reference the pool never issued is not asked about (see mayNameAPoolAsset).
        (async (ref) => mayNameAPoolAsset(ref) && assetRefExists(ref)),
      log,
      libraryChanged: false,
    };

    const folderRun = await importFolders(ledger, folders, checkpoint);
    if (folderRun.created > 0) context.libraryChanged = true;

    for (const legacyStageId of legacyIds) await importLegacyCourse(context, legacyStageId);

    // Server courses from earlier opt-in server builds whose media bytes are
    // still only in the old tables. Rows from before the course column name
    // no course, so with any of those every owned course is looked at.
    const legacySet = new Set(legacyIds);
    const index = await legacyMediaCourseIndex();
    const candidates = index.hasUnscopedNarration ? [...owned.keys()] : [...index.stageIds];
    for (const stageId of candidates.sort()) {
      if (legacySet.has(stageId) || !owned.has(stageId)) continue;
      await importLegacyCourse(context, stageId, { target: stageId, origin: 'existing' });
    }

    if (!ledger.autoVoiceCache) {
      await copyAutoVoiceCache();
      ledger.autoVoiceCache = 'done';
      checkpoint();
    }
  } catch (error) {
    if (error instanceof ImportRunStop) {
      stopped = error;
    } else {
      // Listing the library or opening a store failed: nothing is known to be
      // wrong with any item, so the whole run is retried later.
      log('Import run failed; retrying on a later load:', error);
      ledger.failedRuns += 1;
      ledger.nextRunAt = now() + backoffMs(ledger.failedRuns);
      trySave(storage, ledger, log);
      return { status: 'pending', ownerId, ledger };
    }
  } finally {
    await sources.close();
    if (context?.libraryChanged) announceLibraryChange();
  }

  if (stopped) {
    const { failure } = stopped;
    if (failure.kind === 'retired') {
      // This owner was claimed into an account. The owner that loads next
      // (the account) takes over what is unfinished.
      ledger.ownerRetired = true;
      ledger.nextRunAt = now() + 1_000;
      log(`Paused: this owner was retired (${failure.reason}); the next owner continues`);
    } else if (failure.kind === 'unauthorized') {
      // A credential expired or the access gate closed: the same owner can
      // come back, so this is a pause with backoff, never an end.
      ledger.failedRuns += 1;
      ledger.nextRunAt = now() + backoffMs(ledger.failedRuns);
      log(`Paused: the server refused the credential (${failure.reason}); retrying later`);
    } else {
      ledger.nextRunAt = now() + Math.max(failure.retryAfterMs ?? 0, 1_000);
      log(`Paused: ${failure.reason}; retrying on a later load`);
    }
    trySave(storage, ledger, log);
    return { status: 'stopped', ownerId, ledger };
  }

  if (ledgerIsSettled(ledger)) {
    ledger.completedAt = now();
    ledger.failedRuns = 0;
    delete ledger.nextRunAt;
    trySave(storage, ledger, log);
    return { status: 'complete', ownerId, ledger };
  }
  ledger.failedRuns += 1;
  ledger.nextRunAt = now() + backoffMs(ledger.failedRuns);
  trySave(storage, ledger, log);
  return { status: 'pending', ownerId, ledger };
}

/** Tell an open library to list again. */
function announceLibraryChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
    }
  } catch {
    // Best-effort: the library lists the courses on its next load anyway.
  }
}

function trySave(
  storage: Storage,
  ledger: ImportLedger,
  log: (message: string, ...details: unknown[]) => void,
): void {
  try {
    saveLedger(storage, ledger);
  } catch (error) {
    log('Could not save the import ledger:', error);
  }
}

/**
 * Run the import once. Never throws: every failure is logged and left for a
 * later load.
 */
export async function runLegacyBrowserImport(
  options: LegacyImportOptions = {},
): Promise<LegacyImportOutcome> {
  const log = options.log ?? defaultLog;
  try {
    const storage = options.storage ?? defaultStorage();
    if (!storage) return { status: 'unavailable' };
    if (!(await hasLegacyBrowserStorage())) return { status: 'no-legacy-data' };

    // Cheap exits first: a finished or backing-off import asks the server nothing.
    const now = options.now ?? Date.now;
    const early = loadLedger(storage);
    if (early?.completedAt) return { status: 'already-complete', ledger: early };
    if (early?.nextRunAt !== undefined && early.nextRunAt > now()) {
      return { status: 'deferred', ledger: early };
    }

    let ownerId: string;
    try {
      ownerId = await (options.ownerId ?? (() => getLearnerKey()))();
    } catch (error) {
      log('Server persistence is unavailable; retrying on a later load:', error);
      return { status: 'unavailable' };
    }

    const locks =
      options.locks === undefined
        ? typeof navigator !== 'undefined'
          ? navigator.locks
          : undefined
        : options.locks;
    const outcome = await withImportLock(locks, () => runLocked(ownerId, storage, options));
    return outcome === 'busy-elsewhere' ? { status: 'busy-elsewhere', ownerId } : outcome;
  } catch (error) {
    // Defensive: nothing above should throw, but an importer bug must never
    // surface in the app.
    log('Import run failed:', classifyFailure(error).reason, error);
    return { status: 'unavailable' };
  }
}

let scheduled = false;

/**
 * Start the import once per page, after the page has loaded and the browser
 * is idle. Called from the client persistence bootstrap.
 */
export function scheduleLegacyBrowserImport(): void {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  const start = () => {
    void runLegacyBrowserImport();
  };
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(start, { timeout: 10_000 });
    } else {
      window.setTimeout(start, 2_000);
    }
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}
