import type { SessionStatus } from './session-store';

export interface WorkspaceSessionPresentation {
  /** i18n key under `workspace.sessionStatus.*` — the copy stays in the locale files. */
  readonly labelKey: string;
  readonly tone: 'live' | 'error' | 'idle';
}

/**
 * Stable navigation copy/tone derived from the real session fold state.
 *
 * RUN statuses only. `idle` is "the store holds no session", which has no run to
 * report and therefore nothing to present — no label, no dot, no spinner. Callers
 * must decide that BEFORE asking (see `WorkspaceChatPane`), and the excluded type
 * is what makes forgetting to a compile error rather than a header that claims a
 * conversation which does not exist is connecting.
 */
export function presentWorkspaceSession(
  status: Exclude<SessionStatus, 'idle'>,
): WorkspaceSessionPresentation {
  switch (status) {
    case 'connecting':
      return { labelKey: 'workspace.sessionStatus.connecting', tone: 'live' };
    case 'queued':
      return { labelKey: 'workspace.sessionStatus.queued', tone: 'live' };
    case 'running':
      return { labelKey: 'workspace.sessionStatus.running', tone: 'live' };
    case 'succeeded':
      return { labelKey: 'workspace.sessionStatus.succeeded', tone: 'idle' };
    case 'failed':
      return { labelKey: 'workspace.sessionStatus.failed', tone: 'error' };
    case 'cancelled':
      return { labelKey: 'workspace.sessionStatus.cancelled', tone: 'idle' };
  }
}

export function currentPageIndex(
  sceneIds: readonly string[],
  currentSceneId: string | null,
): number {
  return currentSceneId ? sceneIds.indexOf(currentSceneId) : -1;
}

/* ── Rail sizing ──────────────────────────────────────────────────────────
   The nav rail is user-resizable (drag its right edge, double-click to
   reset). The bounds live here, with the parsing, because a persisted width
   is untrusted input: it survives in localStorage across releases, and a
   stale or hand-edited value must never be able to render the rail unusable
   or push the canvas off screen. */

export const RAIL_WIDTH_DEFAULT = 252;
export const RAIL_WIDTH_MIN = 200;
export const RAIL_WIDTH_MAX = 360;
export const RAIL_WIDTH_STORAGE_KEY = 'openmaic:workspace:rail-width';

/** Clamp to the supported range; anything non-finite falls back to the default. */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH_DEFAULT;
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(width)));
}

/**
 * Read a persisted rail width. `null`/garbage → the default, so a corrupted
 * entry degrades to the shipped layout instead of throwing during hydration.
 */
export function parseRailWidth(stored: string | null): number {
  if (stored === null) return RAIL_WIDTH_DEFAULT;
  const parsed = Number.parseFloat(stored);
  return clampRailWidth(parsed);
}
