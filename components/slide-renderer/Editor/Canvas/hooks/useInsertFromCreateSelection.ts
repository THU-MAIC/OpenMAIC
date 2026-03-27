import { useCallback, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import type { CreateElementSelectionData, CreatingTextElement, CreatingShapeElement, CreatingLineElement } from '@/lib/types/edit';
import type { PPTTextElement, PPTShapeElement, PPTLineElement } from '@/lib/types/slides';
import { nanoid } from 'nanoid';

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

  const createTextElement = useCallback(
    (position: { left: number; top: number; width: number; height: number }, creating: CreatingTextElement) => {
      const element: PPTTextElement = {
        id: nanoid(10),
        type: 'text',
        left: position.left,
        top: position.top,
        width: Math.max(position.width, 50),
        height: Math.max(position.height, 30),
        rotate: 0,
        content: '<p><br></p>',
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
        vertical: creating.vertical,
      };
      addElement(element);
    },
    [addElement],
  );

  const createShapeElement = useCallback(
    (position: { left: number; top: number; width: number; height: number }, creating: CreatingShapeElement) => {
      const { data } = creating;
      const element: PPTShapeElement = {
        id: nanoid(10),
        type: 'shape',
        left: position.left,
        top: position.top,
        width: Math.max(position.width, 30),
        height: Math.max(position.height, 30),
        rotate: 0,
        viewBox: data.viewBox,
        path: data.path,
        fill: '#5b9bd5',
        fixedRatio: false,
        special: data.special,
        pathFormula: data.pathFormula,
      };
      addElement(element);
    },
    [addElement],
  );

  const createLineElement = useCallback(
    (position: { left: number; top: number; start: [number, number]; end: [number, number] }, creating: CreatingLineElement) => {
      const { data } = creating;
      const element: PPTLineElement = {
        id: nanoid(10),
        type: 'line',
        left: position.left,
        top: position.top,
        width: 2,
        start: position.start,
        end: position.end,
        style: data.style,
        color: '#333333',
        points: data.points,
      };
      addElement(element);
    },
    [addElement],
  );

  // Insert element based on mouse selection position and size
  const insertElementFromCreateSelection = useCallback(
    (selectionData: CreateElementSelectionData) => {
      if (!creatingElement) return;

      const type = creatingElement.type;
      if (type === 'text') {
        const position = formatCreateSelection(selectionData);
        if (position) {
          createTextElement(position, creatingElement as CreatingTextElement);
        }
      } else if (type === 'shape') {
        const position = formatCreateSelection(selectionData);
        if (position) {
          createShapeElement(position, creatingElement as CreatingShapeElement);
        }
      } else if (type === 'line') {
        const position = formatCreateSelectionForLine(selectionData);
        if (position) {
          createLineElement(position, creatingElement as CreatingLineElement);
        }
      }
      setCreatingElement(null);
    },
    [creatingElement, formatCreateSelection, formatCreateSelectionForLine, setCreatingElement, createTextElement, createShapeElement, createLineElement],
  );

  return {
    formatCreateSelection,
    insertElementFromCreateSelection,
  };
}
