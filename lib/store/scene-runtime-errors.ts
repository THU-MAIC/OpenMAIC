'use client';

/**
 * Per-scene runtime errors captured from interactive iframes (via the error
 * shim's postMessage, see lib/utils/iframe.ts). Keyed by sceneId. Deduped (a
 * render loop can log the same error repeatedly) and capped so the agent context
 * stays small. The editor agent reads these when building its scene context so it
 * can diagnose a blank/broken page from the actual error instead of guessing.
 */
import { create } from 'zustand';

const MAX_PER_SCENE = 8;

interface SceneRuntimeErrorsState {
  errors: Record<string, string[]>;
  /** Record one error for a scene (deduped, capped to the most recent). */
  addError: (sceneId: string, message: string) => void;
  /** Drop a scene's errors (e.g. when it re-renders with new content). */
  clearScene: (sceneId: string) => void;
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
