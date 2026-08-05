'use client';

export { EditableSlideCanvasWithUI } from './EditableSlideCanvasWithUI';
export { DEFAULT_TEXT_TOOLBAR_FONTS, resolveTextToolbarLabels } from './labels';
export { EDITING_UI_STYLES } from './styles';
export {
  FontSizeControl,
  stepTextToolbarFontSize,
  TEXT_TOOLBAR_FONT_SIZE_MAX,
  TEXT_TOOLBAR_FONT_SIZE_MIN,
} from './text/FontSizeControl';
export { DefaultColorPicker, normalizeToolbarColor } from './text/DefaultColorPicker';
export { TextFormatToolbar } from './text/TextFormatToolbar';
export { computeToolbarPosition, TextToolbarOverlay } from './text/TextToolbarOverlay';
export { useToolbarAnchor } from './text/useToolbarAnchor';
export type { TextToolbarOverlayProps, ToolbarPosition } from './text/TextToolbarOverlay';
export type { TrackedToolbarRect } from './text/useToolbarAnchor';
export type {
  EditableSlideCanvasWithUIProps,
  TextFormatToolbarProps,
  TextToolbarColorPickerProps,
  TextToolbarColorPickerRenderer,
  TextToolbarFont,
  TextToolbarLabels,
  TextToolbarLocale,
  TextToolbarOptions,
  TextToolbarPlacement,
} from './types';
