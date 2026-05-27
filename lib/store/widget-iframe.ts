/**
 * Widget iframe messaging store.
 * Tracks iframe postMessage callbacks per scene to prevent race conditions
 * when switching between interactive scenes.
 */

import { create } from 'zustand';

interface WidgetIframeState {
  /** Callbacks keyed by sceneId for targeted postMessage communication */
  sendMessageByScene: Record<string, (type: string, payload: Record<string, unknown>) => void>;
  /** Currently active scene ID (used for fallback/legacy support) */
  activeSceneId: string | null;
  /** Register an iframe callback for a specific scene */
  registerIframe: (
    sceneId: string,
    callback: ((type: string, payload: Record<string, unknown>) => void) | null,
  ) => void;
  /** Set the active scene ID */
  setActiveScene: (sceneId: string | null) => void;
  /** Get sendMessage callback for a specific scene (or current active scene) */
  getSendMessage: (
    sceneId?: string,
  ) => ((type: string, payload: Record<string, unknown>) => void) | null;
}

export const useWidgetIframeStore = create<WidgetIframeState>((set, get) => ({
  sendMessageByScene: {},
  activeSceneId: null,
  registerIframe: (sceneId, callback) =>
    set((state) => {
      if (callback === null) {
        // Unregister: remove from map
        const updated = { ...state.sendMessageByScene };
        delete updated[sceneId];
        return { sendMessageByScene: updated };
      }
      // Register: add to map
      return {
        sendMessageByScene: { ...state.sendMessageByScene, [sceneId]: callback },
      };
    }),
  setActiveScene: (sceneId) => set({ activeSceneId: sceneId }),
  getSendMessage: (sceneId) => {
    const state = get();
    const targetId = sceneId ?? state.activeSceneId;
    if (!targetId) return null;
    return state.sendMessageByScene[targetId] ?? null;
  },
}));
