// @vitest-environment jsdom
import { AllSelection, TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it } from 'vitest';
import { executeTextCommand } from '../../../src/react/text/commandExecutor';
import { initTextEditor } from '../../../src/react/text/prosemirror';
import { serializeTextDocument } from '../../../src/react/text/prosemirror/document';
import type { TextEditCommand } from '../../../src/react/text/types';

const views: ReturnType<typeof initTextEditor>[] = [];

function editor(html = '<p>Hello</p>') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = initTextEditor(host, html, {});
  views.push(view);
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  return view;
}

function htmlAfter(command: TextEditCommand, initial?: string): string {
  const view = editor(initial);
  executeTextCommand(view, command);
  return serializeTextDocument(view.state.doc);
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
});

describe('executeTextCommand', () => {
  it.each([
    [{ command: 'bold' }, '<strong>'],
    [{ command: 'em' }, '<em>'],
    [{ command: 'underline' }, 'text-decoration: underline'],
    [{ command: 'strikethrough' }, 'line-through'],
    [{ command: 'subscript' }, '<sub>'],
    [{ command: 'superscript' }, '<sup>'],
    [{ command: 'code' }, '<code>'],
    [{ command: 'blockquote' }, '<blockquote>'],
    [{ command: 'fontname', value: 'Inter' }, 'font-family: &quot;Inter&quot;'],
    [{ command: 'fontsize', value: '28px' }, 'font-size: 28px'],
    [{ command: 'forecolor', value: '#ff0000' }, 'color: rgb(255, 0, 0)'],
    [{ command: 'backcolor', value: '#00ff00' }, 'background-color: rgb(0, 255, 0)'],
    [{ command: 'align', value: 'center' }, 'text-align: center'],
    [{ command: 'bulletList', value: 'disc' }, '<ul'],
    [{ command: 'orderedList', value: 'decimal' }, '<ol'],
    [{ command: 'link', value: 'https://maic.chat' }, 'href="https://maic.chat"'],
  ] satisfies Array<[TextEditCommand, string]>)('applies %o', (command, expected) => {
    expect(htmlAfter(command)).toContain(expected);
  });

  it('supports font size stepping, indent, insertion, replacement and clear', () => {
    expect(
      htmlAfter({ command: 'fontsize-add' }, '<p><span style="font-size: 16px">A</span></p>'),
    ).toContain('font-size: 18px');
    expect(htmlAfter({ command: 'fontsize-reduce', value: '20' })).toContain('font-size: 12px');
    expect(htmlAfter({ command: 'indent', value: '2' })).toContain('data-indent="2"');
    expect(htmlAfter({ command: 'textIndent', value: '3' })).toContain('text-indent: 3em');
    expect(htmlAfter({ command: 'insert', value: 'X' })).toContain('X');
    expect(htmlAfter({ command: 'replace', value: 'Replaced' })).toContain('Replaced');
    expect(htmlAfter({ command: 'clear' }, '<p><strong>Hello</strong></p>')).not.toContain(
      '<strong>',
    );
  });

  it('updates and removes an existing link', () => {
    const view = editor('<p><a href="https://old.test">Hello</a></p>');
    executeTextCommand(view, { command: 'link', value: 'https://new.test' });
    expect(serializeTextDocument(view.state.doc)).toContain('href="https://new.test"');
    executeTextCommand(view, { command: 'link', value: '' });
    expect(serializeTextDocument(view.state.doc)).not.toContain('<a');
  });
});

describe('lists inside imported tab columns', () => {
  const initial =
    '<p><span data-pptx-tab-column="true" style="display:inline-block;width:100px">ABCD</span>Next</p>';
  it.each(['bulletList', 'orderedList'] as const)(
    'applies %s to a selection inside a column and preserves selection',
    (command) => {
      const view = editor(initial);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)));
      executeTextCommand(view, { command, value: command === 'bulletList' ? 'disc' : 'decimal' });
      expect(view.state.doc.firstChild!.type.name).toBe(
        command === 'bulletList' ? 'bullet_list' : 'ordered_list',
      );
      expect(view.state.selection.$from.parent.type.name).toBe('pptx_tab_column');
      expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
        'B',
      );
      expect(serializeTextDocument(view.state.doc)).toContain('data-pptx-tab-column="true"');
    },
  );
  it('toggles a list off with the caret inside a column', () => {
    const view = editor(`<ul><li>${initial}</li></ul>`);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)));
    executeTextCommand(view, { command: 'bulletList', value: '' });
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(view.state.selection.$from.parent.type.name).toBe('pptx_tab_column');
    expect(view.state.selection.empty).toBe(true);
  });
  it('switches list type from inside a column without creating a nested list', () => {
    const view = editor(`<ul><li>${initial}</li></ul>`);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5, 6)));
    executeTextCommand(view, { command: 'orderedList', value: 'decimal' });
    expect(view.state.doc.firstChild!.type.name).toBe('ordered_list');
    expect(view.state.doc.firstChild!.firstChild!.firstChild!.type.name).toBe('paragraph');
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe(
      'B',
    );
  });
  it('wraps both paragraphs when the selection crosses column boundaries', () => {
    const view = editor(initial + initial);
    const secondParagraph = view.state.doc.firstChild!.nodeSize;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, secondParagraph + 4)),
    );
    executeTextCommand(view, { command: 'bulletList', value: 'disc' });
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list');
    expect(view.state.doc.firstChild!.childCount).toBe(2);
    expect(view.state.selection.$from.parent.type.name).toBe('pptx_tab_column');
    expect(view.state.selection.$to.parent.type.name).toBe('pptx_tab_column');
  });
});
