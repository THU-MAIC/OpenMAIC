/**
 * Stage API - Scene Management
 *
 * Factory function that creates the scene namespace of the Stage API.
 */

import { makeScene, type Scene, type ScenePatch, type SceneContent } from '@/lib/types/stage';
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

        // Create default content or use the provided content. `params.type` is
        // authoritative: reject a `content.type` that disagrees, and pin the
        // merged content's `type` to it so the scene's discriminant can't be
        // silently overridden by a partial content override.
        let content: SceneContent;
        if (params.content) {
          if (params.content.type !== undefined && params.content.type !== params.type) {
            return {
              success: false,
              error: `content.type '${params.content.type}' does not match scene type '${params.type}'`,
            };
          }
          content = {
            ...createDefaultContent(params.type),
            ...params.content,
            type: params.type,
          } as SceneContent;
        } else {
          content = createDefaultContent(params.type);
        }

        const newScene: Scene = makeScene(
          {
            id: sceneId,
            stageId: state.stage.id,
            title: params.title,
            order,
            actions: params.actions,
            ...(params.outlineId !== undefined && { outlineId: params.outlineId }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          content,
        );

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
    update(sceneId: string, updates: ScenePatch): APIResult<boolean> {
      try {
        const state = store.getState();

        if (!validateSceneId(state.scenes, sceneId)) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        const newScenes = state.scenes.map((scene) => {
          if (scene.id !== sceneId) return scene;
          // Rebind `type` to the (possibly updated) content's kind so a
          // content-only or type-only patch can't desync the discriminant.
          const content = updates.content ?? scene.content;
          return makeScene({ ...scene, ...updates, updatedAt: Date.now() }, content);
        });

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
