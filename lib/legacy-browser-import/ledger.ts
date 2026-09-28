/**
 * The importer's completion ledger: what has already moved to the server from
 * this browser.
 *
 * Once per browser, not once per owner. The data in the old browser stores
 * belongs to whoever used this browser before the upgrade, so the first owner
 * the importer runs for claims it, and any other owner that later loads in the
 * same browser gets nothing imported. The one exception is a handoff: when the
 * claiming owner is retired (claimed into an account) -- observed as 403
 * OWNER_RETIRED, or inferred because the current owner now holds courses or
 * folders the importer created -- the current owner takes over the unfinished
 * items (see `index.ts`).
 *
 * One key, `maic:legacy-import:v2`, in localStorage. It never holds an owner
 * id: the claiming owner is recorded as a SHA-256 digest, because an anonymous
 * owner id is the anonymous cookie's value, a bearer credential. It also holds
 * the random salt fresh course ids are derived from (`ids.ts`). Clear Local
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
  /** SHA-256 (hex) of the owner id that claimed this browser's legacy data. */
  ownerDigest?: string;
  /** The claiming owner was observed retired; the next owner takes over. */
  ownerRetired?: boolean;
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

/**
 * Fold what another tab stored into `ledger`, in place: an item keeps
 * whichever copy got further, and runtime-session intents are unioned (an
 * intent dropped here would make a half-copied session look like the app's).
 */
export function mergeStoredLedger(ledger: ImportLedger, stored: ImportLedger | undefined): void {
  if (!stored || stored.salt !== ledger.salt) return;
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
export function saveLedger(storage: Storage, ledger: ImportLedger): void {
  mergeStoredLedger(ledger, loadLedger(storage));
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

/** Backoff after a run that left work pending: 30 s, doubling, capped at six hours. */
export function backoffMs(failedRuns: number): number {
  const base = 30_000;
  const cap = 6 * 60 * 60 * 1000;
  return Math.min(cap, base * 2 ** Math.max(0, failedRuns - 1));
}
