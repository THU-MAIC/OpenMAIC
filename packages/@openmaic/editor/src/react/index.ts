'use client';

export { EditableSlideCanvas } from './EditableSlideCanvas';
export { EMPTY_SELECTION } from './types';
export { RendererTextEditor } from './text';
export { createCanvasCommands } from './canvasCommands';
export {
  createClipboardPasteState,
  createElementClipboard,
  parseElementClipboardPayload,
} from './elementClipboard';
export { handleCanvasShortcut, useCanvasShortcuts } from './useCanvasShortcuts';
export type { ShapePathFormula, ShapePathFormulaMap, ShapeKeypointRelative } from './shape/types';
export type {
  EditableSlideCanvasProps,
  EditIntent,
  Selection,
  TableCellChange,
  TextCreateRect,
  LineCreateGeometry,
  SnappingOptions,
  ReorderCommand,
  AlignCommand,
} from './types';
export type { CanvasCommandArgs, CanvasCommands } from './canvasCommands';
export type { ClipboardPasteState, ElementClipboard } from './elementClipboard';
export type { CanvasShortcutOptions } from './useCanvasShortcuts';
export type {
  RendererTextEditorProps,
  TextAutoSizeIntent,
  TextContentChange,
  TextEditCommand,
  TextEditorController,
  TextFormatState,
} from './text';
