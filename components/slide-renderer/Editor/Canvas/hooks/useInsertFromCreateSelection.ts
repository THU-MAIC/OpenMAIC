import { useCallback, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { CreateElementSelectionData } from '@/lib/types/edit';

export function useInsertFromCreateSelection(viewportRef: RefObject<HTMLElement | null>) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const creatingElement = useCanvasStore.use.creatingElement();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();

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
          // TODO: Implement createTextElement
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
    [creatingElement, formatCreateSelection, formatCreateSelectionForLine, setCreatingElement],
  );

  return {
    formatCreateSelection,
    insertElementFromCreateSelection,
  };
}
