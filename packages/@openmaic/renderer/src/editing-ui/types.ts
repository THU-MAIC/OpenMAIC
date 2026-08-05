import type { ReactNode } from 'react';
import type { EditableSlideCanvasProps } from '../editing/types';
import type { TextEditCommand, TextFormatState } from '../editing/text/types';

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

export interface EditableSlideCanvasWithUIProps extends EditableSlideCanvasProps {
  readonly textToolbar?: TextToolbarOptions | false;
}
