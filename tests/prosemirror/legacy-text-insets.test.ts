// @vitest-environment jsdom
import { undo, redo } from 'prosemirror-history';
import { joinBackward } from 'prosemirror-commands';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { createDocument, initProsemirrorEditor } from '@/lib/prosemirror';
import { autoSelectAll, selectAllText } from '@/lib/prosemirror/utils';

const importedLabels = [
  '<div data-pptx-text-insets="true" style="padding: 0pt"><p>Imported</p></div>',
  '<div data-pptx-text-insets="true" style="padding: 3.6pt 7.2pt"><p>Imported</p></div>',
  '<div style="padding: 4pt 8pt"><p>Imported</p></div>',
  '<div data-pptx-text-insets="true"><p>Imported</p></div>',
];

describe('legacy text insets', () => {
  it.each(importedLabels)('keeps insets through edit, save, undo and redo: %s', (content) => {
    const host = document.createElement('div');
    document.body.append(host);
    const view = initProsemirrorEditor(host, content, {});
    try {
      const original = view.state.doc;
      expect(original.firstChild?.type.name).toBe('text_container');
      const source = document.createElement('div');
      source.innerHTML = content;
      const container = source.firstElementChild as HTMLElement;
      expect(original.firstChild?.attrs).toEqual({
        padding: container.style.padding,
        pptxTextInsets: container.getAttribute('data-pptx-text-insets') === 'true',
      });

      view.dispatch(view.state.tr.insertText('Edited ', 2));
      expect(view.state.doc.textContent).toBe('Edited Imported');
      const edited = view.state.doc;
      // The legacy component saves the live editor DOM, not a separate serializer.
      expect(createDocument(view.dom.innerHTML).eq(edited)).toBe(true);

      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(original)).toBe(true);
      expect(createDocument(view.dom.innerHTML).eq(original)).toBe(true);
      expect(redo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(edited)).toBe(true);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('keeps the container when backspacing at the start or replacing all label text', () => {
    const host = document.createElement('div');
    const view = initProsemirrorEditor(host, importedLabels[1], {});
    try {
      const original = view.state.doc;
      expect(joinBackward(view.state, view.dispatch)).toBe(false);
      expect(view.state.doc.eq(original)).toBe(true);
      autoSelectAll(view);
      view.dispatch(view.state.tr.insertText('Replacement'));
      const replaced = view.state.doc;
      expect(replaced.firstChild?.attrs).toEqual(original.firstChild?.attrs);
      expect(replaced.textContent).toBe('Replacement');
      expect(createDocument(view.dom.innerHTML).eq(replaced)).toBe(true);
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(original)).toBe(true);
      expect(redo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(replaced)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it('keeps ordinary paragraphs and lists without adding an inset container', () => {
    const doc = createDocument(
      '<div><p>Plain <strong>bold</strong></p><ul><li><p>Item</p></li></ul></div>',
    );
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(doc.child(0).lastChild?.marks[0].type.name).toBe('strong');
    expect(doc.child(1).type.name).toBe('bullet_list');
    expect(doc.textContent).toBe('Plain boldItem');
    let state = EditorState.create({ doc });
    selectAllText(state, (tr) => {
      state = state.apply(tr);
    });
    state = state.apply(state.tr.insertText('Plain replacement'));
    expect(state.doc.firstChild?.type.name).toBe('paragraph');
    expect(state.doc.textContent).toBe('Plain replacement');
  });
});
