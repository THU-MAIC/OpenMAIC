import type { TableCellChange } from '@openmaic/renderer/editing';
import type { SlideContent } from '@/lib/types/stage';
import { applyRendererEditIntents } from './renderer-edit-intents';
import { useSlideEditSession } from './slide-edit-session';

/** Commits one completed table-cell edit as one App history entry. */
export function commitRendererTableCellChange(content: SlideContent, change: TableCellChange): void {
  const base = useSlideEditSession.getState().history?.present ?? content;
  const next = applyRendererEditIntents(base, [change.intent]);
  if (next === base) return;
  useSlideEditSession.getState().commitContent(next, true);
}
