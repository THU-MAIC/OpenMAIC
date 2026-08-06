import { produce } from 'immer';
import type { EditIntent } from '@openmaic/renderer/editing';
import { applySlideEditOperation } from '@/lib/edit/slide-ops';
import type { SlideContent } from '@/lib/types/stage';

type ReorderIntent = Extract<EditIntent, { type: 'element.reorder' }>;
type UpdateManyIntent = Extract<EditIntent, { type: 'element.updateMany' }>;
type TextContentIntent = Extract<EditIntent, { type: 'text.updateContent' }>;
type TableCellIntent = Extract<EditIntent, { type: 'table.updateCell' }>;

function resolveReorderIndex(
  elements: SlideContent['canvas']['elements'],
  id: string,
  command: ReorderIntent['command'],
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

function applyMixedUpdates(
  content: SlideContent,
  updates: UpdateManyIntent['updates'],
): SlideContent {
  return produce(content, (draft) => {
    for (const update of updates) {
      const element = draft.canvas.elements.find((item) => item.id === update.id);
      if (element) Object.assign(element, update.props);
    }
  });
}

function applyReorderIntent(content: SlideContent, intent: ReorderIntent): SlideContent {
  const index = resolveReorderIndex(content.canvas.elements, intent.id, intent.command);
  if (index === null) return content;

  return applySlideEditOperation(content, {
    type: 'element.reorder',
    elementId: intent.id,
    index,
  });
}

function applyTextContentIntent(content: SlideContent, intent: TextContentIntent): SlideContent {
  return produce(content, (draft) => {
    const element = draft.canvas.elements.find((item) => item.id === intent.id);
    if (!element) return;

    if (intent.target === 'text' && element.type === 'text') {
      element.content = intent.content;
    } else if (intent.target === 'shape' && element.type === 'shape') {
      element.text = {
        align: 'middle',
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
        ...element.text,
        content: intent.content,
      };
    }
  });
}

function applyTableCellIntent(content: SlideContent, intent: TableCellIntent): SlideContent {
  return produce(content, (draft) => {
    const element = draft.canvas.elements.find((item) => item.id === intent.id);
    if (!element || element.type !== 'table') return;
    for (const row of element.data) {
      const cell = row.find((candidate) => candidate.id === intent.cellId);
      if (!cell) continue;
      cell.text = intent.text;
      return;
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`Unsupported renderer edit intent: ${JSON.stringify(value)}`);
}

export function applyRendererEditIntents(
  content: SlideContent,
  intents: readonly EditIntent[],
): SlideContent {
  return intents.reduce((next, intent) => {
    switch (intent.type) {
      case 'element.update':
        return applySlideEditOperation(next, {
          type: 'element.update',
          elementId: intent.id,
          patch: intent.props,
        });
      case 'element.updateMany':
        return applyMixedUpdates(next, intent.updates);
      case 'element.add':
        return applySlideEditOperation(next, {
          type: 'element.add',
          element: intent.element,
          index: intent.index,
        });
      case 'element.delete':
        return applySlideEditOperation(next, {
          type: 'element.deleteMany',
          elementIds: [...intent.ids],
        });
      case 'element.reorder':
        return applyReorderIntent(next, intent);
      case 'element.align':
        return applySlideEditOperation(next, {
          type: 'element.align',
          elementIds: [...intent.ids],
          command:
            intent.command === 'center'
              ? 'horizontal'
              : intent.command === 'middle'
                ? 'vertical'
                : intent.command,
        });
      case 'element.removeProps':
        return applySlideEditOperation(next, {
          type: 'element.removeProps',
          elementId: intent.id,
          propNames: [...intent.props],
        });
      case 'text.updateContent':
        return applyTextContentIntent(next, intent);
      case 'table.updateCell':
        return applyTableCellIntent(next, intent);
      default:
        return assertNever(intent);
    }
  }, content);
}
