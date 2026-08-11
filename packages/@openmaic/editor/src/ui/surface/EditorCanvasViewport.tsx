import type { CSSProperties } from 'react';
import { EditableSlideCanvas } from '../../react/EditableSlideCanvas';
import type { EditableSlideCanvasProps, Selection } from '../../react/types';
import { CanvasContextMenu } from '../context/CanvasContextMenu';
import type { CanvasContextMenuOptions } from '../types';

interface EditorCanvasViewportProps {
  readonly style: CSSProperties;
  readonly canvasProps: EditableSlideCanvasProps;
  readonly contextMenu: CanvasContextMenuOptions;
  readonly selection: Selection;
  readonly onSelectionChange: (selection: Selection) => void;
}

export function EditorCanvasViewport({
  style,
  canvasProps,
  contextMenu,
  selection,
  onSelectionChange,
}: EditorCanvasViewportProps) {
  const canvas = <EditableSlideCanvas {...canvasProps} />;
  return (
    <div data-editing-ui-canvas-viewport="" style={style}>
      <CanvasContextMenu
        {...contextMenu}
        elements={canvasProps.slide.elements}
        selection={selection}
        onSelectionChange={onSelectionChange}
      >
        {canvas}
      </CanvasContextMenu>
    </div>
  );
}
