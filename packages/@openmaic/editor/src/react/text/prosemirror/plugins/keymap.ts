import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import type { Schema } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import type { Command } from 'prosemirror-state';
import {
  toggleMark,
  selectParentNode,
  joinUp,
  joinDown,
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlockKeepMarks,
} from 'prosemirror-commands';

export const buildKeymap = (schema: Schema) => {
  const keys: Record<string, Command> = {};
  const bind = (key: string, cmd: Command) => (keys[key] = cmd);

  bind('Alt-ArrowUp', joinUp);
  bind('Alt-ArrowDown', joinDown);
  bind('Mod-z', undo);
  bind('Mod-y', redo);
  bind('Backspace', undoInputRule);
  bind('Escape', selectParentNode);
  bind('Mod-b', toggleMark(schema.marks.strong));
  bind('Mod-i', toggleMark(schema.marks.em));
  bind('Mod-u', toggleMark(schema.marks.underline));
  bind('Mod-d', toggleMark(schema.marks.strikethrough));
  bind('Mod-e', toggleMark(schema.marks.code));
  bind('Mod-;', toggleMark(schema.marks.superscript));
  bind(`Mod-'`, toggleMark(schema.marks.subscript));
  bind(
    'Enter',
    chainCommands(
      splitListItem(schema.nodes.list_item),
      newlineInCode,
      createParagraphNear,
      liftEmptyBlock,
      splitBlockKeepMarks,
    ),
  );
  bind('Mod-[', liftListItem(schema.nodes.list_item));
  bind('Mod-]', sinkListItem(schema.nodes.list_item));
  bind('Tab', sinkListItem(schema.nodes.list_item));

  return keys;
};
