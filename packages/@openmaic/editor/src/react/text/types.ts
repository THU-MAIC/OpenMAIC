import type { EditIntent } from '../types';

export type TextEditCommand =
  | {
      command:
        | 'bold'
        | 'em'
        | 'underline'
        | 'strikethrough'
        | 'subscript'
        | 'superscript'
        | 'blockquote'
        | 'code'
        | 'clear';
    }
  | {
      command:
        | 'fontname'
        | 'fontsize'
        | 'forecolor'
        | 'backcolor'
        | 'align'
        | 'indent'
        | 'textIndent'
        | 'insert'
        | 'replace';
      value: string;
    }
  | {
      command: 'fontsize-add' | 'fontsize-reduce' | 'bulletList' | 'orderedList' | 'link';
      value?: string;
    };

export interface TextFormatState {
  bold: boolean;
  em: boolean;
  underline: boolean;
  strikethrough: boolean;
  superscript: boolean;
  subscript: boolean;
  code: boolean;
  color: string;
  backcolor: string;
  fontsize: string;
  fontname: string;
  link: string;
  align: 'left' | 'center' | 'right';
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
}

export interface TextEditorController {
  readonly elementId: string;
  /** Identifies a controller that edits text inside a table cell rather than an element body. */
  readonly kind?: 'element' | 'table-cell';
  focus(): void;
  flush(): void;
  /** Drops an uncommitted text change when the host will delete this element. */
  discard(): void;
  execute(command: TextEditCommand | readonly TextEditCommand[]): void;
  getHTML(): string;
}

type TextContentIntent = Extract<EditIntent, { type: 'text.updateContent' }>;
export type TextAutoSizeIntent = Extract<EditIntent, { type: 'element.update' }> & {
  props: { width?: number; height?: number };
};

export interface TextContentChange {
  intent: TextContentIntent;
  history: 'record' | 'neutral' | 'navigate';
}
