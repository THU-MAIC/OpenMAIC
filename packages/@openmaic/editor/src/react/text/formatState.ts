import type { EditorView } from 'prosemirror-view';
import { getTextAttrs } from './prosemirror/utils';
import type { TextFormatState } from './types';

export function getTextFormatState(
  view: EditorView,
  defaults: { color: string; fontname: string },
): TextFormatState {
  return getTextAttrs(view, defaults);
}
