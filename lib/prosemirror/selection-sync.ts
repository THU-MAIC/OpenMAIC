import type { Transaction } from 'prosemirror-state';

/** Push toolbar attrs when the selection moved or marks/doc changed. */
export function shouldPushAttrs(tr: Transaction): boolean {
  return tr.selectionSet || tr.docChanged || tr.storedMarksSet;
}
