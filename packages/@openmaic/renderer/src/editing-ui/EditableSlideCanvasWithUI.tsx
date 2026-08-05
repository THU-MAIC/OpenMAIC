'use client';

import { useCallback, useEffect, useState } from 'react';
import { EditableSlideCanvas } from '../editing/EditableSlideCanvas';
import type { ReorderCommand } from '../editing/types';
import type { TextEditorController, TextFormatState } from '../editing/text/types';
import { EDITING_UI_STYLES } from './styles';
import { TextToolbarOverlay } from './text/TextToolbarOverlay';
import type { EditableSlideCanvasWithUIProps } from './types';

interface TextFormatEntry {
  readonly elementId: string;
  readonly state: TextFormatState;
}

export function EditableSlideCanvasWithUI({
  textToolbar,
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

  const deleteActiveText = useCallback(() => {
    if (!editingId || !onElementsChange) return;
    onElementsChange([{ type: 'element.delete', ids: [editingId] }]);
    onSelectionChange?.({ elementIds: [] });
  }, [editingId, onElementsChange, onSelectionChange]);

  const elementActions = onElementsChange
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
    </div>
  );
}
