'use client';

/**
 * Per-scene runtime errors captured from interactive iframes (via the error
 * shim's postMessage, see lib/utils/iframe.ts). Keyed by sceneId. Deduped (a
 * render loop can log the same error repeatedly) and capped so a banner can
 * show the latest few. The active interactive scene reads this store. The
 * workbench agent does not: it loads scene HTML on the server and cannot see
 * this client snapshot.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

const MAX_PER_SCENE = 8;

interface SceneRuntimeErrorsState {
  errors: Record<string, string[]>;
  /** Record one error for a scene (deduped, capped to the most recent). */
  addError: (sceneId: string, message: string) => void;
  /** Drop a scene's errors (e.g. when it re-renders with new content). */
  clearScene: (sceneId: string) => void;
  /**
   * Drop every scene's errors. The classroom switch path: errors are keyed by
   * sceneId and belong to the course that observed them, so another course's
   * classroom must not inherit them.
   */
  clearAll: () => void;
}

export const useSceneRuntimeErrors = create<SceneRuntimeErrorsState>((set) => ({
  errors: {},
  addError: (sceneId, message) =>
    set((s) => {
      const trimmed = message.trim();
      if (!trimmed) return s;
      const cur = s.errors[sceneId] ?? [];
      if (cur.includes(trimmed)) return s; // dedup
      const next = [...cur, trimmed].slice(-MAX_PER_SCENE);
      return { errors: { ...s.errors, [sceneId]: next } };
    }),
  clearScene: (sceneId) =>
    set((s) => {
      if (!s.errors[sceneId]) return s;
      const errors = { ...s.errors };
      delete errors[sceneId];
      return { errors };
    }),
  clearAll: () => set({ errors: {} }),
}));

/**
 * Scope the observed errors to the classroom's course: they are this browser's
 * observation of ONE course's pages, so they are dropped when the course
 * changes — and on mount, so a returning visit starts from what the pages
 * report now, not from what the last visit saw.
 */
export function useRuntimeErrorsScopedToCourse(courseId: string | undefined): void {
  const clearAll = useSceneRuntimeErrors((s) => s.clearAll);
  useEffect(() => {
    clearAll();
  }, [courseId, clearAll]);
}
