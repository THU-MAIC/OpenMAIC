/**
 * Stage API - Element Operations
 *
 * Factory function that creates the element namespace of the Stage API.
 * Handles element CRUD operations for slide-type scenes.
 */

import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';
import type { StageStore, APIResult, CreateElementParams } from './stage-api-types';
import { generateId, getScene } from './stage-api-defaults';

/**
 * Create the element management API
 *
 * @param store - Zustand store instance
 * @returns Element namespace API
 */
export function createElementAPI(store: StageStore) {
  return {
    /**
     * Add an element to a Slide
     *
     * @param sceneId - Scene ID
     * @param element - Element parameters (must include type, left, top, width, height)
     * @returns Element ID
     */
    add(sceneId: string, element: CreateElementParams): APIResult<string> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;
        const elementId = generateId(element.type);

        const newElement: PPTElement = {
          ...element,
          id: elementId,
          rotate: element.rotate ?? 0,
        } as PPTElement;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: [...content.canvas.elements, newElement],
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: elementId };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Add elements in batch
     *
     * @deprecated will be removed in the future
     * @param sceneId - Scene ID
     * @param elements - Element array
     * @returns Element ID array
     */
    addBatch(sceneId: string, elements: CreateElementParams[]): APIResult<string[]> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;
        const elementIds: string[] = [];

        const newElements: PPTElement[] = elements.map((el) => {
          const elementId = generateId(el.type);
          elementIds.push(elementId);

          return {
            ...el,
            id: elementId,
            rotate: el.rotate ?? 0,
          } as PPTElement;
        });

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: [...content.canvas.elements, ...newElements],
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: elementIds };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Delete an element
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @returns Whether successful
     */
    delete(sceneId: string, elementId: string): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: content.canvas.elements.filter((el) => el.id !== elementId),
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Delete elements in batch
     *
     * @deprecated will be removed in the future
     * @param sceneId - Scene ID
     * @param elementIds - Element ID array
     * @returns Whether successful
     */
    deleteBatch(sceneId: string, elementIds: string[]): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;
        const elementIdSet = new Set(elementIds);

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: content.canvas.elements.filter((el) => !elementIdSet.has(el.id)),
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Update an element
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param updates - Properties to update
     * @returns Whether successful
     */
    update(sceneId: string, elementId: string, updates: Partial<PPTElement>): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: content.canvas.elements.map((el) =>
                    el.id === elementId ? { ...el, ...updates } : el,
                  ),
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get an element
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @returns Element object
     */
    get(sceneId: string, elementId: string): APIResult<PPTElement> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;
        const element = content.canvas.elements.find((el) => el.id === elementId);

        if (!element) {
          return { success: false, error: `Element not found: ${elementId}` };
        }

        return { success: true, data: element };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get all elements of a scene
     *
     * @param sceneId - Scene ID
     * @returns Element list
     */
    list(sceneId: string): APIResult<PPTElement[]> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;
        return { success: true, data: [...content.canvas.elements] };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Move an element (relative movement)
     *
     * @deprecated will be removed in the future
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param deltaX - X-axis movement distance
     * @param deltaY - Y-axis movement distance
     * @returns Whether successful
     */
    move(sceneId: string, elementId: string, deltaX: number, deltaY: number): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene) {
          return { success: false, error: `Scene not found: ${sceneId}` };
        }

        if (scene.type !== 'slide') {
          return { success: false, error: `Scene is not a slide: ${sceneId}` };
        }

        const content = scene.content as SlideContent;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  elements: content.canvas.elements.map((el) => {
                    if (el.id === elementId) {
                      return {
                        ...el,
                        left: el.left + deltaX,
                        top: el.top + deltaY,
                      };
                    }
                    return el;
                  }),
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}
