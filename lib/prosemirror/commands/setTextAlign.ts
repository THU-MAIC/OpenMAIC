import type { Schema, Node, NodeType } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

export const setTextAlign = (tr: Transaction, schema: Schema, alignment: string) => {
  const { selection, doc } = tr;
  if (!selection || !doc) return tr;

  const { from, to } = selection;
  const { nodes } = schema;

  const blockquote = nodes.blockquote;
  const listItem = nodes.list_item;
  const paragraph = nodes.paragraph;

  interface Task {
    node: Node;
    pos: number;
    nodeType: NodeType;
  }

  const tasks: Task[] = [];
  alignment = alignment || '';

  const allowedNodeTypes = new Set([blockquote, listItem, paragraph]);

  doc.nodesBetween(from, to, (node, pos) => {
    const nodeType = node.type;
    const align = node.attrs.align || '';
    if (align !== alignment && allowedNodeTypes.has(nodeType)) {
      tasks.push({
        node,
        pos,
        nodeType,
      });
    }
    return true;
  });

  if (!tasks.length) return tr;

  tasks.forEach((task) => {
    const { node, pos, nodeType } = task;
    let { attrs } = node;
    if (alignment) attrs = { ...attrs, align: alignment };
    else attrs = { ...attrs, align: null };
    tr = tr.setNodeMarkup(pos, nodeType, attrs, node.marks);
  });

  return tr;
};

export const alignmentCommand = (view: EditorView, alignment: string) => {
  const { state } = view;
  const { schema, selection } = state;
  const tr = setTextAlign(state.tr.setSelection(selection), schema, alignment);
  view.dispatch(tr);
};
