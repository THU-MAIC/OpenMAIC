/**
 * Canvas Element Operations Hook
 *
 * Provides convenient element CRUD methods to avoid repetitive definitions in each component
 *
 * @example
 * function MyComponent() {
 *   const { addElement, updateElement, deleteElement } = useCanvasOperations();
 *
 *   const handleAdd = () => {
 *     addElement({
 *       id: 'new-1',
 *       type: 'text',
 *       // ...
 *     });
 *   };
 * }
 */

import { useSceneData, useSceneSelector } from '@/lib/contexts/scene-context';
import {
  useCanvasStore,
  type SpotlightOptions,
  type HighlightOverlayOptions,
} from '@/lib/store/canvas';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, Slide } from '@/lib/types/slides';
import { useCallback, useMemo } from 'react';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { toast } from 'sonner';
import { ElementAlignCommands, ElementOrderCommands } from '@/lib/types/edit';
import { getElementListRange } from '@/lib/utils/element';
import { useOrderElement } from './use-order-element';
import { nanoid } from 'nanoid';

type PPTElementKey = keyof PPTElement;

interface RemovePropData {
  id: string;
  propName: PPTElementKey | PPTElementKey[];
}

interface UpdateElementData {
  id: string | string[];
  props: Partial<PPTElement>;
  slideId?: string;
}

export function useCanvasOperations() {
  const { updateSceneData } = useSceneData<SlideContent>();
  const currentSlide = useSceneSelector<SlideContent, Slide>((content) => content.canvas);

  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeElementList = useMemo(
    () => currentSlide.elements.filter((el) => activeElementIdList.includes(el.id)),
    [currentSlide.elements, activeElementIdList],
  );
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const handleElementId = useCanvasStore.use.handleElementId();
  const hiddenElementIdList = useCanvasStore.use.hiddenElementIdList();

  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  const _setEditorareaFocus = useCanvasStore.use.setEditorAreaFocus();

  const { addHistorySnapshot } = useHistorySnapshot();
  const { moveUpElement, moveDownElement, moveTopElement, moveBottomElement } = useOrderElement();

  /**
   * Add element(s)
   * @param element Single element or element array
   * @param autoSelect Whether to auto-select newly added elements (default true)
   */
  const addElement = useCallback(
    (element: PPTElement | PPTElement[], autoSelect = true) => {
      const elements = Array.isArray(element) ? element : [element];

      updateSceneData((draft) => {
        draft.canvas.elements.push(...elements);
      });

      // Auto-select newly added elements
      if (autoSelect) {
        const newIds = elements.map((el) => el.id);
        setActiveElementIdList(newIds);
      }
    },
    [updateSceneData, setActiveElementIdList],
  );

  // Delete all selected elements
  // If a group member is selected for independent operation, delete that element first. Otherwise delete all selected elements.
  // If elementId is provided, only delete that element
  const deleteElement = (elementId?: string) => {
    let newElementList: PPTElement[] = [];

    if (elementId) {
      // Delete specified element
      newElementList = currentSlide.elements.filter((el) => el.id !== elementId);
      setActiveElementIdList(activeElementIdList.filter((id) => id !== elementId));
    } else {
      // Original logic: delete selected elements
      if (!activeElementIdList.length) return;

      if (activeGroupElementId) {
        newElementList = currentSlide.elements.filter((el) => el.id !== activeGroupElementId);
      } else {
        newElementList = currentSlide.elements.filter((el) => !activeElementIdList.includes(el.id));
      }
      setActiveElementIdList([]);
    }

    updateSlide({ elements: newElementList });
    addHistorySnapshot();
  };

  // Delete all elements on the page (regardless of selection)
  const deleteAllElements = () => {
    if (!currentSlide.elements.length) return;
    setActiveElementIdList([]);
    updateSlide({ elements: [] });
    addHistorySnapshot();
  };

  /**
   * Update element properties
   * @param props Properties to update
   */
  const updateElement = useCallback(
    (data: UpdateElementData) => {
      const { id, props } = data;
      const elementIds = Array.isArray(id) ? id : [id];

      updateSceneData((draft) => {
        draft.canvas.elements.forEach((el) => {
          if (elementIds.includes(el.id)) {
            Object.assign(el, props);
          }
        });
      });
    },
    [updateSceneData],
  );

  /**
   * Update slide content
   */
  const updateSlide = useCallback(
    (props: Partial<Slide>) => {
      updateSceneData((draft) => {
        Object.assign(draft.canvas, props);
      });
    },
    [updateSceneData],
  );

  /**
   * Remove element properties
   */
  const removeElementProps = useCallback(
    (data: RemovePropData) => {
      const { id, propName } = data;
      const elementIds = Array.isArray(id) ? id : [id];
      const propNames = Array.isArray(propName) ? propName : [propName];

      updateSceneData((draft) => {
        draft.canvas.elements.forEach((el) => {
          if (elementIds.includes(el.id)) {
            propNames.forEach((name) => {
              delete el[name];
            });
          }
        });
      });
    },
    [updateSceneData],
  );

  // Copy selected element data to clipboard
  const copyElement = () => {
    // if (!activeElementIdList.length) return

    // const text = JSON.stringify({
    //   type: 'elements',
    //   data: activeElementList,
    // })

    // copyText(text).then(() => {
    //   setEditorareaFocus(true)
    // })
    toast.warning('Not implemented');
  };

  // Copy and delete selected elements (cut)
  const cutElement = () => {
    // copyElement()
    // deleteElement()
    toast.warning('Not implemented');
  };

  // Attempt to paste element data from clipboard
  const pasteElement = () => {
    // readClipboard().then(text => {
    //   pasteTextClipboardData(text)
    // }).catch(err => toast.warning(err))
    toast.warning('Not implemented');
  };

  // Copy and immediately paste selected elements
  const _quickCopyElement = () => {
    copyElement();
    pasteElement();
  };

  // Lock selected elements and clear selection state
  const lockElement = () => {
    const newElementList: PPTElement[] = JSON.parse(JSON.stringify(currentSlide.elements));

    for (const element of newElementList) {
      if (activeElementIdList.includes(element.id)) element.lock = true;
    }
    updateSlide({ elements: newElementList });
    setActiveElementIdList([]);
    addHistorySnapshot();
  };

  /**
   * Unlock an element and set it as the current selection
   * @param handleElement The element to unlock
   */
  const unlockElement = (handleElement: PPTElement) => {
    const newElementList: PPTElement[] = JSON.parse(JSON.stringify(currentSlide.elements));

    if (handleElement.groupId) {
      const groupElementIdList = [];
      for (const element of newElementList) {
        if (element.groupId === handleElement.groupId) {
          element.lock = false;
          groupElementIdList.push(element.id);
        }
      }
      updateSlide({ elements: newElementList });
      setActiveElementIdList(groupElementIdList);
    } else {
      for (const element of newElementList) {
        if (element.id === handleElement.id) {
          element.lock = false;
          break;
        }
      }
      updateSlide({ elements: newElementList });
      setActiveElementIdList([handleElement.id]);
    }
    addHistorySnapshot();
  };

  // Select all elements on the current page
  const selectAllElements = () => {
    const unlockedElements = currentSlide.elements.filter(
      (el) => !el.lock && !hiddenElementIdList.includes(el.id),
    );
    const newActiveElementIdList = unlockedElements.map((el) => el.id);
    setActiveElementIdList(newActiveElementIdList);
  };

  // Select a specific element
  const selectElement = (id: string) => {
    if (handleElementId === id) return;
    if (hiddenElementIdList.includes(id)) return;

    const lockedElements = currentSlide.elements.filter((el) => el.lock);
    if (lockedElements.some((el) => el.id === id)) return;

    setActiveElementIdList([id]);
  };

  /**
   * Align all selected elements to the canvas
   * @param command Alignment direction
   */
  const alignElementToCanvas = (command: ElementAlignCommands) => {
    const viewportWidth = viewportSize;
    const viewportHeight = viewportSize * viewportRatio;
    const { minX, maxX, minY, maxY } = getElementListRange(activeElementList);

    const newElementList: PPTElement[] = JSON.parse(JSON.stringify(currentSlide.elements));
    for (const element of newElementList) {
      if (!activeElementIdList.includes(element.id)) continue;

      // Center horizontally and vertically
      if (command === ElementAlignCommands.CENTER) {
        const offsetY = minY + (maxY - minY) / 2 - viewportHeight / 2;
        const offsetX = minX + (maxX - minX) / 2 - viewportWidth / 2;
        element.top = element.top - offsetY;
        element.left = element.left - offsetX;
      }

      // Align to top
      if (command === ElementAlignCommands.TOP) {
        const offsetY = minY - 0;
        element.top = element.top - offsetY;
      }

      // Center vertically
      else if (command === ElementAlignCommands.VERTICAL) {
        const offsetY = minY + (maxY - minY) / 2 - viewportHeight / 2;
        element.top = element.top - offsetY;
      }

      // Align to bottom
      else if (command === ElementAlignCommands.BOTTOM) {
        const offsetY = maxY - viewportHeight;
        element.top = element.top - offsetY;
      }

      // Align to left
      else if (command === ElementAlignCommands.LEFT) {
        const offsetX = minX - 0;
        element.left = element.left - offsetX;
      }

      // Center horizontally
      else if (command === ElementAlignCommands.HORIZONTAL) {
        const offsetX = minX + (maxX - minX) / 2 - viewportWidth / 2;
        element.left = element.left - offsetX;
      }

      // Align to right
      else if (command === ElementAlignCommands.RIGHT) {
        const offsetX = maxX - viewportWidth;
        element.left = element.left - offsetX;
      }
    }

    updateSlide({ elements: newElementList });
    addHistorySnapshot();
  };

  /**
   * Adjust element z-order
   * @param element The element to reorder
   * @param command Reorder command: move up, move down, bring to front, send to back
   */
  const orderElement = (element: PPTElement, command: ElementOrderCommands) => {
    let newElementList;

    if (command === ElementOrderCommands.UP)
      newElementList = moveUpElement(currentSlide.elements, element);
    else if (command === ElementOrderCommands.DOWN)
      newElementList = moveDownElement(currentSlide.elements, element);
    else if (command === ElementOrderCommands.TOP)
      newElementList = moveTopElement(currentSlide.elements, element);
    else if (command === ElementOrderCommands.BOTTOM)
      newElementList = moveBottomElement(currentSlide.elements, element);

    if (!newElementList) return;

    updateSlide({ elements: newElementList });
    addHistorySnapshot();
  };

  /**
   * Check if current selected elements can be grouped
   */
  const _canCombine = useMemo(() => {
    if (activeElementList.length < 2) return false;

    const firstGroupId = activeElementList[0].groupId;
    if (!firstGroupId) return true;

    const inSameGroup = activeElementList.every((el) => el.groupId && el.groupId === firstGroupId);
    return !inSameGroup;
  }, [activeElementList]);

  /**
   * Group current selected elements: assign the same group ID to all selected elements
   */
  const combineElements = () => {
    if (!activeElementList.length) return;

    // Create a new element list for subsequent operations
    let newElementList: PPTElement[] = JSON.parse(JSON.stringify(currentSlide.elements));

    // Generate group ID
    const groupId = nanoid(10);

    // Collect elements to be grouped and assign the unique group ID
    const combineElementList: PPTElement[] = [];
    for (const element of newElementList) {
      if (activeElementIdList.includes(element.id)) {
        element.groupId = groupId;
        combineElementList.push(element);
      }
    }

    // Ensure all group members have consecutive z-order levels:
    // First find the highest z-level member, remove all group members from the element list,
    // then insert the collected group members back at the appropriate position based on the highest level
    const combineElementMaxLevel = newElementList.findIndex(
      (_element) => _element.id === combineElementList[combineElementList.length - 1].id,
    );
    const combineElementIdList = combineElementList.map((_element) => _element.id);
    newElementList = newElementList.filter(
      (_element) => !combineElementIdList.includes(_element.id),
    );

    const insertLevel = combineElementMaxLevel - combineElementList.length + 1;
    newElementList.splice(insertLevel, 0, ...combineElementList);

    updateSlide({ elements: newElementList });
    addHistorySnapshot();
  };

  /**
   * Ungroup elements: remove the group ID from selected elements
   */
  const uncombineElements = () => {
    if (!activeElementList.length) return;
    const hasElementInGroup = activeElementList.some((item) => item.groupId);
    if (!hasElementInGroup) return;

    const newElementList: PPTElement[] = JSON.parse(JSON.stringify(currentSlide.elements));
    for (const element of newElementList) {
      if (activeElementIdList.includes(element.id) && element.groupId) delete element.groupId;
    }
    updateSlide({ elements: newElementList });

    // After ungrouping, reset active element state
    // Default to the currently handled element, or empty if none exists
    const handleElementIdList = handleElementId ? [handleElementId] : [];
    setActiveElementIdList(handleElementIdList);

    addHistorySnapshot();
  };

  /**
   * Update background
   * @param background New background settings
   */
  const updateBackground = useCallback(
    (background: SlideContent['canvas']['background']) => {
      updateSceneData((draft) => {
        draft.canvas.background = background;
      });
    },
    [updateSceneData],
  );

  /**
   * Update theme
   * @param theme Theme settings (partial)
   */
  const updateTheme = useCallback(
    (theme: Partial<SlideContent['canvas']['theme']>) => {
      updateSceneData((draft) => {
        draft.canvas.theme = {
          ...draft.canvas.theme,
          ...theme,
        };
      });
    },
    [updateSceneData],
  );

  /**
   * Spotlight focus on an element
   * @param elementId Element ID
   * @param options Spotlight options
   */
  const spotlightElement = useCallback((elementId: string, options?: SpotlightOptions) => {
    useCanvasStore.getState().setSpotlight(elementId, options);
  }, []);

  /**
   * Clear spotlight
   */
  const clearSpotlight = useCallback(() => {
    useCanvasStore.getState().clearSpotlight();
  }, []);

  /**
   * Highlight elements
   * @param elementIds Element ID list
   * @param options Highlight options
   */
  const highlightElements = useCallback(
    (elementIds: string[], options?: HighlightOverlayOptions) => {
      useCanvasStore.getState().setHighlight(elementIds, options);
    },
    [],
  );

  /**
   * Clear highlight
   */
  const clearHighlight = useCallback(() => {
    useCanvasStore.getState().clearHighlight();
  }, []);

  /**
   * Laser pointer effect
   * @param elementId Element ID
   * @param options Laser pointer options
   */
  const laserElement = useCallback(
    (elementId: string, options?: { color?: string; duration?: number }) => {
      useCanvasStore.getState().setLaser(elementId, options);
    },
    [],
  );

  /**
   * Clear laser pointer
   */
  const clearLaser = useCallback(() => {
    useCanvasStore.getState().clearLaser();
  }, []);

  /**
   * Zoom an element
   * @param elementId Element ID
   * @param scale Zoom scale
   */
  const zoomElement = useCallback((elementId: string, scale: number) => {
    useCanvasStore.getState().setZoom(elementId, scale);
  }, []);

  /**
   * Clear zoom
   */
  const clearZoom = useCallback(() => {
    useCanvasStore.getState().clearZoom();
  }, []);

  /**
   * Clear all teaching effects (spotlight + highlight + laser + zoom)
   */
  const clearAllEffects = useCallback(() => {
    useCanvasStore.getState().clearSpotlight();
    useCanvasStore.getState().clearHighlight();
    useCanvasStore.getState().clearLaser();
    useCanvasStore.getState().clearZoom();
  }, []);

  return {
    // Basic operations
    addElement,
    deleteElement,
    deleteAllElements,
    updateElement,
    updateSlide,
    removeElementProps,
    copyElement,
    pasteElement,
    cutElement,

    // Advanced operations
    lockElement,
    unlockElement,
    selectAllElements,
    selectElement,
    alignElementToCanvas,
    orderElement,
    combineElements,
    uncombineElements,

    // Canvas operations
    updateBackground,
    updateTheme,

    // Teaching features
    spotlightElement,
    clearSpotlight,
    highlightElements,
    clearHighlight,
    laserElement,
    clearLaser,
    zoomElement,
    clearZoom,
    clearAllEffects,
  };
}

// Export type
export type CanvasOperations = ReturnType<typeof useCanvasOperations>;
