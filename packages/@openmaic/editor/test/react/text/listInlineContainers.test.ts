// @vitest-environment jsdom
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createTextDocument } from '../../../src/react/text/prosemirror/document';
import { buildKeymap } from '../../../src/react/text/prosemirror/plugins/keymap';
import { history, undo } from 'prosemirror-history';

const boxes = {
  pptx_tab_column: (text: string) =>
    `<span data-pptx-tab-column="true" style="display:inline-block;width:100px">${text}</span>`,
  inline_text_box: (text: string) =>
    `<span style="display:inline-block;width:100px">${text}</span>`,
};
function selectText(html: string, offset = 1, end = offset) {
  const doc = createTextDocument(html);
  let start = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === 'ABCD') start = pos;
  });
  expect(start).toBeGreaterThan(-1);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, start + offset, start + end),
  });
}
function press(state: EditorState, key: string) {
  let next = state;
  expect(buildKeymap(state.schema)[key](state, (tr) => (next = state.apply(tr)))).toBe(true);
  next.doc.check();
  return next;
}
for (const [type, box] of Object.entries(boxes)) {
  describe(`list keyboard commands inside ${type}`, () => {
    it.each([0, 1, 4])('splits at offset %i, retaining boxes and caret', (offset) => {
      const next = press(
        selectText(`<ul><li><p>${box('ABCD')}Next</p></li></ul>`, offset),
        'Enter',
      );
      const list = next.doc.firstChild!;
      expect(list.childCount).toBe(2);
      expect(list.child(0).textContent).toBe('ABCD'.slice(0, offset));
      expect(list.child(1).textContent).toBe('ABCD'.slice(offset) + 'Next');
      for (let i = 0; i < 2; i++) {
        const column = list.child(i).firstChild!.firstChild!;
        expect(column.type.name).toBe(type);
        expect(column.attrs.width).toBe('100px');
      }
      expect(next.selection.empty).toBe(true);
      expect(next.selection.$from.parent.type.name).toBe(type);
      expect(next.selection.$from.parentOffset).toBe(0);
      expect(next.selection.$from.index(1)).toBe(1);
    });
    it('exits the list when Enter is pressed again in the new empty item', () => {
      const first = press(selectText(`<ul><li><p>${box('ABCD')}</p></li></ul>`, 4), 'Enter');
      expect(first.doc.firstChild!.childCount).toBe(2);
      const next = press(first, 'Enter');
      expect(next.doc.childCount).toBe(2);
      expect(next.doc.firstChild!.type.name).toBe('bullet_list');
      expect(next.doc.firstChild!.childCount).toBe(1);
      expect(next.doc.lastChild!.type.name).toBe('paragraph');
      expect(next.doc.lastChild!.content.size).toBe(0);
      expect(next.selection.$from.parent).toBe(next.doc.lastChild);
    });
    it('outdents a new empty nested item on the next Enter', () => {
      const first = press(
        selectText(`<ul><li><p>Parent</p><ul><li><p>${box('ABCD')}</p></li></ul></li></ul>`, 4),
        'Enter',
      );
      const next = press(first, 'Enter');
      const outer = next.doc.firstChild!;
      expect(outer.childCount).toBe(2);
      expect(outer.firstChild!.lastChild!.type.name).toBe('bullet_list');
      expect(outer.firstChild!.lastChild!.childCount).toBe(1);
      expect(outer.lastChild!.firstChild!.content.size).toBe(0);
      expect(next.selection.$from.node(2)).toBe(outer.lastChild);
      expect(next.selection.$from.parent.type.name).toBe('paragraph');
    });
    it('splits safely when deleting the selection also removes its inline wrapper', () => {
      const state = selectText(`<ul><li><p>${box('ABCD')}</p><p>Next</p></li></ul>`, 0);
      const end = state.selection.$from.end(3);
      const selected = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, state.selection.from, end)),
      );
      const next = press(selected, 'Enter');
      const list = next.doc.firstChild!;
      expect(list.childCount).toBe(2);
      expect(list.child(0).firstChild!.type.name).toBe('paragraph');
      expect(list.child(0).textContent).toBe('');
      expect(list.child(1).firstChild!.type.name).toBe('paragraph');
      expect(list.child(1).textContent).toBe('Next');
      expect(next.selection.$from.node(2)).toBe(list.child(1));
      expect(next.selection.empty).toBe(true);
    });

    it('deletes selected text while splitting', () => {
      const next = press(selectText(`<ol><li><p>${box('ABCD')}Next</p></li></ol>`, 1, 3), 'Enter');
      expect(next.doc.firstChild!.childCount).toBe(2);
      expect(next.doc.firstChild!.child(0).textContent).toBe('A');
      expect(next.doc.firstChild!.child(1).textContent).toBe('DNext');
      expect(next.selection.empty).toBe(true);
    });
    it.each(['Tab', 'Mod-]'])('indents with %s preserving selection', (key) => {
      const initial = selectText(
        `<ul><li><p>Previous</p></li><li><p>${box('ABCD')}Next</p></li></ul>`,
        1,
        3,
      );
      const nested = press(initial, key);
      expect(nested.doc.firstChild!.childCount).toBe(1);
      expect(nested.doc.firstChild!.firstChild!.lastChild!.type.name).toBe('bullet_list');
      expect(nested.selection.$from.parent.type.name).toBe(type);
      expect(nested.doc.textBetween(nested.selection.from, nested.selection.to)).toBe('BC');
    });
    it('lifts a top-level item with Mod-[ preserving the text selection', () => {
      const initial = selectText(`<ul><li><p>${box('ABCD')}Next</p></li></ul>`, 1, 3);
      const lifted = press(initial, 'Mod-[');
      expect(lifted.doc.firstChild!.type.name).toBe('paragraph');
      expect(lifted.doc.firstChild!.eq(initial.doc.firstChild!.firstChild!.firstChild!)).toBe(true);
      expect(lifted.selection.$from.parent.type.name).toBe(type);
      expect(lifted.doc.textBetween(lifted.selection.from, lifted.selection.to)).toBe('BC');
    });
    it('splits a nested item at the existing list depth', () => {
      const next = press(
        selectText(`<ul><li><p>Parent</p><ul><li><p>${box('ABCD')}</p></li></ul></li></ul>`),
        'Enter',
      );
      const outer = next.doc.firstChild!;
      expect(outer.childCount).toBe(1);
      const inner = outer.firstChild!.lastChild!;
      expect(inner.childCount).toBe(2);
      expect(inner.child(0).textContent).toBe('A');
      expect(inner.child(1).textContent).toBe('BCD');
    });
  });
}

it('undo restores the empty wrapped list item in one step', () => {
  const first = press(
    selectText(`<ul><li><p>${boxes.pptx_tab_column('ABCD')}</p></li></ul>`, 4),
    'Enter',
  );
  const state = EditorState.create({
    doc: first.doc,
    selection: first.selection,
    plugins: [history()],
  });
  let next = press(state, 'Enter');
  expect(undo(next, (tr) => (next = next.apply(tr)))).toBe(true);
  expect(next.doc.eq(state.doc)).toBe(true);
  expect(next.selection.eq(state.selection)).toBe(true);
});

it('keeps a formula-only wrapped paragraph as list content', () => {
  const doc = createTextDocument(
    `<ul><li><p>${boxes.pptx_tab_column('<span data-inline-math="x"></span>')}</p></li></ul>`,
  );
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 4) });
  const next = press(state, 'Enter');
  expect(next.doc.childCount).toBe(1);
  expect(next.doc.firstChild!.childCount).toBe(2);
  expect(next.doc.firstChild!.lastChild!.firstChild!.firstChild!.firstChild!.type.name).toBe(
    'inline_math',
  );
});
