import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { toggleInlineMark } from '../commands/toggleInlineMark';
import { splitListItemInInlineContainer } from '../commands/splitListItemInInlineContainer';
import type { Schema } from 'prosemirror-model';
import { undo, redo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import type { Command } from 'prosemirror-state';
import {
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
  bind('Mod-b', toggleInlineMark(schema.marks.strong));
  bind('Mod-i', toggleInlineMark(schema.marks.em));
  bind('Mod-u', toggleInlineMark(schema.marks.underline));
  bind('Mod-d', toggleInlineMark(schema.marks.strikethrough));
  bind('Mod-e', toggleInlineMark(schema.marks.code));
  bind('Mod-;', toggleInlineMark(schema.marks.superscript));
  bind(`Mod-'`, toggleInlineMark(schema.marks.subscript));
  bind(
    'Enter',
    chainCommands(
      splitListItem(schema.nodes.list_item),
      splitListItemInInlineContainer(schema.nodes.list_item),
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
