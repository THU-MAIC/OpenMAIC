/**
 * The importer's completion ledger: what has already moved to the server, per
 * server owner.
 *
 * One ledger per owner id, in localStorage under
 * `maic:legacy-import:v1:<ownerId>`. Keying by the owner the server resolves
 * means a different owner in the same browser (a new anonymous cookie, a
 * signed-in account) starts from an empty ledger and re-evaluates everything,
 * while the owner that already imported never repeats work. Clear Local Cache
 * keeps these keys (`LEGACY_IMPORT_LEDGER_PREFIX`), so clearing the cache does
 * not bring back a course the user deleted after it was imported.
 *
 * Every step is recorded as soon as it lands, so a reload or crash mid-import
 * resumes at the first unfinished step. The server is still the authority for
 * what exists: a step whose ledger write was lost is re-checked against it
 * (see `course.ts`), never blindly repeated.
 */
import { LEGACY_IMPORT_LEDGER_PREFIX } from '@/lib/device-storage/clear-local-cache';

export const LEDGER_VERSION = 1;

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
  ownerId: string;
  /** Runs that ended with work still pending, for the backoff. */
  failedRuns: number;
  /** Earliest time (epoch ms) the next run may start. */
  nextRunAt?: number;
  /** Set once nothing is pending: later loads skip the importer entirely. */
  completedAt?: number;
  /** Set when the owner itself refused writes (retired or invalid credential). */
  stoppedReason?: string;
  courses: Record<string, CourseEntry>;
  folders: Record<string, FolderEntry>;
  /** The auto-voice reference clips were copied into the device cache. */
  autoVoiceCache?: 'done';
}

export function ledgerKey(ownerId: string): string {
  return `${LEGACY_IMPORT_LEDGER_PREFIX}v${LEDGER_VERSION}:${ownerId}`;
}

export function emptyLedger(ownerId: string): ImportLedger {
  return { version: LEDGER_VERSION, ownerId, failedRuns: 0, courses: {}, folders: {} };
}

function isLedger(value: unknown, ownerId: string): value is ImportLedger {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ImportLedger>;
  return (
    candidate.version === LEDGER_VERSION &&
    candidate.ownerId === ownerId &&
    typeof candidate.courses === 'object' &&
    candidate.courses !== null &&
    typeof candidate.folders === 'object' &&
    candidate.folders !== null
  );
}

/** The owner's ledger, or an empty one when none is stored or it is unreadable. */
export function loadLedger(storage: Storage, ownerId: string): ImportLedger {
  let raw: string | null;
  try {
    raw = storage.getItem(ledgerKey(ownerId));
  } catch {
    return emptyLedger(ownerId);
  }
  if (raw === null) return emptyLedger(ownerId);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isLedger(parsed, ownerId)) {
      parsed.failedRuns = Number.isInteger(parsed.failedRuns) ? parsed.failedRuns : 0;
      return parsed;
    }
  } catch {
    // Unreadable: start over. The server-side checks keep a restart from
    // duplicating anything that already moved.
  }
  return emptyLedger(ownerId);
}

/** Persist the ledger. A full or unavailable storage throws; the caller treats it as transient. */
export function saveLedger(storage: Storage, ledger: ImportLedger): void {
  storage.setItem(ledgerKey(ledger.ownerId), JSON.stringify(ledger));
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
