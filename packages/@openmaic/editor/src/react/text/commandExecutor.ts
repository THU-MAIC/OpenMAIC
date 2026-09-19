import { lift, wrapIn } from 'prosemirror-commands';
import type { EditorView } from 'prosemirror-view';
import { toggleInlineMark, materializeInlineMark } from './prosemirror/commands/toggleInlineMark';
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
  if (markName === 'fontname' || markName === 'fontsize') {
    const { from, to } = view.state.selection;
    const tr = view.state.tr;
    const mark = markType.create(attrs);
    // Font marks on inline containers define the context for em/ch dimensions.
    // Range-based addMark also visits those containers and its inverse can copy
    // their marks onto children. Replace only selected leaves for exact undo.
    view.state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (!node.isInline || !node.isLeaf || !parent?.type.allowsMarkType(markType)) return;
      const start = Math.max(pos, from);
      const end = Math.min(pos + node.nodeSize, to);
      tr.replaceWith(start, end, node.cut(start - pos, end - pos).mark(mark.addToSet(node.marks)));
    });
    view.dispatch(tr);
    return;
  }
  addMark(view, markType.create(attrs));
}

function toggleTextMark(view: EditorView, markName: string, selectAll: boolean) {
  const markType = view.state.schema.marks[markName];
  if (!markType) return;
  if (selectAll) autoSelectAll(view);
  toggleInlineMark(markType)(view.state, view.dispatch);
}

function clearTextFormatting(view: EditorView) {
  autoSelectAll(view);
  const { $from, $to } = view.state.selection;
  const tr = view.state.tr;
  // Container font family/size are the local typography context. Clearing a
  // text selection removes its own overrides, not that structural context.
  for (const type of Object.values(view.state.schema.marks)) {
    if (type.name === 'fontname' || type.name === 'fontsize') {
      tr.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
        if (node.isInline && node.isLeaf) {
          if (!type.isInSet(node.marks)) return;
          const from = Math.max(pos, $from.pos);
          const to = Math.min(pos + node.nodeSize, $to.pos);
          // removeMark also visits enclosing inline nodes, including when its
          // range starts inside them. Replace just the selected leaf so undo
          // cannot restore a container mark onto its descendants.
          tr.replaceWith(
            from,
            to,
            node.cut(from - pos, to - pos).mark(type.removeFromSet(node.marks)),
          );
        }
      });
    } else {
      materializeInlineMark(tr, type);
      tr.removeMark($from.pos, $to.pos, type);
    }
  }
  view.dispatch(tr);
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
    else toggleInlineMark(markType)(view.state, view.dispatch);
    return;
  }

  if (!href) return;
  autoSelectAll(view);
  toggleInlineMark(markType, { href, title: href })(view.state, view.dispatch);
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
