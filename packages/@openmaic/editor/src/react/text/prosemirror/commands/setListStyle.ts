import type { EditorView } from 'prosemirror-view';
import { isList } from '../utils';

type Style = Record<string, string>;

export const setListStyle = (view: EditorView, style: Style | Style[]) => {
  const { state } = view;
  const { schema, selection } = state;
  const tr = state.tr.setSelection(selection);

  const { doc } = tr;
  if (!doc) return tr;

  const { from, to } = selection;
  doc.nodesBetween(from, to, (node, pos) => {
    if (isList(node, schema)) {
      if (from - 3 <= pos && to + 3 >= pos + node.nodeSize) {
        const styles = Array.isArray(style) ? style : [style];

        for (const style of styles) {
          tr.setNodeAttribute(pos, style.key, style.value);
        }
      }
    }
    return false;
  });

  view.dispatch(tr);
};
