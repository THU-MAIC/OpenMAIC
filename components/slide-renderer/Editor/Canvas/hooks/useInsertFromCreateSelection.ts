import { useCallback, type RefObject } from 'react';
import { nanoid } from 'nanoid';
import { useCanvasStore } from '@/lib/store';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import type { SlideContent } from '@/lib/types/stage';
import type { SlideTheme, PPTTextElement, PPTShapeElement, PPTLineElement } from '@/lib/types/slides';
import type { CreateElementSelectionData } from '@/lib/types/edit';

export function useInsertFromCreateSelection(viewportRef: RefObject<HTMLElement | null>) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const creatingElement = useCanvasStore.use.creatingElement();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();
  const theme = useSceneSelector<SlideContent, SlideTheme>((content) => content.canvas.theme);
  const { addElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

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
          const newElement: PPTTextElement = {
            type: 'text',
            id: nanoid(10),
            left: position.left,
            top: position.top,
            width: Math.max(position.width, 50),
            height: Math.max(position.height, 30),
            rotate: 0,
            content: '<p><br/></p>',
            defaultFontName: theme?.fontName ?? 'Microsoft YaHei',
            defaultColor: theme?.fontColor ?? '#333333',
          };
          addElement(newElement);
          addHistorySnapshot();
        }
      } else if (type === 'shape') {
        const position = formatCreateSelection(selectionData);
        if (position) {
          const shapeData = creatingElement.data;
          const themeColor = theme?.themeColors?.[0] ?? '#4B9CDC';
          const newElement: PPTShapeElement = {
            type: 'shape',
            id: nanoid(10),
            left: position.left,
            top: position.top,
            width: Math.max(position.width, 20),
            height: Math.max(position.height, 20),
            rotate: 0,
            viewBox: shapeData.viewBox,
            path: shapeData.path,
            fixedRatio: false,
            fill: themeColor,
            special: shapeData.special,
            pathFormula: shapeData.pathFormula,
          };
          addElement(newElement);
          addHistorySnapshot();
        }
      } else if (type === 'line') {
        const position = formatCreateSelectionForLine(selectionData);
        if (position) {
          const lineData = creatingElement.data;
          const w = Math.abs(position.end[0] - position.start[0]);
          const h = Math.abs(position.end[1] - position.start[1]);
          const newElement: PPTLineElement = {
            type: 'line',
            id: nanoid(10),
            left: position.left,
            top: position.top,
            width: Math.max(w, 20),
            start: position.start,
            end: position.end,
            style: lineData.style,
            color: theme?.fontColor ?? '#333333',
            points: lineData.points,
            broken: lineData.isBroken ? [w / 2, h / 2] : undefined,
            broken2: lineData.isBroken2 ? [w / 3, 0] : undefined,
            curve: lineData.isCurve ? [position.start[0], position.end[1]] : undefined,
            cubic: lineData.isCubic
              ? [
                  [w / 3, 0],
                  [(w * 2) / 3, h],
                ]
              : undefined,
          };
          addElement(newElement);
          addHistorySnapshot();
        }
      }
      setCreatingElement(null);
    },
    [
      creatingElement,
      formatCreateSelection,
      formatCreateSelectionForLine,
      setCreatingElement,
      theme,
      addElement,
      addHistorySnapshot,
    ],
  );

  return {
    formatCreateSelection,
    insertElementFromCreateSelection,
  };
}
