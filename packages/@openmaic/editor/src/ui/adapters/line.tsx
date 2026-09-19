import { useMemo, type ReactNode } from 'react';
import type { PPTLineElement, Slide } from '@openmaic/dsl';
import type { Selection } from '../../react/types';
import { LineToolbarOverlay } from '../line/LineToolbarOverlay';
import type { LineToolbarLabels } from '../types';
import type { EditorDispatch } from '../runtime/useEditorDispatcher';

interface LineAdapterOptions {
  readonly slide: Slide;
  readonly selection: Selection;
  readonly hiddenElementIds?: readonly string[];
  readonly elementIdPrefix: string;
  readonly labels: LineToolbarLabels;
  readonly dispatch: EditorDispatch;
  readonly onSelectionChange: (selection: Selection) => void;
}

export function useLineEditorAdapter({
  slide,
  selection,
  hiddenElementIds,
  elementIdPrefix,
  labels,
  dispatch,
  onSelectionChange,
}: LineAdapterOptions): ReactNode {
  const selected = useMemo<PPTLineElement | null>(() => {
    if (selection.elementIds.length !== 1) return null;
    const id = selection.primaryId ?? selection.elementIds[0];
    if (hiddenElementIds?.includes(id)) return null;
    const element = slide.elements.find((candidate) => candidate.id === id);
    return element?.type === 'line' && !element.lock ? element : null;
  }, [hiddenElementIds, selection, slide.elements]);

  if (!selected) return null;
  return (
    <LineToolbarOverlay
      element={selected}
      elementIdPrefix={elementIdPrefix}
      labels={labels}
      onChange={(intents) => dispatch(intents, { origin: 'toolbar' })}
      onBringToFront={() =>
        dispatch([{ type: 'element.reorder', id: selected.id, command: 'front' }], {
          origin: 'toolbar',
        })
      }
      onSendToBack={() =>
        dispatch([{ type: 'element.reorder', id: selected.id, command: 'back' }], {
          origin: 'toolbar',
        })
      }
      onDelete={() => {
        dispatch([{ type: 'element.delete', ids: [selected.id] }], { origin: 'toolbar' });
        onSelectionChange({ elementIds: [] });
      }}
    />
  );
}
