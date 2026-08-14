import type { PPTElement, SlideContent } from '@openmaic/dsl';
import {
  createEditorTransactionFromIntents,
  isValidEditorElement,
  type AlignCommand,
  type EditorTransaction,
  type ReorderCommand,
} from '../core';
import type { Selection } from './types';
import {
  createClipboardPasteState,
  createElementClipboard,
  type ClipboardPasteState,
  type ElementClipboard,
} from './elementClipboard';

const CLIPBOARD_PASTE_OFFSET = 20;

export interface CanvasCommandArgs {
  readonly content: SlideContent;
  readonly selection: Selection;
  readonly hiddenElementIds?: readonly string[];
  readonly onTransaction: (transaction: EditorTransaction) => void;
  readonly onSelectionChange: (selection: Selection) => void;
  readonly createGroupId?: () => string;
  readonly createElementId?: (type: PPTElement['type']) => string;
  readonly clipboard?: ElementClipboard;
  readonly clipboardPasteState?: ClipboardPasteState;
}

export interface CanvasCommands {
  clearSelection: () => void;
  selectAll: () => void;
  deleteSelection: () => void;
  lockSelection: () => void;
  copySelection: () => Promise<void>;
  cutSelection: () => Promise<void>;
  pasteElements: () => Promise<void>;
  unlockTarget: (elementId: string) => void;
  toggleGroup: () => void;
  reorderTarget: (elementId: string, command: ReorderCommand) => void;
  alignSelection: (command: AlignCommand) => void;
}

function createId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10);
  return `${prefix}-${random ?? Math.random().toString(36).slice(2, 12)}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function groupUnit(elements: readonly PPTElement[], target: PPTElement): PPTElement[] {
  return target.groupId
    ? elements.filter((element) => element.groupId === target.groupId)
    : [target];
}

function adjacentUnitSize(
  elements: readonly PPTElement[],
  unit: readonly PPTElement[],
  direction: 'forward' | 'backward',
): number {
  const unitIds = new Set(unit.map((element) => element.id));
  const indexes = elements
    .map((element, index) => (unitIds.has(element.id) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return 0;
  const edgeIndex = direction === 'forward' ? Math.max(...indexes) + 1 : Math.min(...indexes) - 1;
  const adjacent = elements[edgeIndex];
  return adjacent
    ? adjacent.groupId
      ? elements.filter((element) => element.groupId === adjacent.groupId).length
      : 1
    : 0;
}

function reorderUnitIntents(
  elements: readonly PPTElement[],
  target: PPTElement,
  command: ReorderCommand,
) {
  const unit = groupUnit(elements, target);
  const unitIds = new Set(unit.map((element) => element.id));
  const indexes = elements
    .map((element, index) => (unitIds.has(element.id) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return [];
  if (command === 'front') {
    return Math.max(...indexes) === elements.length - 1
      ? []
      : unit.map((element) => ({ type: 'element.reorder' as const, id: element.id, command }));
  }
  if (command === 'back') {
    return Math.min(...indexes) === 0
      ? []
      : [...unit]
          .reverse()
          .map((element) => ({ type: 'element.reorder' as const, id: element.id, command }));
  }
  const repeat = adjacentUnitSize(elements, unit, command);
  if (repeat === 0) return [];
  const orderedUnit = command === 'forward' ? [...unit].reverse() : unit;
  return Array.from({ length: repeat }, () =>
    orderedUnit.map((element) => ({ type: 'element.reorder' as const, id: element.id, command })),
  ).flat();
}

function compactSelectionIntents(elements: readonly PPTElement[], selectedIds: readonly string[]) {
  const selectedSet = new Set(selectedIds);
  const selectedBlock = elements.filter((element) => selectedSet.has(element.id));
  let highestIndex = -1;
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    if (selectedSet.has(elements[index].id)) {
      highestIndex = index;
      break;
    }
  }
  if (selectedBlock.length < 2 || highestIndex === -1) return [];
  const desired = elements.filter((element) => !selectedSet.has(element.id));
  desired.splice(highestIndex - selectedBlock.length + 1, 0, ...selectedBlock);
  const workingIds = elements.map((element) => element.id);
  return desired.flatMap((element, targetIndex) => {
    const intents = [] as { type: 'element.reorder'; id: string; command: 'backward' }[];
    let currentIndex = workingIds.indexOf(element.id);
    while (currentIndex > targetIndex) {
      intents.push({ type: 'element.reorder', id: element.id, command: 'backward' });
      [workingIds[currentIndex - 1], workingIds[currentIndex]] = [
        workingIds[currentIndex],
        workingIds[currentIndex - 1],
      ];
      currentIndex -= 1;
    }
    return intents;
  });
}

export function createCanvasCommands({
  content,
  selection,
  hiddenElementIds = [],
  onTransaction,
  onSelectionChange,
  createGroupId = () => createId('group'),
  createElementId = (type) => createId(type),
  clipboard = createElementClipboard(),
  clipboardPasteState = createClipboardPasteState(),
}: CanvasCommandArgs): CanvasCommands {
  const elements = content.canvas.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const selectedSet = new Set<string>();
  for (const id of selection.elementIds) {
    const target = byId.get(id);
    if (target) groupUnit(elements, target).forEach((element) => selectedSet.add(element.id));
  }
  const selected = elements.filter((element) => selectedSet.has(element.id));
  const selectedIds = selected.map((element) => element.id);
  const emit = (intents: Parameters<typeof createEditorTransactionFromIntents>[0]['intents']) => {
    const transaction = createEditorTransactionFromIntents({ content, intents });
    if (transaction) onTransaction(transaction);
  };
  const clearSelection = () => {
    if (selection.elementIds.length > 0) onSelectionChange({ elementIds: [] });
  };
  const copy = async () => {
    if (selected.length === 0) return false;
    let copied = false;
    try {
      copied = await clipboard.write(selected);
    } catch {
      return false;
    }
    if (copied) Object.assign(clipboardPasteState, { payloadKey: null, count: 0 });
    return copied;
  };

  return {
    clearSelection,
    selectAll: () => {
      const hidden = new Set(hiddenElementIds);
      const ids = elements
        .filter((element) => !element.lock && !hidden.has(element.id))
        .map((element) => element.id);
      if (!sameIds(ids, selection.elementIds))
        onSelectionChange({ elementIds: ids, primaryId: ids[0] });
    },
    deleteSelection: () => {
      if (selectedIds.length === 0) return;
      emit([{ type: 'element.delete', ids: selectedIds }]);
      clearSelection();
    },
    lockSelection: () => {
      if (selectedIds.length === 0) return;
      emit([
        {
          type: 'element.updateMany',
          updates: selectedIds.map((id) => ({ id, props: { lock: true } })),
        },
      ]);
      clearSelection();
    },
    copySelection: async () => {
      await copy();
    },
    cutSelection: async () => {
      if (!(await copy())) return;
      emit([{ type: 'element.delete', ids: selectedIds }]);
      clearSelection();
    },
    pasteElements: async () => {
      let copied: PPTElement[] | null;
      try {
        copied = await clipboard.read();
      } catch {
        return;
      }
      if (!copied?.length || copied.some((element) => !isValidEditorElement(element))) return;
      const payloadKey = JSON.stringify(copied);
      if (clipboardPasteState.payloadKey !== payloadKey)
        Object.assign(clipboardPasteState, { payloadKey, count: 0 });
      clipboardPasteState.count += 1;
      const offset = CLIPBOARD_PASTE_OFFSET * clipboardPasteState.count;
      const groupIds = new Map<string, string>();
      const pasted = copied.map((source) => {
        const element = JSON.parse(JSON.stringify(source)) as PPTElement;
        if (source.groupId) element.groupId = groupIds.get(source.groupId) ?? createGroupId();
        if (source.groupId) groupIds.set(source.groupId, element.groupId!);
        return {
          ...element,
          id: createElementId(source.type),
          left: source.left + offset,
          top: source.top + offset,
        } as PPTElement;
      });
      emit(pasted.map((element) => ({ type: 'element.add' as const, element })));
      const ids = pasted.map((element) => element.id);
      onSelectionChange({ elementIds: ids, primaryId: ids[0] });
    },
    unlockTarget: (elementId) => {
      const target = byId.get(elementId);
      if (!target?.lock) return;
      const ids = groupUnit(elements, target).map((element) => element.id);
      emit([
        { type: 'element.updateMany', updates: ids.map((id) => ({ id, props: { lock: false } })) },
      ]);
      onSelectionChange({ elementIds: ids, primaryId: target.id });
    },
    toggleGroup: () => {
      if (selected.length < 2) return;
      const groupId = selected[0].groupId;
      const isOneGroup =
        Boolean(groupId) && selected.every((element) => element.groupId === groupId);
      if (isOneGroup) {
        emit(
          selectedIds.map((id) => ({
            type: 'element.removeProps' as const,
            id,
            props: ['groupId'],
          })),
        );
        const primaryId =
          selection.primaryId && selectedIds.includes(selection.primaryId)
            ? selection.primaryId
            : selectedIds[0];
        onSelectionChange({ elementIds: [primaryId], primaryId });
      } else {
        const nextGroupId = createGroupId();
        emit([
          ...compactSelectionIntents(elements, selectedIds),
          {
            type: 'element.updateMany',
            updates: selectedIds.map((id) => ({ id, props: { groupId: nextGroupId } })),
          },
        ]);
      }
    },
    reorderTarget: (elementId, command) => {
      const target = byId.get(elementId);
      if (target) emit(reorderUnitIntents(elements, target, command));
    },
    alignSelection: (command) => {
      if (selectedIds.length > 0) emit([{ type: 'element.align', ids: selectedIds, command }]);
    },
  };
}
