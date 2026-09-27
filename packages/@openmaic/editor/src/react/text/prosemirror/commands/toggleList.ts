import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import type { Node, NodeType, ResolvedPos } from 'prosemirror-model';
import { TextSelection, type Transaction, type EditorState } from 'prosemirror-state';
import { findParentNode, isList } from '../utils';

type Attr = Record<string, number | string>;

interface TextStyleAttr {
  color?: string;
  fontsize?: string;
}

export const toggleList = (
  listType: NodeType,
  itemType: NodeType,
  listStyleType: string,
  textStyleAttr: TextStyleAttr = {},
) => {
  return (state: EditorState, dispatch: (tr: Transaction) => void) => {
    // List commands expect endpoints directly in textblocks. Editable inline
    // tab columns add a level, so select their containing paragraphs internally
    // and map the user's original caret/selection through the resulting edit.
    const originalSelection = state.selection;
    const paragraphBoundary = (pos: ResolvedPos, end: boolean) => {
      for (let depth = pos.depth; depth > 0; depth--) {
        if (pos.node(depth).isTextblock) return end ? pos.end(depth) : pos.start(depth);
      }
      return pos.pos;
    };
    if (!originalSelection.$from.parent.isTextblock || !originalSelection.$to.parent.isTextblock) {
      const from = paragraphBoundary(originalSelection.$from, false);
      const to = paragraphBoundary(originalSelection.$to, true);
      if (from !== originalSelection.from || to !== originalSelection.to) {
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
        const originalDispatch = dispatch;
        if (originalDispatch) {
          dispatch = (tr) =>
            originalDispatch(tr.setSelection(originalSelection.map(tr.doc, tr.mapping)));
        }
      }
    }
    const { schema, selection } = state;
    const { $from, $to } = selection;
    const range = $from.blockRange($to);

    if (!range) return false;

    const parentList = findParentNode((node: Node) => isList(node, schema))(selection);

    if (range.depth >= 1 && parentList && range.depth - parentList.depth <= 1) {
      if (parentList.node.type === listType && !listStyleType) {
        return liftListItem(itemType)(state, dispatch);
      }

      if (isList(parentList.node, schema) && listType.validContent(parentList.node.content)) {
        const { tr } = state;

        const nodeAttrs: Attr = {
          ...parentList.node.attrs,
          ...textStyleAttr,
        };
        if (listStyleType) nodeAttrs.listStyleType = listStyleType;

        tr.setNodeMarkup(parentList.pos, listType, nodeAttrs);

        if (dispatch) dispatch(tr);

        return false;
      }
    }

    const nodeAttrs: Attr = {
      ...textStyleAttr,
    };
    if (listStyleType) nodeAttrs.listStyleType = listStyleType;

    return wrapInList(listType, nodeAttrs)(state, dispatch);
  };
};
