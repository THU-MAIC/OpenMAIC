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
 *   the upgrade, so the first owner the server confirms claims it and any
 *   other owner gets nothing. It moves to another owner only when the server
 *   confirms (`GET /api/identity/merged-from`) that this owner absorbed the
 *   first one through a claim. The ledger records owners only as salted
 *   SHA-256 digests.
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
import { asRunStop, classifyFailure, ImportRunStop } from './errors';
import { importFolders, legacyMembership, type FolderApi } from './folders';
import { ownerDigest } from './digest';
import {
  backoffMs,
  ensureLedger,
  ledgerIsSettled,
  loadLedger,
  recordHandoff,
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
  /** Whether the requesting owner absorbed the owner with this salted digest (a claim). */
  mergedFrom?: (salt: string, digest: string) => Promise<boolean>;
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

/** How long a "this owner did not absorb the claiming one" answer is reused. */
const OTHER_OWNER_RECHECK_MS = 60 * 60 * 1000;

/**
 * Whose import this is. The first owner the server confirmed claims the
 * browser's legacy data. A different owner continues it only when the server
 * confirms that this owner absorbed the claiming one through a claim; nothing
 * the browser could observe (a listing, a refusal, an empty ledger) moves it.
 */
async function decideOwnership(
  ledger: ImportLedger,
  digest: string,
  mergedFrom: (salt: string, digest: string) => Promise<boolean>,
  now: number,
): Promise<'mine' | 'taken-over' | 'other-owner'> {
  if (ledger.ownerDigest === undefined) {
    ledger.ownerDigest = digest;
    return 'mine';
  }
  if (ledger.ownerDigest === digest) return 'mine';
  if (await mergedFrom(ledger.salt, ledger.ownerDigest)) {
    recordHandoff(ledger, ledger.ownerDigest);
    ledger.ownerDigest = digest;
    delete ledger.otherOwners;
    return 'taken-over';
  }
  (ledger.otherOwners ??= {})[digest] = now + OTHER_OWNER_RECHECK_MS;
  return 'other-owner';
}

/** `GET /api/identity/merged-from`: did the requesting owner absorb the owner with this digest? */
async function serverMergedFrom(salt: string, digest: string): Promise<boolean> {
  const query = new URLSearchParams({ salt, digest });
  const response = await fetch(`/api/identity/merged-from?${query}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown };
    } | null;
    const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    throw Object.assign(new Error(`merged-from answered ${response.status}`), {
      status: response.status,
      ...(code ? { code } : {}),
    });
  }
  const body = (await response.json()) as { merged?: unknown };
  return body.merged === true;
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
  const digest = ownerDigest(ledger.salt, ownerId);
  const recheckAfter = ledger.otherOwners?.[digest];
  if (ledger.ownerDigest !== undefined && ledger.ownerDigest !== digest) {
    // Answered for this owner recently: do not ask the server on every load.
    if (recheckAfter !== undefined && recheckAfter > now()) {
      return { status: 'claimed-by-another-owner', ownerId, ledger };
    }
  }

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
    // The listing is the run's first authenticated request of its own: only
    // once it succeeded is this owner confirmed, and only then may it claim
    // the browser's legacy data. A run that dies before this binds nothing.
    await refreshOwned();

    const folders = options.folders ?? defaultFolders;
    const ownership = await decideOwnership(
      ledger,
      digest,
      options.mergedFrom ?? serverMergedFrom,
      now(),
    );
    if (ownership === 'other-owner') {
      // This browser's legacy data belongs to another owner, which this one
      // did not absorb. Nothing is imported for it; the ledger stays theirs.
      trySave(storage, ledger, log);
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
    const stop = asRunStop(error);
    if (stop) {
      stopped = stop;
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
      // This owner was claimed into an account. The items stay pending; the
      // account continues them once the server confirms the claim.
      ledger.nextRunAt = now() + 1_000;
      log(`Paused: this owner was retired (${failure.reason}); its account can continue`);
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
