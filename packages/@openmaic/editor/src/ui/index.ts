'use client';

export { EditableSlideCanvasWithUI } from './EditableSlideCanvasWithUI';
export {
  DEFAULT_TEXT_TOOLBAR_FONTS,
  resolveEditorLabels,
  resolveLineToolbarLabels,
  resolveTextToolbarLabels,
} from './labels';
export { resolveEditorHost } from './host';
export type { EditorTranslate, EditorTranslationKey, EditorTranslationParams } from './translation';
export { DEFAULT_EDITOR_INSERT_ITEMS } from './adapters/insertRegistry';
export type { EditorInsertItem } from './adapters/insertRegistry';
export type {
  EditorAsset,
  EditorAssetPickerRequest,
  EditorError,
  EditorHostCapabilities,
  EditorLocale,
  ResolvedEditorHostCapabilities,
} from './host';
export { EDITING_UI_STYLES } from './styles';
export {
  FontSizeControl,
  stepTextToolbarFontSize,
  TEXT_TOOLBAR_FONT_SIZE_MAX,
  TEXT_TOOLBAR_FONT_SIZE_MIN,
} from './text/FontSizeControl';
export { DefaultColorPicker, normalizeToolbarColor } from './text/DefaultColorPicker';
export { TextFormatToolbar } from './text/TextFormatToolbar';
export { LineFormatToolbar } from './line/LineFormatToolbar';
export { LineToolbarOverlay } from './line/LineToolbarOverlay';
export { InsertToolbar } from './insert/InsertToolbar';
export { TableInsertPicker } from './insert/TableInsertPicker';
export { ChartInsertPicker } from './insert/ChartInsertPicker';
export { LineInsertPicker } from './insert/LineInsertPicker';
export { BackgroundInsertPicker } from './insert/BackgroundInsertPicker';
export { computeToolbarPosition, TextToolbarOverlay } from './text/TextToolbarOverlay';
export { useToolbarAnchor } from './text/useToolbarAnchor';
export { LatexEditorDialog } from './latex/LatexEditorDialog';
export { LatexToolbarOverlay } from './latex/LatexToolbarOverlay';
export { VideoToolbarOverlay } from './video/VideoToolbarOverlay';
export { EditorVideoContent } from './video/EditorVideoContent';
export { VideoInsertPicker } from './video/VideoInsertPicker';
export { AudioToolbarOverlay } from './audio/AudioToolbarOverlay';
export { AudioInsertPicker } from './audio/AudioInsertPicker';
export { DefaultAssetPicker } from './assets/DefaultAssetPicker';
export { ElementToolbarOverlay } from './element/ElementToolbarOverlay';
export { ImageToolbarOverlay } from './element/ImageToolbarOverlay';
export { CanvasContextMenu } from './context/CanvasContextMenu';
export {
  insertLatexAtSelection,
  renderLatexSource,
  type LatexEditorResult,
  type LatexRenderResult,
} from './latex/latex-editor';
export { LATEX_PRESETS, LATEX_SYMBOL_GROUPS } from './latex/latex-presets';
export type { TextToolbarOverlayProps, ToolbarPosition } from './text/TextToolbarOverlay';
export type { LineToolbarOverlayProps } from './line/LineToolbarOverlay';
export type { LatexEditorDialogProps } from './latex/LatexEditorDialog';
export type { LatexToolbarOverlayProps } from './latex/LatexToolbarOverlay';
export type { VideoToolbarOverlayProps } from './video/VideoToolbarOverlay';
export type { VideoInsertPickerProps } from './video/VideoInsertPicker';
export type { AudioToolbarOverlayProps } from './audio/AudioToolbarOverlay';
export type { AudioInsertPickerProps } from './audio/AudioInsertPicker';
export type { ElementToolbarOverlayProps } from './element/ElementToolbarOverlay';
export type { ImageToolbarOverlayProps } from './element/ImageToolbarOverlay';
export type { TableInsertPickerProps } from './insert/TableInsertPicker';
export type { ChartInsertPickerOption, ChartInsertPickerProps } from './insert/ChartInsertPicker';
export type {
  LineInsertPickerLabels,
  LineInsertPickerProps,
  LineInsertPreset,
} from './insert/LineInsertPicker';
export type {
  BackgroundInsertPickerLabels,
  BackgroundInsertPickerProps,
} from './insert/BackgroundInsertPicker';
export type { TrackedToolbarRect } from './text/useToolbarAnchor';
export type {
  EditableSlideCanvasWithUIProps,
  InsertToolbarItem,
  InsertToolbarOptions,
  InsertToolbarPopoverContext,
  InsertToolbarProps,
  InsertToolbarPlacement,
  LatexEditorLabels,
  LatexEditorOptions,
  LineFormatToolbarProps,
  LineToolbarLabels,
  LineToolbarOptions,
  TextFormatToolbarProps,
  TextToolbarColorPickerProps,
  TextToolbarColorPickerRenderer,
  TextToolbarFont,
  TextToolbarLabels,
  TextToolbarLocale,
  TextToolbarOptions,
  TextToolbarPlacement,
  VideoEditorLabels,
  VideoEditorOptions,
  VideoInsertLabels,
  VideoInsertOptions,
  VideoInsertResult,
  VideoPosterPickerProps,
  VideoPosterPickerRenderer,
  AudioEditorLabels,
  AudioEditorOptions,
  AudioInsertLabels,
  AudioInsertOptions,
  AudioInsertResult,
  ElementToolbarLabels,
  ElementToolbarOptions,
  ImageEditorLabels,
  ImageEditorOptions,
  ImagePickerProps,
  CanvasContextMenuLabels,
  CanvasContextMenuOptions,
} from './types';
