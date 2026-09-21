import { toggleMark } from 'prosemirror-commands';
import { Fragment, type Mark, type MarkType, type Node } from 'prosemirror-model';
import type { Command, Transaction } from 'prosemirror-state';
import { isInlineContainer } from '../inlineContainerMarks';

// Materialize an inherited format on editable text before changing a portion of
// it. Keep the structural boxes and all unrelated typography intact.
function distributeMark(node: Node, type: MarkType, inherited?: Mark): Node {
  const mark = type.isInSet(node.marks) ?? inherited;
  if (node.isLeaf) return mark ? node.mark(mark.addToSet(node.marks)) : node;
  const children: Node[] = [];
  node.forEach((child) => children.push(distributeMark(child, type, mark)));
  return node
    .copy(Fragment.fromArray(children))
    .mark(isInlineContainer(node) ? type.removeFromSet(node.marks) : node.marks);
}

export function materializeInlineMark(tr: Transaction, type: MarkType): void {
  const selection = tr.selection;
  const storedMarks = tr.storedMarks;
  const { from, to } = selection;
  tr.doc.descendants((node, pos) => {
    if (
      isInlineContainer(node) &&
      type.isInSet(node.marks) &&
      from < pos + node.nodeSize &&
      to > pos
    ) {
      tr.replaceWith(pos, pos + node.nodeSize, distributeMark(node, type));
      return false;
    }
  });
  if (tr.docChanged) {
    tr.setSelection(selection.getBookmark().resolve(tr.doc));
    tr.setStoredMarks(storedMarks);
  }
}

export const toggleInlineMark =
  (type: MarkType, attrs?: Record<string, unknown>): Command =>
  (state, dispatch) => {
    const tr = state.tr;
    materializeInlineMark(tr, type);
    const prepared = tr.docChanged ? state.apply(tr) : state;
    return toggleMark(type, attrs)(
      prepared,
      dispatch &&
        ((result) => {
          if (!tr.docChanged) {
            dispatch(result);
            return;
          }
          for (const step of result.steps) tr.step(step);
          tr.setSelection(result.selection.getBookmark().resolve(tr.doc));
          tr.setStoredMarks(result.storedMarks);
          dispatch(tr.scrollIntoView());
        }),
    );
  };
