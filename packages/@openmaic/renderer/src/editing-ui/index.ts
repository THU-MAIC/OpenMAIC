'use client';

export { DEFAULT_TEXT_TOOLBAR_FONTS, resolveTextToolbarLabels } from './labels';
export { EDITING_UI_STYLES } from './styles';
export {
  FontSizeControl,
  stepTextToolbarFontSize,
  TEXT_TOOLBAR_FONT_SIZE_MAX,
  TEXT_TOOLBAR_FONT_SIZE_MIN,
} from './text/FontSizeControl';
export { TextFormatToolbar } from './text/TextFormatToolbar';
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
