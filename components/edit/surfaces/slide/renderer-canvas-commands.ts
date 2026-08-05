import { nanoid } from 'nanoid';
import type { PPTElement } from '@openmaic/dsl';
import type {
  AlignCommand,
  EditIntent,
  ReorderCommand,
  Selection,
} from '@openmaic/renderer/editing';
import type { SlideContent } from '@/lib/types/stage';

interface RendererCanvasCommandArgs {
  content: SlideContent;
  selection: Selection;
  hiddenElementIds?: readonly string[];
  onIntents: (intents: EditIntent[]) => void;
  onSelectionChange: (selection: Selection) => void;
  createGroupId?: () => string;
}

export interface RendererCanvasCommands {
  clearSelection: () => void;
  selectAll: () => void;
  deleteSelection: () => void;
  lockSelection: () => void;
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

export function createRendererCanvasCommands({
  content,
  selection,
  hiddenElementIds = [],
  onIntents,
  onSelectionChange,
  createGroupId = () => nanoid(10),
}: RendererCanvasCommandArgs): RendererCanvasCommands {
  const elements = content.canvas.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const selected: PPTElement[] = [];
  const selectedSet = new Set<string>();
  for (const id of selection.elementIds) {
    const target = byId.get(id);
    if (!target) continue;
    for (const element of groupUnit(elements, target)) {
      if (selectedSet.has(element.id)) continue;
      selectedSet.add(element.id);
      selected.push(element);
    }
  }
  const selectedIds = selected.map((element) => element.id);

  const clearSelection = () => {
    if (selection.elementIds.length > 0) onSelectionChange({ elementIds: [] });
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
