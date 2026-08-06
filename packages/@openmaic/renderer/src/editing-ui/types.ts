import type { ReactNode } from 'react';
import type { EditableSlideCanvasProps, EditIntent } from '../editing/types';
import type { PPTLineElement, PPTVideoElement } from '@openmaic/dsl';
import type { TextEditCommand, TextFormatState } from '../editing/text/types';
import type { LatexEditorResult } from './latex/latex-editor';

export type TextToolbarLocale = 'zh-CN' | 'en-US';
export type TextToolbarPlacement = 'top' | 'bottom';

export interface TextToolbarFont {
  readonly label: string;
  readonly value: string;
}

export interface TextToolbarLabels {
  toolbar: string;
  font: string;
  fontDefault: string;
  fontSize: string;
  sizeDown: string;
  sizeUp: string;
  bold: string;
  italic: string;
  underline: string;
  color: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  bullet: string;
  bringToFront: string;
  sendToBack: string;
  delete: string;
  colorHex: string;
}

export interface TextToolbarColorPickerProps {
  readonly value: string;
  readonly labels: TextToolbarLabels;
  readonly onChange: (color: string) => void;
  readonly onCommit: (color: string) => void;
}

export type TextToolbarColorPickerRenderer = (props: TextToolbarColorPickerProps) => ReactNode;

export interface TextToolbarOptions {
  readonly locale?: TextToolbarLocale;
  readonly labels?: Partial<TextToolbarLabels>;
  readonly fonts?: readonly TextToolbarFont[];
  readonly placement?: TextToolbarPlacement;
  readonly className?: string;
  readonly renderColorPicker?: TextToolbarColorPickerRenderer;
}

export interface TextFormatToolbarProps extends TextToolbarOptions {
  readonly elementId: string;
  readonly format: TextFormatState;
  readonly onCommand: (command: TextEditCommand) => void;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
}

export interface LineToolbarLabels {
  toolbar: string;
  kind: string;
  color: string;
  width: string;
  style: string;
  start: string;
  end: string;
  straight: string;
  broken: string;
  broken2: string;
  curve: string;
  cubic: string;
  solid: string;
  dashed: string;
  dotted: string;
  none: string;
  arrow: string;
  dot: string;
  bringToFront: string;
  sendToBack: string;
  delete: string;
}

export interface LineToolbarOptions {
  readonly locale?: TextToolbarLocale;
  readonly labels?: Partial<LineToolbarLabels>;
  readonly placement?: TextToolbarPlacement;
  readonly className?: string;
}

export interface LineFormatToolbarProps extends LineToolbarOptions {
  readonly element: PPTLineElement;
  readonly onChange: (intents: EditIntent[]) => void;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
}

export interface InsertToolbarPopoverContext {
  readonly close: () => void;
}

export type InsertToolbarPlacement = 'left' | 'top';

export interface InsertToolbarItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly tooltip?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onInvoke?: () => void;
  readonly renderPopover?: (context: InsertToolbarPopoverContext) => ReactNode;
}

export interface InsertToolbarOptions {
  readonly items: readonly InsertToolbarItem[];
  readonly label?: string;
  readonly className?: string;
  /** Dock outside the reduced canvas viewport instead of covering the slide. Defaults to `top`. */
  readonly placement?: InsertToolbarPlacement;
}

export type InsertToolbarProps = InsertToolbarOptions;

export interface LatexEditorLabels {
  toolbar: string;
  insertFormula: string;
  editFormula: string;
  bringToFront: string;
  sendToBack: string;
  delete: string;
  dialog: string;
  source: string;
  preview: string;
  symbols: string;
  presets: string;
  cancel: string;
  confirm: string;
  invalidSource: string;
}

export interface LatexEditorOptions {
  readonly labels?: Partial<LatexEditorLabels>;
  readonly onInsert: (result: LatexEditorResult) => void;
  readonly onUpdate: (elementId: string, result: LatexEditorResult) => void;
  readonly onBringToFront?: (elementId: string) => void;
  readonly onSendToBack?: (elementId: string) => void;
  readonly onDelete?: (elementId: string) => void;
}

export interface VideoEditorLabels {
  toolbar: string;
  poster: string;
  bringToFront: string;
  sendToBack: string;
  delete: string;
}

export interface VideoPosterPickerProps {
  readonly element: PPTVideoElement;
  readonly onPick: (poster: string) => void;
  readonly close: () => void;
}

/**
 * The app owns uploads and asset persistence. The renderer only owns the
 * selection-anchored shell around this picker.
 */
export type VideoPosterPickerRenderer = (props: VideoPosterPickerProps) => ReactNode;

export interface VideoEditorOptions {
  readonly labels?: Partial<VideoEditorLabels>;
  readonly renderPosterPicker?: VideoPosterPickerRenderer;
  readonly onPosterChange: (elementId: string, poster: string) => void;
  readonly onBringToFront?: (elementId: string) => void;
  readonly onSendToBack?: (elementId: string) => void;
  readonly onDelete?: (elementId: string) => void;
}

export interface VideoInsertLabels {
  insertVideo: string;
  videoDrop: string;
  videoOr: string;
  videoUrlPlaceholder: string;
  videoInsert: string;
}

export interface VideoInsertResult {
  readonly src: string;
  readonly ext?: string;
}

export interface VideoInsertOptions {
  readonly labels?: Partial<VideoInsertLabels>;
  readonly onInsert: (result: VideoInsertResult) => void;
}

export interface AudioEditorLabels {
  toolbar: string;
  preview: string;
  pause: string;
  loop: string;
  bringToFront: string;
  sendToBack: string;
  delete: string;
}

export interface AudioEditorOptions {
  readonly labels?: Partial<AudioEditorLabels>;
  readonly onLoopChange: (elementId: string, loop: boolean) => void;
  readonly onBringToFront?: (elementId: string) => void;
  readonly onSendToBack?: (elementId: string) => void;
  readonly onDelete?: (elementId: string) => void;
}

export interface AudioInsertLabels {
  insertAudio: string;
  audioDrop: string;
  audioOr: string;
  audioUrlPlaceholder: string;
  audioInsert: string;
}

export interface AudioInsertResult {
  readonly src: string;
  readonly ext?: string;
}

export interface AudioInsertOptions {
  readonly labels?: Partial<AudioInsertLabels>;
  readonly onInsert: (result: AudioInsertResult) => void;
}

export interface EditableSlideCanvasWithUIProps extends EditableSlideCanvasProps {
  readonly textToolbar?: TextToolbarOptions | false;
  readonly lineToolbar?: LineToolbarOptions | false;
  readonly insertToolbar?: InsertToolbarOptions | false;
  readonly latexEditor?: LatexEditorOptions | false;
  readonly videoEditor?: VideoEditorOptions | false;
  readonly videoInsert?: VideoInsertOptions | false;
  readonly audioEditor?: AudioEditorOptions | false;
  readonly audioInsert?: AudioInsertOptions | false;
}
