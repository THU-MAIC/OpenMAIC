/**
 * Per-scene slide-edit history persistence to localStorage. The slide-ops
 * kernel from #564 produces `SlideEditHistory` (past/present/future,
 * capped at 50); this module is the storage layer for autosaving and
 * restoring that history across page reloads.
 *
 * Wiring (slide-surface PR's responsibility):
 *   - On each successful op application, call `persistSlideHistory(sceneId,
 *     history)`.
 *   - On entering edit mode for a scene, call `loadPersistedSlideHistory`
 *     and, if non-null, prompt the user via
 *     `SlideHistoryRestorePrompt` to restore or discard.
 *   - Restore handler seeds the slide surface's history state; discard
 *     handler calls `clearPersistedSlideHistory`.
 *
 * All helpers swallow storage failures (quota / disabled / private mode)
 * so the editor degrades to in-memory-only history instead of crashing.
 */

import type { SlideEditHistory } from '@/lib/edit/slide-ops';

const KEY_PREFIX = 'maic-editor:slide-history';

export function slideHistoryStorageKey(sceneId: string): string {
  return `${KEY_PREFIX}:${sceneId}`;
}

export function persistSlideHistory(sceneId: string, history: SlideEditHistory): void {
  try {
    localStorage.setItem(slideHistoryStorageKey(sceneId), JSON.stringify(history));
  } catch {
    // Quota exceeded / disabled — degrade silently to in-memory only.
  }
}

export function loadPersistedSlideHistory(sceneId: string): SlideEditHistory | null {
  try {
    const raw = localStorage.getItem(slideHistoryStorageKey(sceneId));
    if (raw === null) return null;
    return JSON.parse(raw) as SlideEditHistory;
  } catch {
    // Corrupted JSON or storage failure — treat as no persisted history.
    return null;
  }
}

export function hasPersistedSlideHistory(sceneId: string): boolean {
  try {
    return localStorage.getItem(slideHistoryStorageKey(sceneId)) !== null;
  } catch {
    return false;
  }
}

export function clearPersistedSlideHistory(sceneId: string): void {
  try {
    localStorage.removeItem(slideHistoryStorageKey(sceneId));
  } catch {
    // ignore
  }
}
