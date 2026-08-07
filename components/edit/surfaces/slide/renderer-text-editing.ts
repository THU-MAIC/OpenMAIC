import type { TextAutoSizeIntent, TextContentChange } from '@openmaic/renderer/editing';
import { createEditorTransaction } from '@openmaic/editor/core';
import type { SlideContent } from '@/lib/types/stage';
import { compileRendererEditIntents } from './renderer-edit-intents';
import { useSlideEditSession } from './slide-edit-session';

export function commitRendererTextChange(content: SlideContent, change: TextContentChange): void {
  const base = useSlideEditSession.getState().history?.present ?? content;
  const operations = compileRendererEditIntents(base, [change.intent]);
  if (operations.length === 0) return;
  useSlideEditSession
    .getState()
    .applyTransaction(
      createEditorTransaction({ origin: 'canvas', history: change.history, operations }),
    );
}

export function commitRendererTextAutoSize(
  content: SlideContent,
  intent: TextAutoSizeIntent,
): void {
  const base = useSlideEditSession.getState().history?.present ?? content;
  const operations = compileRendererEditIntents(base, [intent]);
  if (operations.length === 0) return;
  useSlideEditSession
    .getState()
    .applyTransaction(
      createEditorTransaction({ origin: 'system', history: 'neutral', operations }),
    );
}
