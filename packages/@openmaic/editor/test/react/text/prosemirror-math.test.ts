// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { EditorState } from 'prosemirror-state';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../../src/react/text/prosemirror/document';

describe('inline imported formulas', () => {
  it('keeps KaTeX as one formula rather than parsing MathML, annotations and glyphs as text', () => {
    const latex = String.raw`\frac{i^{\left(m\right)}}{m}`;
    const html = `<p>用<span style="color:red;font-size:24px">${katex.renderToString(latex)}</span>表示</p>`;
    const doc = createTextDocument(html);
    expect(doc.textContent).toBe(`用${latex}表示`);
    expect(doc.textBetween(0, doc.content.size, '\n')).toBe(`用${latex}表示`);
    const formula = doc.firstChild!.child(1);
    expect(formula.type.name).toBe('inline_math');
    expect(formula.attrs.latex).toBe(latex);
    const host = document.createElement('div');
    host.innerHTML = serializeTextDocument(doc);
    expect(host.querySelectorAll('.katex')).toHaveLength(1);
    expect(host.querySelector('.katex-html')).not.toBeNull();
    expect(host.querySelector('.katex')?.getAttribute('contenteditable')).toBe('false');
    expect(createTextDocument(host.innerHTML).eq(doc)).toBe(true);
  });
  it('preserves formulas while inserting and deleting adjacent text', () => {
    const doc = createTextDocument(`<p>A${katex.renderToString('i^{(4)}=8\\%')}B</p>`);
    const state = EditorState.create({ doc });
    const edited = state.tr.insertText('x', 1).delete(1, 2).doc;
    expect(edited.eq(doc)).toBe(true);
    expect(createTextDocument(serializeTextDocument(edited)).eq(doc)).toBe(true);
  });
});
