import type { PPTElement, Slide, SlideContent } from '@openmaic/dsl';

export const MAX_EDITOR_HISTORY = 50;

export type ElementPatch<T extends PPTElement = PPTElement> = T extends PPTElement
  ? Omit<Partial<T>, 'id' | 'type'>
  : never;

const IMMUTABLE_ELEMENT_PROPERTIES = new Set(['id', 'type']);

export type EditorTransactionOrigin = 'canvas' | 'toolbar' | 'agent' | 'system';
export type EditorHistoryMode = 'record' | 'neutral';
export type SlideElementAlignCommand =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'vertical'
  | 'horizontal'
  | 'center';

export type EditorOperation =
  | { type: 'slide.update'; patch: Partial<Omit<Slide, 'elements' | 'animations'>> }
  | { type: 'element.add'; element: PPTElement; index?: number }
  | { type: 'element.update'; elementId: string; patch: ElementPatch }
  | {
      type: 'element.updateMany';
      updates: ReadonlyArray<{ readonly elementId: string; readonly patch: ElementPatch }>;
    }
  | { type: 'element.delete'; elementId: string }
  | { type: 'element.deleteMany'; elementIds: readonly string[] }
  | { type: 'element.reorder'; elementId: string; index: number }
  | {
      type: 'element.duplicate';
      elementIds: readonly string[];
      idMap: Readonly<Record<string, string>>;
      offset?: { readonly x: number; readonly y: number };
    }
  | { type: 'element.align'; elementIds: readonly string[]; command: SlideElementAlignCommand }
  | { type: 'element.removeProps'; elementId: string; propNames: readonly string[] }
  | { type: 'text.updateContent'; elementId: string; content: string }
  | { type: 'shape.updateTextContent'; elementId: string; content: string }
  | { type: 'table.updateCell'; elementId: string; cellId: string; text: string };

export interface EditorTransaction {
  readonly origin: EditorTransactionOrigin;
  readonly history: EditorHistoryMode;
  readonly operations: readonly EditorOperation[];
}

export interface EditorHistory {
  readonly past: readonly SlideContent[];
  readonly present: SlideContent;
  readonly future: readonly SlideContent[];
}

export function createEditorTransaction({
  origin,
  history = 'record',
  operations,
}: {
  readonly origin: EditorTransactionOrigin;
  readonly history?: EditorHistoryMode;
  readonly operations: readonly EditorOperation[];
}): EditorTransaction {
  if (operations.length === 0)
    throw new Error('Editor transaction must contain at least one operation');
  return { origin, history, operations: [...operations] };
}

export function createEditorHistory(content: SlideContent): EditorHistory {
  return { past: [], present: clone(content), future: [] };
}

export function applyEditorTransaction(
  content: SlideContent,
  transaction: EditorTransaction,
): SlideContent;
export function applyEditorTransaction(
  history: EditorHistory,
  transaction: EditorTransaction,
): EditorHistory;
export function applyEditorTransaction(
  target: SlideContent | EditorHistory,
  transaction: EditorTransaction,
): SlideContent | EditorHistory {
  if (isEditorHistory(target)) {
    const next = applyToContent(target.present, transaction.operations);
    if (next === target.present) return target;
    if (transaction.history === 'neutral') {
      return { ...target, present: next, future: [] };
    }
    return {
      past: capHistory([...target.past, target.present]),
      present: next,
      future: [],
    };
  }
  return applyToContent(target, transaction.operations);
}

export function undoEditorTransaction(history: EditorHistory): EditorHistory {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redoEditorTransaction(history: EditorHistory): EditorHistory {
  if (history.future.length === 0) return history;
  return {
    past: capHistory([...history.past, history.present]),
    present: history.future[0],
    future: history.future.slice(1),
  };
}

function applyToContent(
  content: SlideContent,
  operations: readonly EditorOperation[],
): SlideContent {
  // Every operation is applied to an isolated clone. A failed operation throws before
  // the clone is returned, so callers never observe a partially committed document.
  const next = clone(content);
  for (const operation of operations) applyOperation(next, operation);
  return JSON.stringify(next) === JSON.stringify(content) ? content : next;
}

function applyOperation(content: SlideContent, operation: EditorOperation): void {
  const elements = content.canvas.elements;
  switch (operation.type) {
    case 'slide.update': {
      if ('elements' in operation.patch || 'animations' in operation.patch) {
        throw new Error('slide.update cannot mutate elements or animations');
      }
      Object.assign(content.canvas, operation.patch);
      return;
    }
    case 'element.add': {
      if (elements.some((element) => element.id === operation.element.id)) {
        throw new Error(`element.add: id "${operation.element.id}" already exists`);
      }
      const index = clampIndex(operation.index ?? elements.length, elements.length);
      elements.splice(index, 0, clone(operation.element));
      return;
    }
    case 'element.update': {
      assertMutableElementPatch(operation.type, operation.patch);
      Object.assign(requireElement(elements, operation.elementId, operation.type), operation.patch);
      return;
    }
    case 'element.updateMany': {
      for (const update of operation.updates) {
        assertMutableElementPatch(operation.type, update.patch);
        Object.assign(requireElement(elements, update.elementId, operation.type), update.patch);
      }
      return;
    }
    case 'element.delete': {
      deleteElements(content, [operation.elementId], operation.type);
      return;
    }
    case 'element.deleteMany': {
      deleteElements(content, operation.elementIds, operation.type);
      return;
    }
    case 'element.reorder': {
      const currentIndex = elements.findIndex((element) => element.id === operation.elementId);
      if (currentIndex === -1) missingElement(operation.type, operation.elementId);
      const [element] = elements.splice(currentIndex, 1);
      elements.splice(clampIndex(operation.index, elements.length), 0, element);
      return;
    }
    case 'element.duplicate': {
      const sourceElements = operation.elementIds.map((id) =>
        requireElement(elements, id, operation.type),
      );
      const existingIds = new Set(elements.map((element) => element.id));
      for (const source of sourceElements) {
        const duplicateId = operation.idMap[source.id];
        if (!duplicateId) throw new Error(`element.duplicate: idMap is missing "${source.id}"`);
        if (existingIds.has(duplicateId)) {
          throw new Error(`element.duplicate: id "${duplicateId}" already exists`);
        }
        existingIds.add(duplicateId);
      }
      const offset = operation.offset ?? { x: 20, y: 20 };
      elements.push(
        ...sourceElements.map((source) => ({
          ...clone(source),
          id: operation.idMap[source.id],
          left: source.left + offset.x,
          top: source.top + offset.y,
        })),
      );
      return;
    }
    case 'element.align': {
      alignElements(content.canvas, operation.elementIds, operation.command);
      return;
    }
    case 'element.removeProps': {
      for (const propName of operation.propNames) {
        if (IMMUTABLE_ELEMENT_PROPERTIES.has(propName)) {
          throw new Error(
            `${operation.type} cannot remove immutable property ${JSON.stringify(propName)}`,
          );
        }
      }
      const element = requireElement(
        elements,
        operation.elementId,
        operation.type,
      ) as unknown as Record<string, unknown>;
      for (const propName of operation.propNames) delete element[propName];
      return;
    }
    case 'text.updateContent': {
      const element = requireElement(elements, operation.elementId, operation.type);
      if (element.type !== 'text') {
        throw new Error(`text.updateContent: element "${operation.elementId}" is not text`);
      }
      element.content = operation.content;
      return;
    }
    case 'shape.updateTextContent': {
      const element = requireElement(elements, operation.elementId, operation.type);
      if (element.type !== 'shape') {
        throw new Error(`shape.updateTextContent: element "${operation.elementId}" is not a shape`);
      }
      element.text = {
        align: 'middle',
        defaultColor: '#333333',
        defaultFontName: 'Microsoft YaHei',
        ...element.text,
        content: operation.content,
      };
      return;
    }
    case 'table.updateCell': {
      const element = requireElement(elements, operation.elementId, operation.type);
      if (element.type !== 'table') {
        throw new Error(`table.updateCell: element "${operation.elementId}" is not a table`);
      }
      const cell = element.data.flat().find((candidate) => candidate.id === operation.cellId);
      if (!cell) throw new Error(`table.updateCell: cell "${operation.cellId}" does not exist`);
      cell.text = operation.text;
      return;
    }
  }
}

function assertMutableElementPatch(operation: string, patch: object): void {
  for (const property of Object.keys(patch)) {
    if (IMMUTABLE_ELEMENT_PROPERTIES.has(property)) {
      throw new Error(`${operation} cannot mutate immutable property ${JSON.stringify(property)}`);
    }
  }
}

function deleteElements(content: SlideContent, ids: readonly string[], operation: string): void {
  const targetIds = new Set(ids);
  for (const id of targetIds) requireElement(content.canvas.elements, id, operation);
  content.canvas.elements = content.canvas.elements.filter((element) => !targetIds.has(element.id));
  if (content.canvas.animations) {
    content.canvas.animations = content.canvas.animations.filter(
      (animation) => !targetIds.has(animation.elId),
    );
  }
}

function requireElement(
  elements: readonly PPTElement[],
  id: string,
  operation: string,
): PPTElement {
  const element = elements.find((candidate) => candidate.id === id);
  if (!element) missingElement(operation, id);
  return element;
}

function missingElement(operation: string, id: string): never {
  throw new Error(`${operation}: element "${id}" does not exist`);
}

function alignElements(
  slide: Slide,
  elementIds: readonly string[],
  command: SlideElementAlignCommand,
): void {
  const selected = slide.elements.filter((element) => elementIds.includes(element.id));
  if (selected.length === 0) throw new Error('element.align: no selected elements exist');
  const range = getElementListRange(selected);
  const viewportWidth = slide.viewportSize;
  const viewportHeight = viewportWidth * slide.viewportRatio;
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

  const selectedIds = new Set(elementIds);
  for (const element of slide.elements) {
    if (!selectedIds.has(element.id)) continue;
    element.left -= offsetX;
    element.top -= offsetY;
  }
}

function getElementListRange(elements: readonly PPTElement[]) {
  const ranges = elements.map(getElementRange);
  return {
    minX: Math.min(...ranges.map((range) => range.minX)),
    maxX: Math.max(...ranges.map((range) => range.maxX)),
    minY: Math.min(...ranges.map((range) => range.minY)),
    maxY: Math.max(...ranges.map((range) => range.maxY)),
  };
}

function getElementRange(element: PPTElement) {
  if (element.type === 'line') {
    return {
      minX: element.left,
      maxX: element.left + Math.max(element.start[0], element.end[0]),
      minY: element.top,
      maxY: element.top + Math.max(element.start[1], element.end[1]),
    };
  }
  if ('rotate' in element && element.rotate) {
    const radius = Math.hypot(element.width, element.height) / 2;
    const auxiliaryAngle = (Math.atan(element.height / element.width) * 180) / Math.PI;
    const tlbr = ((180 - element.rotate - auxiliaryAngle) * Math.PI) / 180;
    const trbl = ((auxiliaryAngle - element.rotate) * Math.PI) / 180;
    const middleLeft = element.left + element.width / 2;
    const middleTop = element.top + element.height / 2;
    const xAxis = [
      middleLeft + radius * Math.cos(tlbr),
      middleLeft + radius * Math.cos(trbl),
      middleLeft - radius * Math.cos(tlbr),
      middleLeft - radius * Math.cos(trbl),
    ];
    const yAxis = [
      middleTop - radius * Math.sin(tlbr),
      middleTop - radius * Math.sin(trbl),
      middleTop + radius * Math.sin(tlbr),
      middleTop + radius * Math.sin(trbl),
    ];
    return {
      minX: Math.min(...xAxis),
      maxX: Math.max(...xAxis),
      minY: Math.min(...yAxis),
      maxY: Math.max(...yAxis),
    };
  }
  return {
    minX: element.left,
    maxX: element.left + element.width,
    minY: element.top,
    maxY: element.top + element.height,
  };
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function isEditorHistory(target: SlideContent | EditorHistory): target is EditorHistory {
  return 'present' in target && 'past' in target && 'future' in target;
}

function capHistory(past: readonly SlideContent[]): SlideContent[] {
  return past.length > MAX_EDITOR_HISTORY ? past.slice(-MAX_EDITOR_HISTORY) : [...past];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
