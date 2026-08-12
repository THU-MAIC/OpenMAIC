import { isPPTElementType, type PPTElement, type Slide, type SlideContent } from '@openmaic/dsl';

export const MAX_EDITOR_HISTORY = 50;

export type ElementPatch<T extends PPTElement = PPTElement> = T extends PPTElement
  ? Omit<Partial<T>, 'id' | 'type'>
  : never;

const IMMUTABLE_ELEMENT_PROPERTIES = new Set(['id', 'type']);
const IMMUTABLE_SLIDE_PROPERTIES = new Set(['id']);
type FieldKind = 'string' | 'number' | 'boolean' | 'array' | 'object';

const REQUIRED_SLIDE_FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  id: 'string',
  viewportSize: 'number',
  viewportRatio: 'number',
  theme: 'object',
};
const REQUIRED_BOX_FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  id: 'string',
  left: 'number',
  top: 'number',
  width: 'number',
  height: 'number',
  rotate: 'number',
};
const REQUIRED_ELEMENT_FIELD_KINDS: Record<
  PPTElement['type'],
  Readonly<Record<string, FieldKind>>
> = {
  text: {
    ...REQUIRED_BOX_FIELD_KINDS,
    content: 'string',
    defaultFontName: 'string',
    defaultColor: 'string',
  },
  image: { ...REQUIRED_BOX_FIELD_KINDS, fixedRatio: 'boolean', src: 'string' },
  shape: {
    ...REQUIRED_BOX_FIELD_KINDS,
    viewBox: 'array',
    path: 'string',
    fixedRatio: 'boolean',
    fill: 'string',
  },
  line: {
    id: 'string',
    left: 'number',
    top: 'number',
    width: 'number',
    start: 'array',
    end: 'array',
    style: 'string',
    color: 'string',
    points: 'array',
  },
  chart: { ...REQUIRED_BOX_FIELD_KINDS, chartType: 'string', data: 'object', themeColors: 'array' },
  table: {
    ...REQUIRED_BOX_FIELD_KINDS,
    outline: 'object',
    colWidths: 'array',
    cellMinHeight: 'number',
    data: 'array',
  },
  latex: { ...REQUIRED_BOX_FIELD_KINDS, latex: 'string' },
  video: { ...REQUIRED_BOX_FIELD_KINDS, autoplay: 'boolean' },
  audio: {
    ...REQUIRED_BOX_FIELD_KINDS,
    fixedRatio: 'boolean',
    color: 'string',
    loop: 'boolean',
    autoplay: 'boolean',
    src: 'string',
  },
  code: { ...REQUIRED_BOX_FIELD_KINDS, language: 'string', lines: 'array' },
};

export type EditorTransactionOrigin = 'canvas' | 'toolbar' | 'agent' | 'system';
export type EditorHistoryMode = 'record' | 'neutral' | 'navigate';
export type SlideElementAlignCommand =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'vertical'
  | 'horizontal'
  | 'center';

export type EditorOperation =
  | { type: 'slide.update'; patch: Omit<Partial<Slide>, 'id' | 'elements' | 'animations'> }
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

/**
 * Bounded UI gesture vocabulary. Editors may emit these while interacting with a
 * canvas; this core module is the only place that translates them into canonical
 * document operations.
 */
export type ReorderCommand = 'front' | 'back' | 'forward' | 'backward';
export type AlignCommand = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export type EditIntent =
  | { type: 'slide.update'; props: Omit<Partial<Slide>, 'id' | 'elements' | 'animations'> }
  | { type: 'element.update'; id: string; props: Partial<PPTElement> }
  | { type: 'element.updateMany'; updates: Array<{ id: string; props: Partial<PPTElement> }> }
  | { type: 'element.add'; element: PPTElement; index?: number }
  | { type: 'element.delete'; ids: string[] }
  | { type: 'element.reorder'; id: string; command: ReorderCommand }
  | { type: 'element.align'; ids: string[]; command: AlignCommand }
  | { type: 'element.removeProps'; id: string; props: string[] }
  | { type: 'text.updateContent'; id: string; content: string; target: 'text' | 'shape' }
  | { type: 'table.updateCell'; id: string; cellId: string; text: string };

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

/**
 * Compiles UI edit intents using a private working snapshot. Advancing that
 * snapshot between intents makes a batch deterministic while keeping all
 * document mutation semantics in the editor package.
 */
export function compileEditorEditIntents(
  content: SlideContent,
  intents: readonly EditIntent[],
): EditorOperation[] {
  let working = content;
  const compiled: EditorOperation[] = [];

  const append = (operations: EditorOperation[]) => {
    if (operations.length === 0) return;
    working = applyEditorTransaction(
      working,
      createEditorTransaction({ origin: 'system', history: 'neutral', operations }),
    );
    compiled.push(...operations);
  };

  for (const intent of intents) {
    const elements = working.canvas.elements;
    switch (intent.type) {
      case 'slide.update':
        append([{ type: 'slide.update', patch: intent.props }]);
        break;
      case 'element.update': {
        if (!elements.some((element) => element.id === intent.id)) break;
        append([{ type: 'element.update', elementId: intent.id, patch: intent.props }]);
        break;
      }
      case 'element.updateMany': {
        const updates = intent.updates
          .filter((update) => elements.some((element) => element.id === update.id))
          .map((update) => ({ elementId: update.id, patch: update.props }));
        if (updates.length > 0) append([{ type: 'element.updateMany', updates }]);
        break;
      }
      case 'element.add':
        append([{ type: 'element.add', element: intent.element, index: intent.index }]);
        break;
      case 'element.delete': {
        const elementIds = intent.ids.filter((id) => elements.some((element) => element.id === id));
        if (elementIds.length > 0) append([{ type: 'element.deleteMany', elementIds }]);
        break;
      }
      case 'element.reorder': {
        const index = resolveReorderIndex(elements, intent.id, intent.command);
        if (index !== null) append([{ type: 'element.reorder', elementId: intent.id, index }]);
        break;
      }
      case 'element.align': {
        const elementIds = intent.ids.filter((id) => elements.some((element) => element.id === id));
        if (elementIds.length === 0) break;
        append([
          {
            type: 'element.align',
            elementIds,
            command:
              intent.command === 'center'
                ? 'horizontal'
                : intent.command === 'middle'
                  ? 'vertical'
                  : intent.command,
          },
        ]);
        break;
      }
      case 'element.removeProps':
        if (elements.some((element) => element.id === intent.id)) {
          append([{ type: 'element.removeProps', elementId: intent.id, propNames: intent.props }]);
        }
        break;
      case 'text.updateContent': {
        const element = elements.find((candidate) => candidate.id === intent.id);
        if (intent.target === 'text' && element?.type === 'text') {
          append([{ type: 'text.updateContent', elementId: intent.id, content: intent.content }]);
        } else if (intent.target === 'shape' && element?.type === 'shape') {
          append([
            { type: 'shape.updateTextContent', elementId: intent.id, content: intent.content },
          ]);
        }
        break;
      }
      case 'table.updateCell': {
        const element = elements.find((candidate) => candidate.id === intent.id);
        if (
          element?.type === 'table' &&
          element.data.some((row) => row.some((cell) => cell.id === intent.cellId))
        ) {
          append([
            {
              type: 'table.updateCell',
              elementId: intent.id,
              cellId: intent.cellId,
              text: intent.text,
            },
          ]);
        }
        break;
      }
    }
  }

  return compiled;
}

/** Creates one host-ready transaction for a completed canvas gesture. */
export function createEditorTransactionFromIntents({
  content,
  intents,
  origin = 'canvas',
  history = 'record',
}: {
  readonly content: SlideContent;
  readonly intents: readonly EditIntent[];
  readonly origin?: EditorTransactionOrigin;
  readonly history?: EditorHistoryMode;
}): EditorTransaction | null {
  const operations = compileEditorEditIntents(content, intents);
  return operations.length === 0 ? null : createEditorTransaction({ origin, history, operations });
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
    if (transaction.history === 'navigate') {
      const matches = (snapshot: SlideContent) =>
        matchesNavigationTarget(snapshot, next, transaction.operations);
      const pastIndex = findLastMatchingIndex(target.past, matches);
      if (pastIndex >= 0) {
        return {
          past: target.past.slice(0, pastIndex),
          present: next,
          future: [...target.past.slice(pastIndex + 1), target.present, ...target.future],
        };
      }
      const futureIndex = target.future.findIndex(matches);
      if (futureIndex >= 0) {
        return {
          past: capHistory([
            ...target.past,
            target.present,
            ...target.future.slice(0, futureIndex),
          ]),
          present: next,
          future: target.future.slice(futureIndex + 1),
        };
      }
      return { ...target, present: next, future: [] };
    }
    if (transaction.history === 'neutral') return { ...target, present: next, future: [] };
    return {
      past: capHistory([...target.past, target.present]),
      present: next,
      future: [],
    };
  }
  return applyToContent(target, transaction.operations);
}

function sameContent(left: SlideContent, right: SlideContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findLastMatchingIndex<T>(values: readonly T[], matches: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (matches(values[index])) return index;
  }
  return -1;
}

function matchesNavigationTarget(
  snapshot: SlideContent,
  next: SlideContent,
  operations: readonly EditorOperation[],
): boolean {
  if (sameContent(snapshot, next)) return true;
  return operations.every((operation) => {
    const element =
      'elementId' in operation
        ? snapshot.canvas.elements.find((candidate) => candidate.id === operation.elementId)
        : undefined;
    switch (operation.type) {
      case 'text.updateContent':
        return element?.type === 'text' && element.content === operation.content;
      case 'shape.updateTextContent':
        return element?.type === 'shape' && element.text?.content === operation.content;
      case 'table.updateCell':
        return (
          element?.type === 'table' &&
          element.data
            .flat()
            .some((cell) => cell.id === operation.cellId && cell.text === operation.text)
        );
      default:
        return false;
    }
  });
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

function resolveReorderIndex(
  elements: readonly PPTElement[],
  id: string,
  command: ReorderCommand,
): number | null {
  const currentIndex = elements.findIndex((element) => element.id === id);
  if (currentIndex === -1) return null;

  switch (command) {
    case 'front':
      return elements.length - 1;
    case 'back':
      return 0;
    case 'forward':
      return Math.min(elements.length - 1, currentIndex + 1);
    case 'backward':
      return Math.max(0, currentIndex - 1);
  }
}

function applyOperation(content: SlideContent, operation: EditorOperation): void {
  const elements = content.canvas.elements;
  switch (operation.type) {
    case 'slide.update': {
      assertMutableSlidePatch(operation.patch);
      Object.assign(content.canvas, operation.patch);
      return;
    }
    case 'element.add': {
      const element = requireValidElement(operation.type, operation.element);
      if (elements.some((candidate) => candidate.id === element.id)) {
        throw new Error(`element.add: id "${element.id}" already exists`);
      }
      const index = clampIndex(operation.index ?? elements.length, elements.length);
      elements.splice(index, 0, clone(element));
      return;
    }
    case 'element.update': {
      const element = requireElement(elements, operation.elementId, operation.type);
      assertMutableElementPatch(operation.type, element, operation.patch);
      Object.assign(element, operation.patch);
      return;
    }
    case 'element.updateMany': {
      for (const update of operation.updates) {
        const element = requireElement(elements, update.elementId, operation.type);
        assertMutableElementPatch(operation.type, element, update.patch);
        Object.assign(element, update.patch);
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
      const element = requireElement(elements, operation.elementId, operation.type);
      for (const propName of operation.propNames) {
        if (IMMUTABLE_ELEMENT_PROPERTIES.has(propName)) {
          throw new Error(
            `${operation.type} cannot remove immutable property ${JSON.stringify(propName)}`,
          );
        }
        if (propName in REQUIRED_ELEMENT_FIELD_KINDS[element.type]) {
          throw new Error(
            `${operation.type} cannot remove required property ${JSON.stringify(propName)} from ${element.type} elements`,
          );
        }
      }
      const mutableElement = element as unknown as Record<string, unknown>;
      for (const propName of operation.propNames) delete mutableElement[propName];
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

function assertMutableElementPatch(operation: string, element: PPTElement, patch: object): void {
  const values = requireRecord(`${operation} patch`, patch);
  for (const property of Object.keys(values)) {
    if (IMMUTABLE_ELEMENT_PROPERTIES.has(property)) {
      throw new Error(`${operation} cannot mutate immutable property ${JSON.stringify(property)}`);
    }
  }
  assertRequiredPatchValues(operation, REQUIRED_ELEMENT_FIELD_KINDS[element.type], values);
}

function assertMutableSlidePatch(patch: object): void {
  const values = requireRecord('slide.update patch', patch);
  for (const property of Object.keys(values)) {
    if (IMMUTABLE_SLIDE_PROPERTIES.has(property)) {
      throw new Error(`slide.update cannot mutate immutable property ${JSON.stringify(property)}`);
    }
    if (property === 'elements' || property === 'animations') {
      throw new Error('slide.update cannot mutate elements or animations');
    }
  }
  assertRequiredPatchValues('slide.update', REQUIRED_SLIDE_FIELD_KINDS, values);
}

function requireValidElement(operation: string, value: unknown): PPTElement {
  const element = requireRecord(`${operation} element`, value);
  if (!isPPTElementType(element.type)) {
    throw new Error(`${operation} requires a supported element type`);
  }
  assertRequiredElementFields(operation, element.type, element);
  return element as unknown as PPTElement;
}

export function isValidEditorElement(value: unknown): value is PPTElement {
  try {
    requireValidElement('element', value);
    return true;
  } catch {
    return false;
  }
}

function assertRequiredElementFields(
  operation: string,
  type: PPTElement['type'],
  element: Readonly<Record<string, unknown>>,
): void {
  for (const [property, kind] of Object.entries(REQUIRED_ELEMENT_FIELD_KINDS[type])) {
    if (!matchesFieldKind(element[property], kind)) {
      throw new Error(`${operation} requires ${kind} property ${JSON.stringify(property)}`);
    }
  }
}

function assertRequiredPatchValues(
  operation: string,
  requiredFieldKinds: Readonly<Record<string, FieldKind>>,
  patch: Readonly<Record<string, unknown>>,
): void {
  for (const [property, value] of Object.entries(patch)) {
    const kind = requiredFieldKinds[property];
    if (!kind) continue;
    if (value === undefined) {
      throw new Error(
        `${operation} cannot set required property ${JSON.stringify(property)} to undefined`,
      );
    }
    if (!matchesFieldKind(value, kind)) {
      throw new Error(
        `${operation} must set required property ${JSON.stringify(property)} to ${kind}`,
      );
    }
  }
}

function requireRecord(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function matchesFieldKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'object')
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === kind;
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
  for (const id of new Set(elementIds)) requireElement(slide.elements, id, 'element.align');
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
