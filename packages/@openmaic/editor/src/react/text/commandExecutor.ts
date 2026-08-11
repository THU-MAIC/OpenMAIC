import { lift, toggleMark, wrapIn } from 'prosemirror-commands';
import type { EditorView } from 'prosemirror-view';
import { replaceText } from './prosemirror/commands/replaceText';
import { setListStyle } from './prosemirror/commands/setListStyle';
import { alignmentCommand } from './prosemirror/commands/setTextAlign';
import { indentCommand, textIndentCommand } from './prosemirror/commands/setTextIndent';
import { toggleList } from './prosemirror/commands/toggleList';
import {
  addMark,
  autoSelectAll,
  findNodesWithSameMark,
  getFontsize,
  getTextAttrs,
  isActiveOfParentNodeType,
  markActive,
} from './prosemirror/utils';
import type { TextEditCommand } from './types';

function applyMark(view: EditorView, markName: string, attrs?: Record<string, string>) {
  const markType = view.state.schema.marks[markName];
  if (!markType) return;
  autoSelectAll(view);
  addMark(view, markType.create(attrs));
}

function toggleTextMark(view: EditorView, markName: string, selectAll: boolean) {
  const markType = view.state.schema.marks[markName];
  if (!markType) return;
  if (selectAll) autoSelectAll(view);
  toggleMark(markType)(view.state, view.dispatch);
}

function clearTextFormatting(view: EditorView) {
  autoSelectAll(view);
  const { $from, $to } = view.state.selection;
  view.dispatch(view.state.tr.removeMark($from.pos, $to.pos));
  setListStyle(view, [
    { key: 'fontsize', value: '' },
    { key: 'color', value: '' },
  ]);
}

function setTextLink(view: EditorView, href: string) {
  const markType = view.state.schema.marks.link;
  const { from, to } = view.state.selection;
  const result = findNodesWithSameMark(view.state.doc, from, to, markType);

  if (result) {
    if (href) {
      addMark(view, markType.create({ href, title: href }), {
        from: result.from.pos,
        to: result.to.pos + 1,
      });
    } else {
      view.dispatch(view.state.tr.removeMark(result.from.pos, result.to.pos + 1, markType));
    }
    return;
  }

  if (markActive(view.state, markType)) {
    if (href) addMark(view, markType.create({ href, title: href }));
    else toggleMark(markType)(view.state, view.dispatch);
    return;
  }

  if (!href) return;
  autoSelectAll(view);
  toggleMark(markType, { href, title: href })(view.state, view.dispatch);
}

function toggleTextList(view: EditorView, ordered: boolean, listStyleType = '') {
  const attrs = getTextAttrs(view);
  const listType = ordered
    ? view.state.schema.nodes.ordered_list
    : view.state.schema.nodes.bullet_list;
  toggleList(listType, view.state.schema.nodes.list_item, listStyleType, {
    color: attrs.color,
    fontsize: attrs.fontsize,
  })(view.state, view.dispatch);
}

export function executeTextCommand(view: EditorView, command: TextEditCommand): void {
  switch (command.command) {
    case 'bold':
    case 'em':
    case 'underline':
    case 'strikethrough':
      toggleTextMark(view, command.command === 'bold' ? 'strong' : command.command, true);
      return;
    case 'subscript':
    case 'superscript':
    case 'code':
      toggleTextMark(view, command.command, false);
      return;
    case 'blockquote':
      if (isActiveOfParentNodeType('blockquote', view.state)) {
        lift(view.state, view.dispatch);
      } else {
        wrapIn(view.state.schema.nodes.blockquote)(view.state, view.dispatch);
      }
      return;
    case 'fontname':
      applyMark(view, 'fontname', { fontname: command.value });
      return;
    case 'fontsize':
      applyMark(view, 'fontsize', { fontsize: command.value });
      setListStyle(view, { key: 'fontsize', value: command.value });
      return;
    case 'fontsize-add': {
      const fontsize = `${getFontsize(view) + (command.value ? Number(command.value) : 2)}px`;
      executeTextCommand(view, { command: 'fontsize', value: fontsize });
      return;
    }
    case 'fontsize-reduce': {
      const next = Math.max(12, getFontsize(view) - (command.value ? Number(command.value) : 2));
      executeTextCommand(view, { command: 'fontsize', value: `${next}px` });
      return;
    }
    case 'forecolor':
      applyMark(view, 'forecolor', { color: command.value });
      setListStyle(view, { key: 'color', value: command.value });
      return;
    case 'backcolor':
      applyMark(view, 'backcolor', { backcolor: command.value });
      return;
    case 'align':
      alignmentCommand(view, command.value);
      return;
    case 'indent':
      indentCommand(view, Number(command.value));
      return;
    case 'textIndent':
      textIndentCommand(view, Number(command.value));
      return;
    case 'bulletList':
      toggleTextList(view, false, command.value);
      return;
    case 'orderedList':
      toggleTextList(view, true, command.value);
      return;
    case 'clear':
      clearTextFormatting(view);
      return;
    case 'link':
      setTextLink(view, command.value ?? '');
      return;
    case 'insert':
      view.dispatch(view.state.tr.insertText(command.value));
      return;
    case 'replace':
      replaceText(view, command.value);
      return;
  }
}

export function executeTextCommands(
  view: EditorView,
  commands: TextEditCommand | readonly TextEditCommand[],
): void {
  const list = Array.isArray(commands) ? commands : [commands];
  for (const command of list) executeTextCommand(view, command);
}
