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
 *   goes to the server (through its own fenced clients, `./server.ts`, never
 *   the app's persistence seams), to the device cache, to device-scoped
 *   positions (playback, editor scene), and to its own ledger.
 * - Silent. No UI: a course simply appears in the library once it is on the
 *   server. Problems are reported with `console.warn` under a stable prefix.
 * - Off the critical path. It starts after the page has loaded and the
 *   browser is idle, and never blocks rendering.
 * - Idempotent and resumable. One ledger for the browser (`./ledger.ts`)
 *   records every step; a crash or reload resumes, and nothing is imported
 *   twice. Tabs are serialized with the Web Locks API; a browser without it
 *   runs tabs side by side, ledger writes merge, and the library is listed
 *   again right before each course is placed.
 * - Once per browser, decided by the server. The ledger holds a random
 *   browser id and no owner information. The server binds that id to the
 *   first owner that asks (one atomic insert), and refuses every importer
 *   request (`X-OpenMAIC-Legacy-Import`) from any other owner with
 *   `409 LEGACY_IMPORT_NOT_BOUND`, so the data can only ever reach the owner
 *   holding the binding -- whatever this page believes the owner is. A claim
 *   carries the binding to the account (`lib/persistence/legacy-import-bindings.ts`).
 *
 * Transient failures (network, 5xx, 409, 503 OWNER_BUSY, 401) leave work pending
 * and a later page load retries it with a bounded backoff. Permanent ones are
 * recorded per item with the reason. See ./README.md for the full table.
 */
import { hasLegacyBrowserStorage } from '@/lib/legacy-browser-storage';
import {
  ANSWERS_KEY_PREFIX,
  ATTEMPT_ID_KEY_PREFIX,
  DRAFT_KEY_PREFIX,
  RESULTS_KEY_PREFIX,
} from '@/lib/quiz/persistence';
import { LIBRARY_CHANGED_EVENT } from '@/lib/utils/stage-storage';

import {
  createKv,
  importLegacyCourse,
  legacySceneIds,
  forgetRecoveredReadFailures,
  readWithBudget,
  type CourseImportContext,
  type OwnedStage,
} from './course';
import { copyAutoVoiceCache } from './device-rows';
import { asRunStop, classifyFailure, ImportRunStop } from './errors';
import { importFolders, legacyMembership, type FolderApi } from './folders';
import {
  backoffMs,
  ensureLedger,
  ledgerIsSettled,
  loadLedger,
  MAX_BACKOFF_MS,
  saveLedger,
  stillWaiting,
  type ImportLedger,
} from './ledger';
import { connectImportServer, type ImportClients } from './server';
import {
  legacyMediaCourseIndex,
  legacySpeechHolders,
  listLegacyCourseIds,
  openLegacySources,
  type LegacySources,
  type SpeechHolders,
} from './sources';

/** The prefix of every console line the importer writes. */
export const LOG_PREFIX = '[legacy-browser-import]';

/** The Web Lock that serializes runs across tabs of one browser profile. */
export const IMPORT_LOCK_NAME = 'openmaic:legacy-browser-import';

/**
 * How long a browser whose legacy data another owner holds waits before it
 * asks the server again (a claim may have moved the binding to this owner).
 */
export const OTHER_OWNER_RECHECK_MS = 10 * 60 * 1000;

export interface LegacyImportOptions {
  /** localStorage by default. Holds the ledger and reads the legacy keys. */
  storage?: Storage;
  /** `navigator.locks` by default; `null` runs without cross-tab locking. */
  locks?: LockManager | null;
  now?: () => number;
  /** The fenced server clients for a browser id (`./server.ts` by default). */
  connect?: (browserId: string) => ImportClients;
  /** Overrides of single clients, for tests. */
  listOwnedStages?: () => Promise<OwnedStage[]>;
  folders?: FolderApi;
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
  /** The server bound this browser to another owner; nothing is imported. */
  | 'claimed-by-another-owner';

export interface LegacyImportOutcome {
  status: LegacyImportStatus;
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

async function runLocked(
  storage: Storage,
  options: LegacyImportOptions,
): Promise<LegacyImportOutcome> {
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  // Re-read inside the lock: another tab may have finished meanwhile.
  const ledger = ensureLedger(storage);
  if (ledger.completedAt) return { status: 'already-complete', ledger };
  const checkpoint = () => saveLedger(storage, ledger);
  const connected = (options.connect ?? connectImportServer)(ledger.browserId);
  const clients: ImportClients = {
    ...connected,
    ...(options.listOwnedStages ? { listOwnedStages: options.listOwnedStages } : {}),
    ...(options.folders ? { folders: options.folders } : {}),
  };

  // Opened only once the server bound the browser to this owner: a browser
  // whose data another owner holds never opens (or upgrades) the old databases.
  let sources: LegacySources | undefined;
  let context: CourseImportContext | undefined;
  let stopped: ImportRunStop | undefined;
  try {
    // The server decides whose this browser's data is. Nothing is read from
    // the server, and nothing written, before it bound the browser to the
    // requesting owner; every request after this one is refused unless that
    // owner still holds it.
    if (!(await clients.bind())) {
      // Ask again only after a while: a claim that moves the binding to this
      // owner is picked up then, and a browser another owner holds does not
      // send a write on every page load.
      ledger.nextRunAt = now() + OTHER_OWNER_RECHECK_MS;
      trySave(storage, ledger, log);
      log("Another owner holds this browser's legacy data; nothing is imported for this one");
      return { status: 'claimed-by-another-owner', ledger };
    }
    sources = await openLegacySources(storage);
    const opened = sources;
    // Asked now, fenced, and never taken from the page's memo: the runtime
    // key of the owner this run writes for.
    const learnerKey = await clients.learnerKey();

    const owned = new Map<string, OwnedStage>();
    const refreshOwned = async () => {
      const listed = await clients.listOwnedStages();
      owned.clear();
      for (const stage of listed) {
        owned.set(stage.id, {
          id: stage.id,
          ...(stage.folderId ? { folderId: stage.folderId } : {}),
        });
      }
    };
    await refreshOwned();

    const runTime = now();
    const readFailedThisRun = new Set<string>();
    const legacyIds = await listLegacyCourseIds(opened);

    context = {
      learnerKey,
      storage,
      kv: createKv(storage),
      sources: opened,
      clients,
      documents: clients.documents,
      runtime: clients.runtime,
      initiallyOwned: new Set(owned.keys()),
      owned,
      refreshOwned,
      speechHolders: async () => ({ holders: new Map(), unindexed: new Set() }),
      folders: clients.folders,
      membership: await legacyMembership(),
      quizKeyScenes: quizKeySceneIds(storage),
      quizScenes: new Map(),
      quizUnindexed: new Set(),
      ledger,
      checkpoint,
      now: runTime,
      readFailedThisRun,
      readSucceededThisRun: new Set(),
      assetExists: (ref) => clients.assetExists(ref),
      log,
      libraryChanged: false,
    };
    const run = context;

    // Which legacy courses name each scene that has pre-runtime quiz keys. A
    // course whose storage cannot be read right now is left out of the index
    // and recorded as unindexed: it holds up only the quiz decisions it could
    // affect, never the rest of the import.
    if (run.quizKeyScenes.size > 0) {
      for (const legacyStageId of legacyIds) {
        const sceneIds = await readWithBudget(run, legacyStageId, (settle) =>
          legacySceneIds(opened, legacyStageId, settle),
        );
        if (sceneIds === undefined) {
          run.quizUnindexed.add(legacyStageId);
          continue;
        }
        for (const sceneId of sceneIds) {
          if (!run.quizKeyScenes.has(sceneId)) continue;
          const holders = run.quizScenes.get(sceneId) ?? new Set<string>();
          holders.add(legacyStageId);
          run.quizScenes.set(sceneId, holders);
        }
      }
    }
    let speechHolders: Promise<SpeechHolders> | undefined;
    run.speechHolders = () =>
      (speechHolders ??= legacySpeechHolders(opened, legacyIds, (id, read) =>
        readWithBudget(run, id, read),
      ));

    const folderRun = await importFolders(ledger, clients.folders, checkpoint);
    if (folderRun.created > 0) run.libraryChanged = true;

    for (const legacyStageId of legacyIds) await importLegacyCourse(run, legacyStageId);

    // Server courses from earlier opt-in server builds whose media bytes are
    // still only in the old tables. Rows from before the course column name
    // no course, so with any of those every owned course is looked at.
    const legacySet = new Set(legacyIds);
    const index = await legacyMediaCourseIndex();
    const candidates = index.hasUnscopedNarration ? [...owned.keys()] : [...index.stageIds];
    for (const stageId of candidates.sort()) {
      if (legacySet.has(stageId) || !owned.has(stageId)) continue;
      await importLegacyCourse(run, stageId, { target: stageId, origin: 'existing' });
    }

    forgetRecoveredReadFailures(run);

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
      // Binding, listing the library or opening a store failed: nothing is
      // known to be wrong with any item, so the whole run is retried later.
      if (classifyFailure(error).code === 'OWNER_NOT_ESTABLISHED') {
        // The bind itself was the request that created the owner: the server
        // binds only an owner the browser already presents.
        log('Not started: the owner is not established yet; retrying on a later load');
      } else {
        log('Import run failed; retrying on a later load:', error);
      }
      ledger.failedRuns += 1;
      ledger.nextRunAt = now() + backoffMs(ledger.failedRuns);
      trySave(storage, ledger, log);
      return { status: 'pending', ledger };
    }
  } finally {
    await sources?.close();
    if (context?.libraryChanged) announceLibraryChange();
  }

  if (stopped) {
    const { failure } = stopped;
    if (failure.kind === 'unauthorized') {
      // A credential expired or the access gate closed: the same owner can
      // come back, so this is a pause with backoff, never an end.
      ledger.failedRuns += 1;
      ledger.nextRunAt = now() + backoffMs(ledger.failedRuns);
      log(`Paused: the server refused the credential (${failure.reason}); retrying later`);
    } else if (failure.kind === 'not-bound') {
      // Every request that can answer this follows this run's own successful
      // bind, so the owner the page's requests resolve to changed during the
      // run (its owner cookie was replaced). Nothing is marked complete: items
      // stay pending, and a later load asks for the binding again.
      ledger.nextRunAt = now() + 1_000;
      log(
        'Stopped: the owner changed during this run (the server bound this browser, then ' +
          'refused a later request as another owner, so the owner cookie was replaced). ' +
          'Items stay pending; a later load asks for the binding again',
      );
    } else {
      // Retired (the account continues once the claim carried the binding),
      // busy, or the learner changed: pending, and a later load resumes.
      ledger.nextRunAt = now() + Math.max(failure.retryAfterMs ?? 0, 1_000);
      log(`Paused: ${failure.reason}; retrying on a later load`);
    }
    trySave(storage, ledger, log);
    return { status: 'stopped', ledger };
  }

  if (ledgerIsSettled(ledger)) {
    ledger.completedAt = now();
    ledger.failedRuns = 0;
    delete ledger.nextRunAt;
    trySave(storage, ledger, log);
    return { status: 'complete', ledger };
  }
  ledger.failedRuns += 1;
  ledger.nextRunAt = now() + backoffMs(ledger.failedRuns);
  trySave(storage, ledger, log);
  return { status: 'pending', ledger };
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
    if (stillWaiting(early?.nextRunAt, now(), MAX_BACKOFF_MS)) {
      return { status: 'deferred', ledger: early };
    }

    const locks =
      options.locks === undefined
        ? typeof navigator !== 'undefined'
          ? navigator.locks
          : undefined
        : options.locks;
    const outcome = await withImportLock(locks, () => runLocked(storage, options));
    return outcome === 'busy-elsewhere' ? { status: 'busy-elsewhere' } : outcome;
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
