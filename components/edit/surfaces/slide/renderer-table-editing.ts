import type { TableCellChange } from '@openmaic/renderer/editing';
import { createEditorTransaction } from '@openmaic/editor/core';
import type { SlideContent } from '@/lib/types/stage';
import { compileRendererEditIntents } from './renderer-edit-intents';
import { useSlideEditSession } from './slide-edit-session';

/** Commits one completed table-cell edit as one App history entry. */
export function commitRendererTableCellChange(
  content: SlideContent,
  change: TableCellChange,
): void {
  const base = useSlideEditSession.getState().history?.present ?? content;
  const operations = compileRendererEditIntents(base, [change.intent]);
  if (operations.length === 0) return;
  useSlideEditSession
    .getState()
    .applyTransaction(createEditorTransaction({ origin: 'canvas', operations }));
}
