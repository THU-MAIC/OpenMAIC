/**
 * Stage API - Mode & Stage Meta Management
 *
 * Factory functions that create the mode and stage namespaces of the Stage API.
 */

import type { Stage, StageMode } from '@/lib/types/stage';
import type { StageStore, APIResult } from './stage-api-types';

/**
 * Create the mode management API
 *
 * @param store - Zustand store instance
 * @returns Mode namespace API
 */
export function createModeAPI(store: StageStore) {
  return {
    /**
     * Set mode
     *
     * @param newMode - New mode
     */
    set(newMode: StageMode): APIResult<boolean> {
      try {
        store.setState({ mode: newMode });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get current mode
     *
     * @returns Current mode
     */
    get(): APIResult<StageMode> {
      try {
        const state = store.getState();
        return { success: true, data: state.mode };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}

/**
 * Create the stage meta management API
 *
 * @param store - Zustand store instance
 * @returns Stage namespace API
 */
export function createStageMetaAPI(store: StageStore) {
  return {
    /**
     * Get Stage info
     *
     * @returns Stage object
     */
    get(): APIResult<Stage> {
      try {
        const state = store.getState();

        if (!state.stage) {
          return { success: false, error: 'No stage' };
        }

        return { success: true, data: state.stage };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Update Stage info
     *
     * @param updates - Fields to update
     * @returns Whether successful
     */
    update(updates: Partial<Stage>): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!state.stage) {
          return { success: false, error: 'No stage' };
        }

        const newStage = {
          ...state.stage,
          ...updates,
          updatedAt: Date.now(),
        };

        store.setState({ stage: newStage });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}
