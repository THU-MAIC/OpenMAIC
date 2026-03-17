/**
 * Stage API - Navigation
 *
 * Factory function that creates the navigation namespace of the Stage API.
 * Handles scene navigation (goTo, next, previous, current).
 */

import type { Scene } from '@/lib/types/stage';
import type { StageStore, APIResult } from './stage-api-types';
import { validateSceneId, getScene } from './stage-api-defaults';

/**
 * Create the navigation API
 *
 * @param store - Zustand store instance
 * @returns Navigation namespace API
 */
export function createNavigationAPI(store: StageStore) {
  return {
    /**
     * Navigate to a specific scene
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    goTo(sceneId: string): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!validateSceneId(state.scenes, sceneId)) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        store.setState({ currentSceneId: sceneId });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Next scene
     *
     * @returns Whether successful
     */
    next(): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!state.currentSceneId || state.scenes.length === 0) {
          return { success: false, error: 'No current scene' };
        }

        const currentIndex = state.scenes.findIndex((s) => s.id === state.currentSceneId);
        if (currentIndex === -1 || currentIndex === state.scenes.length - 1) {
          return { success: false, error: 'Already at last scene' };
        }

        const nextScene = state.scenes[currentIndex + 1];
        store.setState({ currentSceneId: nextScene.id });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Previous scene
     *
     * @returns Whether successful
     */
    previous(): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!state.currentSceneId || state.scenes.length === 0) {
          return { success: false, error: 'No current scene' };
        }

        const currentIndex = state.scenes.findIndex((s) => s.id === state.currentSceneId);
        if (currentIndex === -1 || currentIndex === 0) {
          return { success: false, error: 'Already at first scene' };
        }

        const prevScene = state.scenes[currentIndex - 1];
        store.setState({ currentSceneId: prevScene.id });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get the current scene
     *
     * @returns Current scene
     */
    current(): APIResult<Scene> {
      try {
        const state = store.getState();

        if (!state.currentSceneId) {
          return { success: false, error: 'No current scene' };
        }

        const scene = getScene(state.scenes, state.currentSceneId);
        if (!scene) {
          return { success: false, error: 'Current scene not found' };
        }

        return { success: true, data: scene };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}
