import { EditorView } from 'prosemirror-view';
import { Mark, NodeType, Node } from 'prosemirror-model';

export const replaceText = (view: EditorView, newText: string) => {
  const { state } = view;
  const { schema, doc } = state;

  let marks: Mark[] = [];
  let nodeType: NodeType = schema.nodes.paragraph;

  if (doc.content.size > 2) {
    const firstCharPos = doc.resolve(1);

    marks = [...firstCharPos.marks()];

    nodeType = firstCharPos.parent.type;
  }

  const lines = newText.split('\n');

  const newNodes: Node[] = lines.map((line: string) => {
    if (line.trim() === '') return nodeType.create();

    const textNode = schema.text(line, marks);
    return nodeType.create(null, textNode);
  });

  const tr = state.tr;

  tr.replaceWith(0, doc.content.size, newNodes);

  view.dispatch(tr);
};
