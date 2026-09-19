import { useCallback, useMemo } from 'react';
import type { Slide, SlideContent } from '@openmaic/dsl';
import {
  createEditorTransactionFromIntents,
  type EditIntent,
  type EditorHistoryMode,
  type EditorTransaction,
  type EditorTransactionOrigin,
} from '../../core';

export interface EditorDispatchOptions {
  readonly origin?: EditorTransactionOrigin;
  readonly history?: EditorHistoryMode;
}

export type EditorDispatch = (
  intents: readonly EditIntent[],
  options?: EditorDispatchOptions,
) => void;

export function useEditorDispatcher(
  documentSlide: Slide,
  onTransaction: (transaction: EditorTransaction) => void,
): { readonly content: SlideContent; readonly dispatch: EditorDispatch } {
  const content = useMemo<SlideContent>(
    () => ({ type: 'slide', canvas: documentSlide }),
    [documentSlide],
  );
  const dispatch = useCallback<EditorDispatch>(
    (intents, options = {}) => {
      const transaction = createEditorTransactionFromIntents({ content, intents, ...options });
      if (transaction) onTransaction(transaction);
    },
    [content, onTransaction],
  );
  return { content, dispatch };
}
