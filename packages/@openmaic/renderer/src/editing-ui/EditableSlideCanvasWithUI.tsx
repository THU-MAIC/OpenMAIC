'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { EditableSlideCanvas } from '../editing/EditableSlideCanvas';
import type { ReorderCommand } from '../editing/types';
import type { TextEditorController, TextFormatState } from '../editing/text/types';
import { EDITING_UI_STYLES } from './styles';
import { TextToolbarOverlay } from './text/TextToolbarOverlay';
import { LineToolbarOverlay } from './line/LineToolbarOverlay';
import { InsertToolbar } from './insert/InsertToolbar';
import type { EditableSlideCanvasWithUIProps } from './types';

interface TextFormatEntry {
  readonly elementId: string;
  readonly state: TextFormatState;
}

export function EditableSlideCanvasWithUI({
  textToolbar,
  lineToolbar,
  insertToolbar,
  onTextEditorChange,
  onTextFormatChange,
  onElementsChange,
  onSelectionChange,
  elementIdPrefix,
  ...canvasProps
}: EditableSlideCanvasWithUIProps) {
  const [controller, setController] = useState<TextEditorController | null>(null);
  const [formatEntry, setFormatEntry] = useState<TextFormatEntry | null>(null);
  const editingId = canvasProps.selection?.editingId ?? '';
  const activeController = controller?.elementId === editingId ? controller : null;
  const activeFormat = formatEntry?.elementId === editingId ? formatEntry.state : null;
  const selectedLine = useMemo(() => {
    const elementIds = canvasProps.selection?.elementIds ?? [];
    if (elementIds.length !== 1) return null;
    const elementId = canvasProps.selection?.primaryId ?? elementIds[0];
    if (canvasProps.hiddenElementIds?.includes(elementId)) return null;
    const element = canvasProps.slide.elements.find((candidate) => candidate.id === elementId);
    return element?.type === 'line' && !element.lock ? element : null;
  }, [canvasProps.hiddenElementIds, canvasProps.selection, canvasProps.slide.elements]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- selection changes must clear stale editor state before a later re-selection.
    setController((current) => (current?.elementId === editingId ? current : null));
    setFormatEntry((current) => (current?.elementId === editingId ? current : null));
  }, [editingId]);

  const handleTextEditorChange = useCallback(
    (nextController: TextEditorController | null) => {
      if (nextController === null) {
        setController((current) => (current?.elementId === editingId ? null : current));
        setFormatEntry((current) => (current?.elementId === editingId ? null : current));
      } else if (nextController.elementId === editingId) {
        setController(nextController);
      }
      onTextEditorChange?.(nextController);
    },
    [editingId, onTextEditorChange],
  );

  const handleTextFormatChange = useCallback(
    (elementId: string, state: TextFormatState) => {
      if (elementId === editingId) setFormatEntry({ elementId, state });
      onTextFormatChange?.(elementId, state);
    },
    [editingId, onTextFormatChange],
  );

  const emitReorder = useCallback(
    (command: Extract<ReorderCommand, 'front' | 'back'>) => {
      if (!editingId || !onElementsChange) return;
      onElementsChange([{ type: 'element.reorder', id: editingId, command }]);
    },
    [editingId, onElementsChange],
  );

  const emitLineReorder = useCallback(
    (command: Extract<ReorderCommand, 'front' | 'back'>) => {
      if (!selectedLine || !onElementsChange) return;
      onElementsChange([{ type: 'element.reorder', id: selectedLine.id, command }]);
    },
    [onElementsChange, selectedLine],
  );

  const deleteSelectedLine = useCallback(() => {
    if (!selectedLine || !onElementsChange) return;
    onElementsChange([{ type: 'element.delete', ids: [selectedLine.id] }]);
    onSelectionChange?.({ elementIds: [] });
  }, [onElementsChange, onSelectionChange, selectedLine]);

  const deleteActiveText = useCallback(() => {
    if (!editingId || !onElementsChange) return;
    onElementsChange([{ type: 'element.delete', ids: [editingId] }]);
    onSelectionChange?.({ elementIds: [] });
  }, [editingId, onElementsChange, onSelectionChange]);

  const elementActions = onElementsChange && activeController?.kind !== 'table-cell'
    ? {
        onBringToFront: () => emitReorder('front'),
        onSendToBack: () => emitReorder('back'),
        onDelete: deleteActiveText,
      }
    : {};

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <style dangerouslySetInnerHTML={{ __html: EDITING_UI_STYLES }} />
      <EditableSlideCanvas
        {...canvasProps}
        elementIdPrefix={elementIdPrefix}
        onElementsChange={onElementsChange}
        onSelectionChange={onSelectionChange}
        onTextEditorChange={handleTextEditorChange}
        onTextFormatChange={handleTextFormatChange}
      />
      {insertToolbar !== false && insertToolbar ? <InsertToolbar {...insertToolbar} /> : null}
      {textToolbar !== false && activeController && activeFormat ? (
        <TextToolbarOverlay
          elementId={editingId}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          format={activeFormat}
          onCommand={(command) => activeController.execute(command)}
          {...elementActions}
          {...textToolbar}
        />
      ) : null}
      {lineToolbar !== false && selectedLine && onElementsChange ? (
        <LineToolbarOverlay
          element={selectedLine}
          elementIdPrefix={elementIdPrefix ?? 'slide-element-'}
          onChange={onElementsChange}
          onBringToFront={() => emitLineReorder('front')}
          onSendToBack={() => emitLineReorder('back')}
          onDelete={deleteSelectedLine}
          {...lineToolbar}
        />
      ) : null}
    </div>
  );
}
