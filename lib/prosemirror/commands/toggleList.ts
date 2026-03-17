import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import type { Node, NodeType } from 'prosemirror-model';
import type { Transaction, EditorState } from 'prosemirror-state';
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
