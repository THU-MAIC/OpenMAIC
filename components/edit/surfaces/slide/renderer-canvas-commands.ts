import { nanoid } from 'nanoid';
import type { PPTElement } from '@openmaic/dsl';
import type { AlignCommand, EditIntent, ReorderCommand, Selection } from '@openmaic/editor/react';
import type { SlideContent } from '@/lib/types/stage';
import {
  createRendererElementClipboard,
  createRendererClipboardPasteState,
  type RendererClipboardPasteState,
  type RendererElementClipboard,
} from './renderer-element-clipboard';

const CLIPBOARD_PASTE_OFFSET = 20;

interface RendererCanvasCommandArgs {
  content: SlideContent;
  selection: Selection;
  hiddenElementIds?: readonly string[];
  onIntents: (intents: EditIntent[]) => void;
  onSelectionChange: (selection: Selection) => void;
  createGroupId?: () => string;
  createElementId?: (type: PPTElement['type']) => string;
  clipboard?: RendererElementClipboard;
  clipboardPasteState?: RendererClipboardPasteState;
}

export interface RendererCanvasCommands {
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

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function groupUnit(elements: readonly PPTElement[], target: PPTElement): PPTElement[] {
  if (!target.groupId) return [target];
  return elements.filter((element) => element.groupId === target.groupId);
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
  if (!adjacent) return 0;
  return adjacent.groupId
    ? elements.filter((element) => element.groupId === adjacent.groupId).length
    : 1;
}

function reorderUnitIntents(
  elements: readonly PPTElement[],
  target: PPTElement,
  command: ReorderCommand,
): EditIntent[] {
  const unit = groupUnit(elements, target);
  const unitIds = new Set(unit.map((element) => element.id));
  const indexes = elements
    .map((element, index) => (unitIds.has(element.id) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return [];

  if (command === 'front') {
    if (Math.max(...indexes) === elements.length - 1) return [];
    return unit.map((element) => ({ type: 'element.reorder', id: element.id, command }));
  }
  if (command === 'back') {
    if (Math.min(...indexes) === 0) return [];
    return [...unit]
      .reverse()
      .map((element) => ({ type: 'element.reorder', id: element.id, command }));
  }

  const repeat = adjacentUnitSize(elements, unit, command);
  if (repeat === 0) return [];
  const orderedUnit = command === 'forward' ? [...unit].reverse() : unit;
  return Array.from({ length: repeat }, () =>
    orderedUnit.map(
      (element): EditIntent => ({ type: 'element.reorder', id: element.id, command }),
    ),
  ).flat();
}

function reorderToMatchIds(
  elements: readonly PPTElement[],
  desiredIds: readonly string[],
): EditIntent[] {
  const workingIds = elements.map((element) => element.id);
  const intents: EditIntent[] = [];

  desiredIds.forEach((id, targetIndex) => {
    let currentIndex = workingIds.indexOf(id);
    while (currentIndex > targetIndex) {
      intents.push({ type: 'element.reorder', id, command: 'backward' });
      [workingIds[currentIndex - 1], workingIds[currentIndex]] = [
        workingIds[currentIndex],
        workingIds[currentIndex - 1],
      ];
      currentIndex -= 1;
    }
  });

  return intents;
}

function compactSelectionIntents(
  elements: readonly PPTElement[],
  selectedIds: readonly string[],
): EditIntent[] {
  const selectedSet = new Set(selectedIds);
  const selectedBlock = elements.filter((element) => selectedSet.has(element.id));
  const highestIndex = elements.findLastIndex((element) => selectedSet.has(element.id));
  if (selectedBlock.length < 2 || highestIndex === -1) return [];

  const remaining = elements.filter((element) => !selectedSet.has(element.id));
  const insertIndex = highestIndex - selectedBlock.length + 1;
  const desired = [...remaining];
  desired.splice(insertIndex, 0, ...selectedBlock);
  return reorderToMatchIds(
    elements,
    desired.map((element) => element.id),
  );
}

export function createRendererCanvasCommands({
  content,
  selection,
  hiddenElementIds = [],
  onIntents,
  onSelectionChange,
  createGroupId = () => nanoid(10),
  createElementId = (type) => `${type}-${nanoid(8)}`,
  clipboard = createRendererElementClipboard(),
  clipboardPasteState = createRendererClipboardPasteState(),
}: RendererCanvasCommandArgs): RendererCanvasCommands {
  const elements = content.canvas.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const selectedSet = new Set<string>();
  for (const id of selection.elementIds) {
    const target = byId.get(id);
    if (!target) continue;
    for (const element of groupUnit(elements, target)) {
      selectedSet.add(element.id);
    }
  }
  const selected = elements.filter((element) => selectedSet.has(element.id));
  const selectedIds = selected.map((element) => element.id);

  const clearSelection = () => {
    if (selection.elementIds.length > 0) onSelectionChange({ elementIds: [] });
  };
  const copySelection = async (): Promise<boolean> => {
    if (selected.length === 0) return false;
    const copied = await clipboard.write(selected);
    if (copied) {
      clipboardPasteState.payloadKey = null;
      clipboardPasteState.count = 0;
    }
    return copied;
  };
  const pasteElements = async () => {
    const copied = await clipboard.read();
    if (!copied?.length) return;
    const payloadKey = JSON.stringify(copied);
    if (clipboardPasteState.payloadKey !== payloadKey) {
      clipboardPasteState.payloadKey = payloadKey;
      clipboardPasteState.count = 0;
    }
    clipboardPasteState.count += 1;
    const offset = CLIPBOARD_PASTE_OFFSET * clipboardPasteState.count;
    const groupIds = new Map<string, string>();
    const elements = copied.map((source) => {
      const element = JSON.parse(JSON.stringify(source)) as PPTElement;
      if (source.groupId) {
        const nextGroupId = groupIds.get(source.groupId) ?? createGroupId();
        groupIds.set(source.groupId, nextGroupId);
        element.groupId = nextGroupId;
      }
      return {
        ...element,
        id: createElementId(source.type),
        left: source.left + offset,
        top: source.top + offset,
      } as PPTElement;
    });
    onIntents(elements.map((element) => ({ type: 'element.add', element })));
    const ids = elements.map((element) => element.id);
    onSelectionChange({ elementIds: ids, primaryId: ids[0] });
  };

  return {
    clearSelection,

    selectAll: () => {
      const hidden = new Set(hiddenElementIds);
      const ids = elements
        .filter((element) => !element.lock && !hidden.has(element.id))
        .map((element) => element.id);
      if (sameIds(ids, selection.elementIds)) return;
      onSelectionChange({ elementIds: ids, primaryId: ids[0] });
    },

    deleteSelection: () => {
      if (selectedIds.length === 0) return;
      onIntents([{ type: 'element.delete', ids: selectedIds }]);
      clearSelection();
    },

    lockSelection: () => {
      if (selectedIds.length === 0) return;
      onIntents([
        {
          type: 'element.updateMany',
          updates: selectedIds.map((id) => ({ id, props: { lock: true } })),
        },
      ]);
      clearSelection();
    },

    copySelection: async () => {
      await copySelection();
    },

    cutSelection: async () => {
      if (!(await copySelection())) return;
      onIntents([{ type: 'element.delete', ids: selectedIds }]);
      clearSelection();
    },

    pasteElements,

    unlockTarget: (elementId) => {
      const target = byId.get(elementId);
      if (!target?.lock) return;
      const unit = groupUnit(elements, target);
      const ids = unit.map((element) => element.id);
      onIntents([
        {
          type: 'element.updateMany',
          updates: ids.map((id) => ({ id, props: { lock: false } })),
        },
      ]);
      onSelectionChange({ elementIds: ids, primaryId: target.id });
    },

    toggleGroup: () => {
      if (selected.length < 2) return;
      const groupId = selected[0].groupId;
      const isOneGroup =
        Boolean(groupId) && selected.every((element) => element.groupId === groupId);
      if (isOneGroup) {
        onIntents(
          selectedIds.map((id) => ({ type: 'element.removeProps', id, props: ['groupId'] })),
        );
        const primaryId =
          selection.primaryId && selectedIds.includes(selection.primaryId)
            ? selection.primaryId
            : selectedIds[0];
        onSelectionChange({ elementIds: [primaryId], primaryId });
        return;
      }

      const nextGroupId = createGroupId();
      onIntents([
        ...compactSelectionIntents(elements, selectedIds),
        {
          type: 'element.updateMany',
          updates: selectedIds.map((id) => ({ id, props: { groupId: nextGroupId } })),
        },
      ]);
    },

    reorderTarget: (elementId, command) => {
      const target = byId.get(elementId);
      if (!target) return;
      const intents = reorderUnitIntents(elements, target, command);
      if (intents.length > 0) onIntents(intents);
    },

    alignSelection: (command) => {
      if (selectedIds.length === 0) return;
      onIntents([{ type: 'element.align', ids: selectedIds, command }]);
    },
  };
}
