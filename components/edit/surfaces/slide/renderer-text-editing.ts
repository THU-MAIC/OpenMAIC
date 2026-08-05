import type { TextAutoSizeIntent, TextContentChange } from '@openmaic/renderer/editing';
import type { SlideContent } from '@/lib/types/stage';
import { applyRendererEditIntents } from './renderer-edit-intents';
import { useSlideEditSession } from './slide-edit-session';

export function commitRendererTextChange(content: SlideContent, change: TextContentChange): void {
  const base = useSlideEditSession.getState().history?.present ?? content;
  const next = applyRendererEditIntents(base, [change.intent]);
  if (next === base) return;
  useSlideEditSession.getState().commitContent(next, change.history === 'record');
}

export function commitRendererTextAutoSize(
  content: SlideContent,
  intent: TextAutoSizeIntent,
): void {
  const base = useSlideEditSession.getState().history?.present ?? content;
  const next = applyRendererEditIntents(base, [intent]);
  if (next === base) return;
  useSlideEditSession.getState().commitContent(next, false);
}
