/**
 * Cross-tab edit-mode lock backed by localStorage. Ensures at most one
 * tab in this browser owns "edit mode" for a given course at a time.
 *
 * Protocol:
 *   - Each tab generates a stable `tabId` once and reuses it for the
 *     session.
 *   - On entering edit mode: `tryAcquireEditLock(courseId, tabId)`. If
 *     it returns `false`, another tab is editing and the caller refuses
 *     entry (typically via `MultiTabEditConflictPrompt`).
 *   - While in edit mode: caller refreshes the lock periodically with
 *     `refreshEditLock(courseId, tabId)` (a heartbeat). The default
 *     `LOCK_STALE_MS` is three heartbeat intervals so a crashed tab's
 *     lock self-clears.
 *   - On exiting edit mode (or tab unload): `releaseEditLock(courseId,
 *     tabId)`. Release is a no-op if some other tab now holds it,
 *     preventing a stale release from trampling the new owner.
 *
 * All helpers swallow storage failures so the editor degrades to
 * single-tab-only rather than crashing in private mode / when quota is
 * exceeded.
 */

const KEY_PREFIX = 'maic-editor:edit-lock';
export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_STALE_MS = LOCK_HEARTBEAT_MS * 3;

export interface EditLockState {
  readonly tabId: string;
  readonly timestamp: number;
}

export function editLockKey(courseId: string): string {
  return `${KEY_PREFIX}:${courseId}`;
}

export function readEditLock(courseId: string): EditLockState | null {
  try {
    const raw = localStorage.getItem(editLockKey(courseId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as EditLockState;
    if (typeof parsed?.tabId !== 'string' || typeof parsed?.timestamp !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeEditLock(courseId: string, state: EditLockState): void {
  try {
    localStorage.setItem(editLockKey(courseId), JSON.stringify(state));
  } catch {
    // Quota / disabled — caller falls back to single-tab semantics.
  }
}

export function isEditLockHeldByOther(
  courseId: string,
  ownTabId: string,
  now: number = Date.now(),
): boolean {
  const state = readEditLock(courseId);
  if (state === null) return false;
  if (state.tabId === ownTabId) return false;
  return now - state.timestamp < LOCK_STALE_MS;
}

/**
 * Atomically acquire the edit lock for this course. Returns `false` if
 * another tab is the current fresh owner; in that case the caller must
 * NOT enter edit mode.
 */
export function tryAcquireEditLock(
  courseId: string,
  ownTabId: string,
  now: number = Date.now(),
): boolean {
  if (isEditLockHeldByOther(courseId, ownTabId, now)) return false;
  writeEditLock(courseId, { tabId: ownTabId, timestamp: now });
  return true;
}

/**
 * Heartbeat update — refresh the timestamp so other tabs don't decide
 * the lock has gone stale. Idempotent; no-op if another tab has taken
 * ownership.
 */
export function refreshEditLock(
  courseId: string,
  ownTabId: string,
  now: number = Date.now(),
): void {
  const state = readEditLock(courseId);
  if (state !== null && state.tabId !== ownTabId) return;
  writeEditLock(courseId, { tabId: ownTabId, timestamp: now });
}

/**
 * Release the lock only if we still own it. Prevents a delayed
 * `releaseEditLock` from a previous edit session from clobbering a new
 * owner that came in after the lock went stale.
 */
export function releaseEditLock(courseId: string, ownTabId: string): void {
  try {
    const state = readEditLock(courseId);
    if (state === null || state.tabId !== ownTabId) return;
    localStorage.removeItem(editLockKey(courseId));
  } catch {
    // ignore
  }
}
