/**
 * The importer's completion ledger: what has already moved to the server from
 * this browser.
 *
 * Once per browser, not once per owner, and the server decides whose: the
 * ledger holds a random browser id (128 bits), and the server binds that id
 * to the first owner that asks (`lib/persistence/legacy-import-bindings.ts`).
 * A claim carries the binding to the account. The ledger itself holds no
 * owner information at all.
 *
 * One key, `maic:legacy-import:v3`, in localStorage. The browser id also
 * derives fresh course ids (`ids.ts`). Clear Local Cache keeps the ledger
 * (and, until the import is complete, the pre-runtime quiz keys), so clearing the cache neither loses import
 * state nor brings back a course the user deleted after it was imported.
 *
 * Every step is recorded as soon as it lands, so a reload or crash mid-import
 * resumes at the first unfinished step. Writes merge with what is stored, so
 * two tabs running without Web Locks do not erase each other's progress. The
 * server is still the authority for what exists: a step whose ledger write was
 * lost is re-checked against it (see `course.ts`), never blindly repeated.
 */
import { randomBrowserId } from './digest';

export const LEDGER_VERSION = 3;

/** Terminal states never run again for this owner; `pending` resumes on a later load. */
export type ItemStatus = 'pending' | 'done' | 'failed' | 'skipped';

/** How a legacy course relates to the server copy the importer settled on. */
export type CourseOrigin =
  /** The importer created the server copy (under the legacy id or a fresh one). */
  | 'created'
  /** The server already had the course for this owner; it stays authoritative. */
  | 'existing';

/** The steps of one course, in order. */
export type CourseStep =
  | 'document'
  | 'media'
  | 'runtime'
  | 'chat'
  | 'playback'
  | 'quiz'
  | 'folder'
  | 'deviceRows';

export interface CourseEntry {
  status: ItemStatus;
  /** Why the course is `failed` or `skipped`, or why media is still pending. */
  reason?: string;
  /** The server id the course lives under (the legacy id, or a fresh one). */
  target?: string;
  origin?: CourseOrigin;
  steps: Partial<Record<CourseStep, 'done'>>;
  /**
   * Runtime sessions the importer is creating, legacy id -> server id,
   * recorded BEFORE the create is sent: a session that exists on the server
   * and is listed here is the importer's own (resumed by record count), one
   * that is not was written by the app and is left alone.
   */
  sessions?: Record<string, string>;
  /** Sessions fully copied (records and final status). */
  sessionsDone?: string[];
  /** Things that did not come across but do not keep the course pending. */
  notes?: string[];
  /**
   * Runs in which reading this course from the old browser storage failed
   * (not an unusable record: the storage itself), and when the first did.
   * After enough runs over enough time the course settles on what can be read
   * (`READ_FAILURE_BUDGET`), so one broken record cannot hold the import open.
   */
  readFailures?: { count: number; since: number };
  /** Per-reference media outcomes that are not simply "converted". */
  media?: Record<string, { status: 'pending' | 'failed'; reason: string }>;
}

export interface FolderEntry {
  status: ItemStatus;
  serverId?: string;
  reason?: string;
}

export interface ImportLedger {
  version: typeof LEDGER_VERSION;
  /**
   * Random, 128 bits, lowercase hex: this browser's id. The server binds it to
   * an owner; fresh course ids are derived from it.
   */
  browserId: string;
  /** Runs that ended with work still pending, for the backoff. */
  failedRuns: number;
  /** Earliest time (epoch ms) the next run may start. */
  nextRunAt?: number;
  /** Set once nothing is pending: later loads skip the importer entirely. */
  completedAt?: number;
  courses: Record<string, CourseEntry>;
  folders: Record<string, FolderEntry>;
  /** The auto-voice reference clips were copied into the device cache. */
  autoVoiceCache?: 'done';
  /**
   * The custom agents of the old agent registry (`agent-registry-storage`)
   * reached the server (`./agents-import.ts`). Tracked apart from the courses:
   * it neither holds up nor waits for {@link ImportLedger.completedAt}.
   */
  agents?: 'done';
}

/** A course whose storage reads failed this often, over this long, settles. */
export const READ_FAILURE_BUDGET = { runs: 5, spanMs: 24 * 60 * 60 * 1000 } as const;

/**
 * The ledger's localStorage key. Clear Local Cache keeps it
 * (`lib/device-storage/clear-local-cache.ts`): without it, a course the user
 * deleted on the server after it was imported could be imported again from
 * the untouched browser copy.
 */
export const LEDGER_KEY = 'maic:legacy-import:v3';

function newLedger(): ImportLedger {
  return {
    version: LEDGER_VERSION,
    browserId: randomBrowserId(),
    failedRuns: 0,
    courses: {},
    folders: {},
  };
}

function isLedger(value: unknown): value is ImportLedger {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ImportLedger>;
  return (
    candidate.version === LEDGER_VERSION &&
    typeof candidate.browserId === 'string' &&
    /^[0-9a-f]{32}$/.test(candidate.browserId) &&
    typeof candidate.courses === 'object' &&
    candidate.courses !== null &&
    typeof candidate.folders === 'object' &&
    candidate.folders !== null
  );
}

/** The stored ledger, or undefined when none is stored or it is unreadable. */
export function loadLedger(storage: Storage): ImportLedger | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(LEDGER_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isLedger(parsed)) {
      parsed.failedRuns = Number.isInteger(parsed.failedRuns) ? parsed.failedRuns : 0;
      return parsed;
    }
  } catch {
    // Unreadable: start over. The server-side checks keep a restart from
    // duplicating anything that already moved.
  }
  return undefined;
}

/**
 * The stored ledger, creating it when there is none. Written and then read
 * back, so two tabs starting at once settle on the same browser id (and if
 * two do not, the server binds each id on its own; the one bound to the
 * other owner is refused).
 */
export function ensureLedger(storage: Storage): ImportLedger {
  const existing = loadLedger(storage);
  if (existing) return existing;
  storage.setItem(LEDGER_KEY, JSON.stringify(newLedger()));
  const settled = loadLedger(storage);
  if (!settled) throw new Error('The import ledger could not be stored');
  return settled;
}

function progress(entry: { status: ItemStatus; steps?: object }): number {
  if (entry.status !== 'pending') return 1_000;
  return Object.keys(entry.steps ?? {}).length;
}

/**
 * Fold what another tab stored into `ledger`, in place: an item keeps
 * whichever copy got further, and runtime-session intents are unioned (an
 * intent dropped here would make a half-copied session look like the app's).
 * Completion is kept if either copy has it.
 */
export function mergeStoredLedger(ledger: ImportLedger, stored: ImportLedger | undefined): void {
  if (!stored || stored.browserId !== ledger.browserId) return;
  ledger.completedAt ??= stored.completedAt;
  for (const [id, theirs] of Object.entries(stored.courses)) {
    const ours = ledger.courses[id];
    if (!ours) {
      ledger.courses[id] = theirs;
      continue;
    }
    const sessions = { ...theirs.sessions, ...ours.sessions };
    const sessionsDone = [
      ...new Set([...(ours.sessionsDone ?? []), ...(theirs.sessionsDone ?? [])]),
    ];
    // In place: a course import in flight holds this object.
    if (progress(theirs) > progress(ours)) Object.assign(ours, theirs);
    if (Object.keys(sessions).length > 0) ours.sessions = sessions;
    if (sessionsDone.length > 0) ours.sessionsDone = sessionsDone;
  }
  for (const [id, theirs] of Object.entries(stored.folders)) {
    const ours = ledger.folders[id];
    if (!ours) ledger.folders[id] = theirs;
    else if (progress(theirs) > progress(ours)) Object.assign(ours, theirs);
  }
  ledger.autoVoiceCache ??= stored.autoVoiceCache;
  ledger.agents ??= stored.agents;
}

/** Persist the ledger, merged with the stored copy. A full storage throws (transient). */
export function saveLedger(storage: Storage, ledger: ImportLedger): void {
  mergeStoredLedger(ledger, loadLedger(storage));
  storage.setItem(LEDGER_KEY, JSON.stringify(ledger));
}

export function courseEntry(ledger: ImportLedger, legacyStageId: string): CourseEntry {
  return (ledger.courses[legacyStageId] ??= { status: 'pending', steps: {} });
}

/**
 * Whether this browser's import has finished: the stored ledger records
 * completion. False when there is no ledger (the import has not run yet, or
 * there was nothing to import) or it is unreadable. Clear Local Cache asks
 * this before it deletes legacy localStorage the importer still reads.
 */
export function legacyImportIsComplete(storage: Storage): boolean {
  return typeof loadLedger(storage)?.completedAt === 'number';
}

/** Whether a later run has nothing left to do. */
export function ledgerIsSettled(ledger: ImportLedger): boolean {
  return (
    Object.values(ledger.courses).every((entry) => entry.status !== 'pending') &&
    Object.values(ledger.folders).every((entry) => entry.status !== 'pending')
  );
}

/** The longest backoff between runs. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a stored "not before" time still holds at `now`. A time further
 * ahead than the longest wait the importer ever sets was written by a clock
 * that ran ahead (or was set forward), and counts as passed, so a corrected
 * clock cannot strand the import until that far-off date.
 */
export function stillWaiting(until: number | undefined, now: number, longest: number): boolean {
  return until !== undefined && until > now && until <= now + longest;
}

/** Backoff after a run that left work pending: 30 s, doubling, capped at six hours. */
export function backoffMs(failedRuns: number): number {
  const base = 30_000;
  const cap = MAX_BACKOFF_MS;
  return Math.min(cap, base * 2 ** Math.max(0, failedRuns - 1));
}
