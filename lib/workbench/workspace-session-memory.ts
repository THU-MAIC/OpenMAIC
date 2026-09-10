/**
 * The last conversation the user explicitly had open in the Pro workspace.
 *
 * This is entry memory, not live pane state. The workspace still owns its
 * current panes. Classic mode reads only the remembered conversation so a
 * later Pro entry can resume it without also reopening a classroom.
 */
export const LAST_WORKSPACE_SESSION_STORAGE_KEY = 'openmaic:workspace:last-session';

const WORKSPACE_HOME_SENTINEL = 'openmaic:workspace:home';

interface SessionMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function availableStorage(storage?: SessionMemoryStorage): SessionMemoryStorage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function normalizeSessionId(value: string | null | undefined): string | null {
  const sessionId = value?.trim();
  return sessionId || null;
}

export function readLastWorkspaceSessionId(storage?: SessionMemoryStorage): string | null {
  try {
    const remembered = normalizeSessionId(
      availableStorage(storage)?.getItem(LAST_WORKSPACE_SESSION_STORAGE_KEY),
    );
    return remembered === WORKSPACE_HOME_SENTINEL ? null : remembered;
  } catch {
    return null;
  }
}

export function rememberWorkspaceSession(sessionId: string, storage?: SessionMemoryStorage): void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  try {
    availableStorage(storage)?.setItem(LAST_WORKSPACE_SESSION_STORAGE_KEY, normalized);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

/** Remember that the clean workspace home, rather than a conversation, was last open. */
export function rememberWorkspaceHome(storage?: SessionMemoryStorage): void {
  try {
    availableStorage(storage)?.setItem(LAST_WORKSPACE_SESSION_STORAGE_KEY, WORKSPACE_HOME_SENTINEL);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function forgetWorkspaceSession(sessionId: string, storage?: SessionMemoryStorage): void {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  try {
    const target = availableStorage(storage);
    if (normalizeSessionId(target?.getItem(LAST_WORKSPACE_SESSION_STORAGE_KEY)) === normalized) {
      target?.removeItem(LAST_WORKSPACE_SESSION_STORAGE_KEY);
    }
  } catch {
    // Best-effort memory: deletion must never be blocked by localStorage.
  }
}

/** Forget a remembered conversation when the workspace's existing list no longer contains it. */
export function validateRememberedWorkspaceSession(
  sessionId: string,
  existingSessionIds: readonly string[],
  storage?: SessionMemoryStorage,
): boolean {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return false;
  const exists = existingSessionIds.some((existing) => normalizeSessionId(existing) === normalized);
  if (!exists) forgetWorkspaceSession(normalized, storage);
  return exists;
}

/** The classic-mode entry target; missing memory keeps the clean Pro home. */
export function workspaceResumeHref(sessionId: string | null): string {
  const normalized = normalizeSessionId(sessionId);
  return normalized ? `/workspace?session=${encodeURIComponent(normalized)}` : '/workspace';
}
