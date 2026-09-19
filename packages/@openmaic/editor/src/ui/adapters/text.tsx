import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Selection, TableCellChange } from '../../react/types';
import type {
  TextAutoSizeIntent,
  TextContentChange,
  TextEditorController,
  TextFormatState,
} from '../../react/text/types';
import type { EditorDispatch } from '../runtime/useEditorDispatcher';
import { TextToolbarOverlay } from '../text/TextToolbarOverlay';
import type { TextToolbarLabels } from '../types';

interface TextAdapterOptions {
  readonly selection: Selection;
  readonly elementIdPrefix: string;
  readonly labels: TextToolbarLabels;
  readonly dispatch: EditorDispatch;
  readonly onSelectionChange: (selection: Selection) => void;
}

interface TextAdapterResult {
  readonly editorFocused: boolean;
  readonly overlay: ReactNode;
  readonly canvasCallbacks: {
    readonly onTextContentChange: (change: TextContentChange) => void;
    readonly onTextAutoSize: (intent: TextAutoSizeIntent) => void;
    readonly onTextEditorChange: (controller: TextEditorController | null) => void;
    readonly onTextFormatChange: (elementId: string, state: TextFormatState) => void;
    readonly onTextFocusChange: (focused: boolean) => void;
    readonly onTableCellChange: (change: TableCellChange) => void;
  };
}

interface TextFormatEntry {
  readonly elementId: string;
  readonly state: TextFormatState;
}

export function useTextEditorAdapter({
  selection,
  elementIdPrefix,
  labels,
  dispatch,
  onSelectionChange,
}: TextAdapterOptions): TextAdapterResult {
  const [controller, setController] = useState<TextEditorController | null>(null);
  const [formatEntry, setFormatEntry] = useState<TextFormatEntry | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const editingId = selection.editingId ?? '';
  const activeController = controller?.elementId === editingId ? controller : null;
  const activeFormat = formatEntry?.elementId === editingId ? formatEntry.state : null;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- controlled selection invalidates stale editor handles.
    setController((current) => (current?.elementId === editingId ? current : null));
    setFormatEntry((current) => (current?.elementId === editingId ? current : null));
  }, [editingId]);

  const onTextEditorChange = useCallback(
    (next: TextEditorController | null) => {
      if (next === null) {
        setController((current) => (current?.elementId === editingId ? null : current));
        setFormatEntry((current) => (current?.elementId === editingId ? null : current));
      } else if (next.elementId === editingId) {
        setController(next);
      }
    },
    [editingId],
  );
  const onTextFormatChange = useCallback(
    (elementId: string, state: TextFormatState) => {
      if (elementId === editingId) setFormatEntry({ elementId, state });
    },
    [editingId],
  );
  const onTextContentChange = useCallback(
    (change: TextContentChange) => dispatch([change.intent], { history: change.history }),
    [dispatch],
  );
  const onTextAutoSize = useCallback(
    (intent: TextAutoSizeIntent) => dispatch([intent], { origin: 'system', history: 'neutral' }),
    [dispatch],
  );
  const onTableCellChange = useCallback(
    (change: TableCellChange) => dispatch([change.intent], { history: change.history }),
    [dispatch],
  );

  const deleteElement = useCallback(() => {
    if (!editingId) return;
    activeController?.discard();
    dispatch([{ type: 'element.delete', ids: [editingId] }], { origin: 'toolbar' });
    onSelectionChange({ elementIds: [] });
  }, [activeController, dispatch, editingId, onSelectionChange]);
  const reorderElement = useCallback(
    (command: 'front' | 'back') => {
      if (!editingId) return;
      dispatch([{ type: 'element.reorder', id: editingId, command }], { origin: 'toolbar' });
    },
    [dispatch, editingId],
  );
  const elementActions =
    activeController?.kind !== 'table-cell'
      ? {
          onBringToFront: () => reorderElement('front'),
          onSendToBack: () => reorderElement('back'),
          onDelete: deleteElement,
        }
      : {};
  const overlay =
    activeController && activeFormat ? (
      <TextToolbarOverlay
        elementId={editingId}
        elementIdPrefix={elementIdPrefix}
        format={activeFormat}
        labels={labels}
        onCommand={(command) => activeController.execute(command)}
        {...elementActions}
      />
    ) : null;

  return {
    editorFocused,
    overlay,
    canvasCallbacks: {
      onTextContentChange,
      onTextAutoSize,
      onTextEditorChange,
      onTextFormatChange,
      onTextFocusChange: setEditorFocused,
      onTableCellChange,
    },
  };
}
