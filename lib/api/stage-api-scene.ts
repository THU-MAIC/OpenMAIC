/**
 * Stage API - Scene Management
 *
 * Factory function that creates the scene namespace of the Stage API.
 */

import type { Scene, SceneContent } from '@/lib/types/stage';
import type { StageStore, APIResult, CreateSceneParams } from './stage-api-types';
import { generateId, validateSceneId, getScene, createDefaultContent } from './stage-api-defaults';

/**
 * Create the scene management API
 *
 * @param store - Zustand store instance
 * @returns Scene namespace API
 */
export function createSceneAPI(store: StageStore) {
  return {
    /**
     * Create a new scene
     *
     * @param params - Scene parameters
     * @returns Scene ID
     *
     * @example
     * const sceneId = api.scene.create({
     *   type: 'slide',
     *   title: 'Introduction',
     *   // speech is now in actions
     * });
     */
    create(params: CreateSceneParams): APIResult<string> {
      try {
        const state = store.getState();

        if (!state.stage) {
          return {
            success: false,
            error: 'No stage set - cannot create scene without a stage',
          };
        }

        const sceneId = generateId('scene');

        // Determine order
        const order = params.order ?? state.scenes.length;

        // Create default content or use the provided content
        let content: SceneContent;
        if (params.content) {
          content = {
            ...createDefaultContent(params.type),
            ...params.content,
          } as SceneContent;
        } else {
          content = createDefaultContent(params.type);
        }

        const newScene: Scene = {
          id: sceneId,
          stageId: state.stage.id,
          type: params.type,
          title: params.title,
          order,
          content,
          actions: params.actions,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const newScenes = [...state.scenes, newScene].sort((a, b) => a.order - b.order);

        store.setState({ scenes: newScenes });

        return { success: true, data: sceneId };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Delete a scene
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    delete(sceneId: string): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!validateSceneId(state.scenes, sceneId)) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        const newScenes = state.scenes.filter((s) => s.id !== sceneId);

        // If the deleted scene is the current one, switch to the next
        let newCurrentSceneId = state.currentSceneId;
        if (state.currentSceneId === sceneId) {
          newCurrentSceneId = newScenes.length > 0 ? newScenes[0].id : null;
        }

        store.setState({
          scenes: newScenes,
          currentSceneId: newCurrentSceneId,
        });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Update a scene
     *
     * @param sceneId - Scene ID
     * @param updates - Fields to update
     * @returns Whether successful
     */
    update(sceneId: string, updates: Partial<Scene>): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!validateSceneId(state.scenes, sceneId)) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        const newScenes = state.scenes.map((scene) =>
          scene.id === sceneId ? { ...scene, ...updates, updatedAt: Date.now() } : scene,
        );

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get all scenes
     *
     * @returns Scene list
     */
    list(): APIResult<Scene[]> {
      try {
        const state = store.getState();
        return { success: true, data: [...state.scenes] };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get a specific scene
     *
     * @param sceneId - Scene ID
     * @returns Scene object
     */
    get(sceneId: string): APIResult<Scene> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        return { success: true, data: scene };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}
