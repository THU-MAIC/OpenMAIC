import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';

const isEmptyParagraph = (node: Node) => {
  return node.type.name === 'paragraph' && node.nodeSize === 2;
};

export const placeholderPlugin = (placeholder: string) => {
  return new Plugin({
    props: {
      decorations(state) {
        const { $from } = state.selection;
        if (isEmptyParagraph($from.parent)) {
          const decoration = Decoration.node($from.before(), $from.after(), {
            'data-placeholder': placeholder,
          });
          return DecorationSet.create(state.doc, [decoration]);
        }
      },
    },
  });
};
