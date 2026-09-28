/**
 * The importer's completion ledger: what has already moved to the server from
 * this browser.
 *
 * Once per browser, not once per owner. The data in the old browser stores
 * belongs to whoever used this browser before the upgrade, so the first owner
 * the server confirms (an authenticated request of the run succeeded) claims
 * it, and any other owner that later loads in the same browser gets nothing
 * imported. It moves to another owner only when the server confirms that this
 * owner absorbed the first one through a claim (`index.ts`).
 *
 * One key, `maic:legacy-import:v2`, in localStorage. It never holds an owner
 * id: the claiming owner is recorded as a salted SHA-256 digest
 * (`ownerDigest` in `digest.ts`), because an anonymous owner id is the
 * anonymous cookie's value, a bearer credential. It also holds the random
 * salt, which fresh course ids are derived from too (`ids.ts`). Clear Local
 * Cache keeps it (`LEGACY_IMPORT_LEDGER_KEY`), so clearing the cache does not
 * bring back a course the user deleted after it was imported.
 *
 * Every step is recorded as soon as it lands, so a reload or crash mid-import
 * resumes at the first unfinished step. Writes merge with what is stored, so
 * two tabs running without Web Locks do not erase each other's progress. The
 * server is still the authority for what exists: a step whose ledger write was
 * lost is re-checked against it (see `course.ts`), never blindly repeated.
 */
import { LEGACY_IMPORT_LEDGER_KEY } from '@/lib/device-storage/clear-local-cache';

import { randomSalt } from './digest';

export const LEDGER_VERSION = 2;

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
  /** Random, per browser: the input fresh course ids are derived from. */
  salt: string;
  /** Salted SHA-256 (hex) of the owner that claimed this browser's legacy data. */
  ownerDigest?: string;
  /**
   * Digests of other owners the server said did not absorb the claiming one,
   * with the time (epoch ms) until which the answer is reused.
   */
  otherOwners?: Record<string, number>;
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
}

export const LEDGER_KEY = LEGACY_IMPORT_LEDGER_KEY;

function newLedger(): ImportLedger {
  return { version: LEDGER_VERSION, salt: randomSalt(), failedRuns: 0, courses: {}, folders: {} };
}

function isLedger(value: unknown): value is ImportLedger {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ImportLedger>;
  return (
    candidate.version === LEDGER_VERSION &&
    typeof candidate.salt === 'string' &&
    candidate.salt !== '' &&
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
 * back, so two tabs starting at once settle on the same salt.
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

/** Ledgers whose owner this tab changed through a confirmed handoff. */
const handoffs = new WeakMap<ImportLedger, string>();

/** Record that `ledger` passed from the owner with digest `from` to its current one. */
export function recordHandoff(ledger: ImportLedger, from: string): void {
  handoffs.set(ledger, from);
}

/**
 * Fold what another tab stored into `ledger`, in place: an item keeps
 * whichever copy got further, and runtime-session intents are unioned (an
 * intent dropped here would make a half-copied session look like the app's).
 * The claiming owner stored first wins unless this tab handed the import over
 * from exactly that owner; completion is kept if either copy has it.
 */
export function mergeStoredLedger(
  ledger: ImportLedger,
  stored: ImportLedger | undefined,
  now?: number,
): void {
  if (!stored || stored.salt !== ledger.salt) return;
  if (stored.ownerDigest !== undefined && stored.ownerDigest !== ledger.ownerDigest) {
    if (handoffs.get(ledger) !== stored.ownerDigest) ledger.ownerDigest = stored.ownerDigest;
  }
  ledger.completedAt ??= stored.completedAt;
  if (stored.otherOwners) {
    ledger.otherOwners = { ...stored.otherOwners, ...ledger.otherOwners };
  }
  if (ledger.otherOwners && now !== undefined) {
    // Expired answers are only noise; drop them so the map does not grow
    // with every owner that ever loaded in a shared browser.
    for (const [digest, until] of Object.entries(ledger.otherOwners)) {
      if (until <= now) delete ledger.otherOwners[digest];
    }
    if (Object.keys(ledger.otherOwners).length === 0) delete ledger.otherOwners;
  }
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
}

/** Persist the ledger, merged with the stored copy. A full storage throws (transient). */
export function saveLedger(storage: Storage, ledger: ImportLedger, now?: number): void {
  mergeStoredLedger(ledger, loadLedger(storage), now);
  storage.setItem(LEDGER_KEY, JSON.stringify(ledger));
}

export function courseEntry(ledger: ImportLedger, legacyStageId: string): CourseEntry {
  return (ledger.courses[legacyStageId] ??= { status: 'pending', steps: {} });
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
