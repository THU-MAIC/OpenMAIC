/**
 * @deprecated Canvas intent compilation belongs to @openmaic/editor/core.
 * This compatibility bridge keeps existing application imports working while
 * downstream callers move to the package API.
 */
export {
  compileEditorEditIntents as compileRendererEditIntents,
  createEditorTransactionFromIntents,
} from '@openmaic/editor/core';

import {
  applyEditorTransaction,
  createEditorTransactionFromIntents,
  type EditIntent,
} from '@openmaic/editor/core';
import type { SlideContent } from '@/lib/types/stage';

/** @deprecated Use createEditorTransactionFromIntents and applyEditorTransaction. */
export function applyRendererEditIntents(
  content: SlideContent,
  intents: readonly EditIntent[],
): SlideContent {
  const transaction = createEditorTransactionFromIntents({
    content,
    intents,
    origin: 'system',
    history: 'neutral',
  });
  return transaction ? applyEditorTransaction(content, transaction) : content;
}
