import {
  applyEditorTransaction,
  createEditorTransaction,
  type EditorOperation,
} from '@openmaic/editor/core';
import type { EditIntent } from '@openmaic/renderer/editing';
import type { SlideContent } from '@/lib/types/stage';

type ReorderIntent = Extract<EditIntent, { type: 'element.reorder' }>;

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

/**
 * Temporary app-side compatibility compiler while the React canvas still
 * lives under renderer. The compiler never mutates a snapshot itself: it
 * translates UI vocabulary into core operations, then advances a private
 * working document through the same transaction engine used by the host.
 */
export function compileRendererEditIntents(
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
      case 'element.add': {
        append([{ type: 'element.add', element: intent.element, index: intent.index }]);
        break;
      }
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
      case 'element.removeProps': {
        if (!elements.some((element) => element.id === intent.id)) break;
        append([{ type: 'element.removeProps', elementId: intent.id, propNames: intent.props }]);
        break;
      }
      case 'text.updateContent': {
        const element = elements.find((candidate) => candidate.id === intent.id);
        if (!element) break;
        if (intent.target === 'text' && element.type === 'text') {
          append([{ type: 'text.updateContent', elementId: intent.id, content: intent.content }]);
        } else if (intent.target === 'shape' && element.type === 'shape') {
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

/** @deprecated Use compileRendererEditIntents with applyEditorTransaction. */
export function applyRendererEditIntents(
  content: SlideContent,
  intents: readonly EditIntent[],
): SlideContent {
  const operations = compileRendererEditIntents(content, intents);
  if (operations.length === 0) return content;
  return applyEditorTransaction(
    content,
    createEditorTransaction({ origin: 'system', history: 'neutral', operations }),
  );
}
