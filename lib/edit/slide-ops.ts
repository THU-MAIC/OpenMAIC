import { produce } from 'immer';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, Slide } from '@/lib/types/slides';

type ElementPatch = Partial<PPTElement>;
type ElementPropName = string;

export type SlideElementAlignCommand =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'vertical'
  | 'horizontal'
  | 'center';

export type SlideEditOperation =
  | {
      type: 'slide.update';
      patch: Partial<Slide>;
    }
  | {
      type: 'element.add';
      element: PPTElement;
      index?: number;
    }
  | {
      type: 'element.update';
      elementId: string;
      patch: ElementPatch;
    }
  | {
      type: 'element.updateMany';
      elementIds: string[];
      patch: ElementPatch;
    }
  | {
      type: 'element.delete';
      elementId: string;
    }
  | {
      type: 'element.deleteMany';
      elementIds: string[];
    }
  | {
      type: 'element.reorder';
      elementId: string;
      index: number;
    }
  | {
      type: 'element.duplicate';
      elementIds: string[];
      idMap: Record<string, string>;
      offset?: {
        x: number;
        y: number;
      };
    }
  | {
      type: 'element.align';
      elementIds: string[];
      command: SlideElementAlignCommand;
    }
  | {
      type: 'element.removeProps';
      elementId: string;
      propNames: ElementPropName[];
    }
  | {
      type: 'text.updateContent';
      elementId: string;
      content: string;
    };

export interface SlideEditHistory {
  past: SlideContent[];
  present: SlideContent;
  future: SlideContent[];
}

export function createSlideEditHistory(initial: SlideContent): SlideEditHistory {
  return {
    past: [],
    present: cloneSlideContent(initial),
    future: [],
  };
}

export function applySlideEditOperation(
  content: SlideContent,
  operation: SlideEditOperation,
): SlideContent;
export function applySlideEditOperation(
  history: SlideEditHistory,
  operation: SlideEditOperation,
): SlideEditHistory;
export function applySlideEditOperation(
  target: SlideContent | SlideEditHistory,
  operation: SlideEditOperation,
): SlideContent | SlideEditHistory {
  if (isSlideEditHistory(target)) {
    const next = applyOperationToContent(target.present, operation);
    return {
      past: [...target.past, cloneSlideContent(target.present)],
      present: next,
      future: [],
    };
  }

  return applyOperationToContent(target, operation);
}

export function undoSlideEditOperation(history: SlideEditHistory): SlideEditHistory {
  if (history.past.length === 0) return history;

  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: cloneSlideContent(previous),
    future: [cloneSlideContent(history.present), ...history.future],
  };
}

export function redoSlideEditOperation(history: SlideEditHistory): SlideEditHistory {
  if (history.future.length === 0) return history;

  const next = history.future[0];
  return {
    past: [...history.past, cloneSlideContent(history.present)],
    present: cloneSlideContent(next),
    future: history.future.slice(1),
  };
}

function applyOperationToContent(
  content: SlideContent,
  operation: SlideEditOperation,
): SlideContent {
  return produce(content, (draft) => {
    switch (operation.type) {
      case 'slide.update':
        Object.assign(draft.canvas, operation.patch);
        return;
      case 'element.add': {
        const index =
          typeof operation.index === 'number'
            ? Math.max(0, Math.min(operation.index, draft.canvas.elements.length))
            : draft.canvas.elements.length;
        draft.canvas.elements.splice(index, 0, cloneElement(operation.element));
        return;
      }
      case 'element.update': {
        const element = draft.canvas.elements.find((item) => item.id === operation.elementId);
        if (!element) return;
        Object.assign(element, operation.patch);
        return;
      }
      case 'element.updateMany': {
        const elementIds = new Set(operation.elementIds);
        draft.canvas.elements.forEach((element) => {
          if (elementIds.has(element.id)) Object.assign(element, operation.patch);
        });
        return;
      }
      case 'element.delete':
        draft.canvas.elements = draft.canvas.elements.filter(
          (element) => element.id !== operation.elementId,
        );
        if (draft.canvas.animations) {
          draft.canvas.animations = draft.canvas.animations.filter(
            (animation) => animation.elId !== operation.elementId,
          );
        }
        return;
      case 'element.deleteMany': {
        const elementIds = new Set(operation.elementIds);
        draft.canvas.elements = draft.canvas.elements.filter((element) => !elementIds.has(element.id));
        if (draft.canvas.animations) {
          draft.canvas.animations = draft.canvas.animations.filter(
            (animation) => !elementIds.has(animation.elId),
          );
        }
        return;
      }
      case 'element.reorder': {
        const currentIndex = draft.canvas.elements.findIndex(
          (element) => element.id === operation.elementId,
        );
        if (currentIndex === -1) return;

        const [element] = draft.canvas.elements.splice(currentIndex, 1);
        const nextIndex = Math.max(0, Math.min(operation.index, draft.canvas.elements.length));
        draft.canvas.elements.splice(nextIndex, 0, element);
        return;
      }
      case 'element.duplicate': {
        const offset = operation.offset ?? { x: 20, y: 20 };
        const elementIds = new Set(operation.elementIds);
        const duplicatedElements = draft.canvas.elements
          .filter((element) => elementIds.has(element.id) && operation.idMap[element.id])
          .map((element) => ({
            ...cloneElement(element),
            id: operation.idMap[element.id],
            left: element.left + offset.x,
            top: element.top + offset.y,
          }));

        draft.canvas.elements.push(...duplicatedElements);
        return;
      }
      case 'element.align': {
        alignElementsToCanvas(draft.canvas, operation.elementIds, operation.command);
        return;
      }
      case 'element.removeProps': {
        const element = draft.canvas.elements.find((item) => item.id === operation.elementId);
        if (!element) return;
        operation.propNames.forEach((propName) => {
          delete (element as Record<string, unknown>)[propName];
        });
        return;
      }
      case 'text.updateContent': {
        const element = draft.canvas.elements.find((item) => item.id === operation.elementId);
        if (!element || element.type !== 'text') return;
        element.content = operation.content;
        return;
      }
    }
  });
}

function isSlideEditHistory(target: SlideContent | SlideEditHistory): target is SlideEditHistory {
  return 'present' in target && 'past' in target && 'future' in target;
}

function cloneSlideContent(content: SlideContent): SlideContent {
  return structuredClone(content);
}

function cloneElement(element: PPTElement): PPTElement {
  return JSON.parse(JSON.stringify(element)) as PPTElement;
}

function alignElementsToCanvas(
  slide: Slide,
  elementIds: string[],
  command: SlideElementAlignCommand,
) {
  const selectedIds = new Set(elementIds);
  const selectedElements = slide.elements.filter((element) => selectedIds.has(element.id));
  if (selectedElements.length === 0) return;

  const range = getElementListRange(selectedElements);
  const viewportWidth = slide.viewportSize;
  const viewportHeight = slide.viewportSize * slide.viewportRatio;

  let offsetX = 0;
  let offsetY = 0;

  switch (command) {
    case 'center':
      offsetX = range.minX + (range.maxX - range.minX) / 2 - viewportWidth / 2;
      offsetY = range.minY + (range.maxY - range.minY) / 2 - viewportHeight / 2;
      break;
    case 'top':
      offsetY = range.minY;
      break;
    case 'vertical':
      offsetY = range.minY + (range.maxY - range.minY) / 2 - viewportHeight / 2;
      break;
    case 'bottom':
      offsetY = range.maxY - viewportHeight;
      break;
    case 'left':
      offsetX = range.minX;
      break;
    case 'horizontal':
      offsetX = range.minX + (range.maxX - range.minX) / 2 - viewportWidth / 2;
      break;
    case 'right':
      offsetX = range.maxX - viewportWidth;
      break;
  }

  slide.elements.forEach((element) => {
    if (!selectedIds.has(element.id)) return;
    element.left -= offsetX;
    element.top -= offsetY;
  });
}

function getElementListRange(elements: PPTElement[]) {
  return elements.reduce(
    (range, element) => ({
      minX: Math.min(range.minX, element.left),
      maxX: Math.max(range.maxX, element.left + element.width),
      minY: Math.min(range.minY, element.top),
      maxY: Math.max(range.maxY, element.top + ('height' in element ? element.height : 0)),
    }),
    {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    },
  );
}
