import type { ReactNode } from 'react';
import type { PPTElement, Slide } from '@openmaic/dsl';
import type { EditIntent, EditorHistoryMode, EditorTransactionOrigin } from '../../core';
import type { Selection } from '../../react/types';
import type { InsertToolbarItem } from '../types';
import type { EditorLabels } from '../labels';
import type { ResolvedEditorHostCapabilities } from '../host';
import type { EditorInsertItem } from './insertRegistry';

export interface ElementAdapterDispatchOptions {
  readonly origin?: EditorTransactionOrigin;
  readonly history?: EditorHistoryMode;
}

export interface ElementAdapterContext {
  readonly slide: Slide;
  readonly selection?: Selection;
  readonly hiddenElementIds?: readonly string[];
  readonly elementIdPrefix: string;
  readonly host: ResolvedEditorHostCapabilities;
  readonly labels: EditorLabels;
  readonly dispatch: (
    intents: readonly EditIntent[],
    options?: ElementAdapterDispatchOptions,
  ) => void;
  readonly select: (selection: Selection) => void;
}

export interface ElementEditorAdapter<T extends PPTElement = PPTElement> {
  readonly id: string;
  readonly type?: T['type'];
  readonly insertType?: EditorInsertItem;
  readonly insertItem?: InsertToolbarItem;
  readonly overlay?: ReactNode;
}
