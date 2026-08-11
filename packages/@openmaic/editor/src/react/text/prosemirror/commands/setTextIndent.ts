import type { Schema } from 'prosemirror-model';
import { type Transaction, TextSelection, AllSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { isList } from '../utils';

type IndentKey = 'indent' | 'textIndent';

function setNodeIndentMarkup(
  tr: Transaction,
  pos: number,
  delta: number,
  indentKey: IndentKey,
): Transaction {
  if (!tr.doc) return tr;

  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;

  const minIndent = 0;
  const maxIndent = 8;

  let indent = (node.attrs[indentKey] || 0) + delta;
  if (indent < minIndent) indent = minIndent;
  if (indent > maxIndent) indent = maxIndent;

  if (indent === node.attrs[indentKey]) return tr;

  const nodeAttrs = {
    ...node.attrs,
    [indentKey]: indent,
  };

  return tr.setNodeMarkup(pos, node.type, nodeAttrs, node.marks);
}

const setIndent = (
  tr: Transaction,
  schema: Schema,
  delta: number,
  indentKey: IndentKey,
): Transaction => {
  const { selection, doc } = tr;
  if (!selection || !doc) return tr;

  if (!(selection instanceof TextSelection || selection instanceof AllSelection)) return tr;

  const { from, to } = selection;

  doc.nodesBetween(from, to, (node, pos) => {
    const nodeType = node.type;

    if (nodeType.name === 'paragraph' || nodeType.name === 'blockquote') {
      tr = setNodeIndentMarkup(tr, pos, delta, indentKey);
      return false;
    } else if (isList(node, schema)) return false;
    return true;
  });

  return tr;
};

export const indentCommand = (view: EditorView, delta: number) => {
  const { state } = view;
  const { schema, selection } = state;

  const tr = setIndent(state.tr.setSelection(selection), schema, delta, 'indent');
  if (tr.docChanged) {
    view.dispatch(tr);
    return true;
  }

  return false;
};

export const textIndentCommand = (view: EditorView, delta: number) => {
  const { state } = view;
  const { schema, selection } = state;

  const tr = setIndent(state.tr.setSelection(selection), schema, delta, 'textIndent');
  if (tr.docChanged) {
    view.dispatch(tr);
    return true;
  }

  return false;
};
