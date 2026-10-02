import { chainCommands, liftEmptyBlock, splitBlock } from 'prosemirror-commands';
import { splitListItem } from 'prosemirror-schema-list';
import { isInlineContainer } from '../inlineContainerMarks';
import type { NodeType } from 'prosemirror-model';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';

/** Split editable inline wrappers, their paragraph, and its containing list item. */
export const splitListItemInInlineContainer = (itemType: NodeType): Command => {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    let paragraphDepth = $from.depth;
    while (paragraphDepth > 0 && !$from.node(paragraphDepth).isTextblock) paragraphDepth--;
    if (
      paragraphDepth < 2 ||
      ($from.depth === paragraphDepth && $to.depth === paragraphDepth) ||
      $from.node(paragraphDepth - 1).type !== itemType ||
      $to.sharedDepth($from.pos) < paragraphDepth
    )
      return false;

    // Empty inline wrappers are structural content, but should behave like an
    // empty paragraph for Enter: exit a top-level list or outdent a nested item.
    // Keep atoms (formulas, spacers, hard breaks) even when textContent is empty.
    let emptyWrappers = true;
    $from.node(paragraphDepth).descendants((node) => {
      if (!isInlineContainer(node)) emptyWrappers = false;
    });
    if (state.selection.empty && emptyWrappers) {
      const start = $from.start(paragraphDepth);
      const tr = state.tr.delete(start, $from.end(paragraphDepth));
      tr.setSelection(TextSelection.create(tr.doc, start));
      const prepared = EditorState.create({ doc: tr.doc, selection: tr.selection });
      return chainCommands(
        splitListItem(itemType),
        liftEmptyBlock,
        splitBlock,
      )(
        prepared,
        dispatch &&
          ((result) => {
            for (const step of result.steps) tr.step(step);
            tr.setSelection(result.selection.getBookmark().resolve(tr.doc));
            dispatch(tr.scrollIntoView());
          }),
      );
    }

    // Delete first: a selection can remove its inline wrapper, changing the
    // depth splitBlock must split. Its input state must reflect that new depth.
    const tr = state.tr.deleteSelection();
    const afterDeletion = EditorState.create({ doc: tr.doc, selection: tr.selection });
    return splitBlock(
      afterDeletion,
      dispatch &&
        ((split) => {
          // Keep deletion and both splits in one transaction for undo/selection.
          for (const step of split.steps) tr.step(step);
          tr.setSelection(split.selection.getBookmark().resolve(tr.doc));
          const secondParagraph = tr.selection.$from.before(paragraphDepth);
          dispatch(tr.split(secondParagraph).scrollIntoView());
        }),
    );
  };
};
