import { useCallback, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';
import { createElementId } from '@/lib/edit/element-id';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import type { CreateElementSelectionData } from '@/lib/types/edit';
import type { PPTTextElement } from '@maic/dsl';

// Click-fallback default size when the user clicks instead of drags (or wobbles
// under this in either dimension): a sensibly-sized text box at the start point.
const TEXT_CLICK_MIN = 24;
const TEXT_DEFAULT_W = 300;
const TEXT_DEFAULT_H = 60;
// Empty centered paragraph — caret-ready, no placeholder text to delete.
const EMPTY_TEXT_CONTENT = '<p style="text-align: center"><br></p>';

export function useInsertFromCreateSelection(viewportRef: RefObject<HTMLElement | null>) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const creatingElement = useCanvasStore.use.creatingElement();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();
  const { addElement } = useCanvasOperations();

  // Calculate selection position and size from the start and end points of mouse drag selection
  const formatCreateSelection = useCallback(
    (selectionData: CreateElementSelectionData) => {
      const { start, end } = selectionData;

      if (!viewportRef.current) return;
      const viewportRect = viewportRef.current.getBoundingClientRect();

      const [startX, startY] = start;
      const [endX, endY] = end;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const minY = Math.min(startY, endY);
      const maxY = Math.max(startY, endY);

      const left = (minX - viewportRect.x) / canvasScale;
      const top = (minY - viewportRect.y) / canvasScale;
      const width = (maxX - minX) / canvasScale;
      const height = (maxY - minY) / canvasScale;

      return { left, top, width, height };
    },
    [viewportRef, canvasScale],
  );

  // Calculate line position and start/end points on canvas from the start and end points of mouse drag selection
  const formatCreateSelectionForLine = useCallback(
    (selectionData: CreateElementSelectionData) => {
      const { start, end } = selectionData;

      if (!viewportRef.current) return;
      const viewportRect = viewportRef.current.getBoundingClientRect();

      const [startX, startY] = start;
      const [endX, endY] = end;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const minY = Math.min(startY, endY);
      const maxY = Math.max(startY, endY);

      const left = (minX - viewportRect.x) / canvasScale;
      const top = (minY - viewportRect.y) / canvasScale;
      const width = (maxX - minX) / canvasScale;
      const height = (maxY - minY) / canvasScale;

      const _start: [number, number] = [startX === minX ? 0 : width, startY === minY ? 0 : height];
      const _end: [number, number] = [endX === minX ? 0 : width, endY === minY ? 0 : height];

      return {
        left,
        top,
        start: _start,
        end: _end,
      };
    },
    [viewportRef, canvasScale],
  );

  // Insert element based on mouse selection position and size
  const insertElementFromCreateSelection = useCallback(
    (selectionData: CreateElementSelectionData) => {
      if (!creatingElement) return;

      const type = creatingElement.type;
      if (type === 'text') {
        const position = formatCreateSelection(selectionData);
        if (position) {
          // Click (or a sub-threshold wobble) → default-sized box at the start
          // point. A real drag → the dragged rect. Either way addElement
          // auto-selects, which the slide surface picks up to open the
          // AnchoredTextBar on the new element.
          //
          // Why not surface-side `applyOp({type:'element.add'})` like the
          // image insert in `use-slide-surface.ts`? The rect math lives here
          // (canvas-coord conversion from the pointer gesture), and
          // `addElement` routes through SceneController → slide-edit-session,
          // so the content commit ends up in the same store either way. The
          // tradeoff: this lane doesn't show as a typed `element.add` op in
          // the session history, just an immer snapshot. Acceptable for a
          // text-insert; image insert uses the typed op because its source
          // is the ImagePicker, not a canvas gesture.
          const width = position.width < TEXT_CLICK_MIN ? TEXT_DEFAULT_W : position.width;
          const height = position.height < TEXT_CLICK_MIN ? TEXT_DEFAULT_H : position.height;
          const textEl: PPTTextElement = {
            id: createElementId('text'),
            type: 'text',
            left: position.left,
            top: position.top,
            width,
            height,
            rotate: 0,
            content: EMPTY_TEXT_CONTENT,
            defaultFontName: '',
            defaultColor: '#333',
          };
          addElement(textEl);
        }
      } else if (type === 'shape') {
        const position = formatCreateSelection(selectionData);
        if (position) {
          // TODO: Implement createShapeElement
        }
      } else if (type === 'line') {
        const position = formatCreateSelectionForLine(selectionData);
        if (position) {
          // TODO: Implement createLineElement
        }
      }
      setCreatingElement(null);
    },
    [
      creatingElement,
      formatCreateSelection,
      formatCreateSelectionForLine,
      setCreatingElement,
      addElement,
    ],
  );

  return {
    formatCreateSelection,
    insertElementFromCreateSelection,
  };
}
