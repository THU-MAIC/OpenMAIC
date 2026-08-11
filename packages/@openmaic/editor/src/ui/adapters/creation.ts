import { useCallback, useMemo, useState } from 'react';
import type { LineCreateGeometry, Selection, TextCreateRect } from '../../react/types';
import type { ResolvedEditorHostCapabilities } from '../host';
import type { EditorDispatch } from '../runtime/useEditorDispatcher';
import type { ElementAdapterContext } from './types';
import { createDefaultLineElement, createDefaultTextElement } from './defaultElements';
import { createHostInsertItems, type EditorCreationMode } from './insert';

interface CreationAdapterOptions {
  readonly context: ElementAdapterContext;
  readonly host: ResolvedEditorHostCapabilities;
  readonly dispatch: EditorDispatch;
  readonly onSelectionChange: (selection: Selection) => void;
}

export function useCreationAdapter({
  context,
  host,
  dispatch,
  onSelectionChange,
}: CreationAdapterOptions) {
  const [mode, setMode] = useState<EditorCreationMode>(null);
  const insertContributions = useMemo(
    () => createHostInsertItems(context, mode, setMode),
    [context, mode],
  );
  const clear = useCallback(() => setMode(null), []);
  const onTextCreate = useCallback(
    (rect: TextCreateRect) => {
      const id = host.createElementId('text');
      dispatch([{ type: 'element.add', element: createDefaultTextElement(id, rect) }], {
        origin: 'toolbar',
      });
      clear();
      onSelectionChange({ elementIds: [id], primaryId: id, editingId: id });
    },
    [clear, dispatch, host, onSelectionChange],
  );
  const onLineCreate = useCallback(
    (geometry: LineCreateGeometry) => {
      if (mode?.type !== 'line') return;
      const id = host.createElementId('line');
      dispatch(
        [{ type: 'element.add', element: createDefaultLineElement(id, geometry, mode.preset) }],
        { origin: 'toolbar' },
      );
      clear();
      onSelectionChange({ elementIds: [id], primaryId: id });
    },
    [clear, dispatch, host, mode, onSelectionChange],
  );

  return {
    clear,
    insertContributions,
    canvasProps: {
      creatingText: mode?.type === 'text',
      onTextCreate,
      creatingLine: mode?.type === 'line',
      onLineCreate,
      onLineCreateCancel: clear,
    },
  };
}
