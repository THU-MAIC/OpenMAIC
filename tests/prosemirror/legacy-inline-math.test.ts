// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { createDocument, editorHtmlForSave, initProsemirrorEditor } from '@/lib/prosemirror';

/** Ohm's-law source from issue #1868. */
const LATEX = String.raw`I=\frac{U}{R}`;

const OHMS_LAW_HTML = `<p style="font-size:20px">Ohm's law: <span data-inline-math="${LATEX}">${LATEX}</span>, …</p>`;

/**
 * KaTeX wrapper without `data-inline-math`. The legacy parser must read the
 * annotation the same way `@openmaic/editor` does, and must not keep the
 * visible glyph text beside the formula.
 */
const OHMS_LAW_KATEX_HTML = `<p style="font-size:20px">Ohm's law: <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">${LATEX}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">I=UR</span></span>, …</p>`;

function inlineMathLatex(doc: ProseMirrorNode): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'inline_math') found.push(String(node.attrs.latex));
  });
  return found;
}

/**
 * Same save path as the legacy canvas editor: one character typed into the
 * live ProseMirror view, then `editorHtmlForSave` (the string `onUpdate` stores).
 */
function htmlAfterOneCharacterEdit(html: string): string {
  const host = document.createElement('div');
  const view = initProsemirrorEditor(host, html, {});
  try {
    let pos = 1;
    view.state.doc.descendants((node, nodePos) => {
      if (node.type.name === 'inline_math') {
        pos = nodePos;
        return false;
      }
    });
    view.dispatch(view.state.tr.insertText('x', pos));
    return editorHtmlForSave(view.dom);
  } finally {
    view.destroy();
  }
}

/** String `ProsemirrorEditor` passes to `onUpdate`. */
function savedHtml(view: { dom: HTMLElement }): string {
  return editorHtmlForSave(view.dom);
}

function mount(html: string) {
  const host = document.createElement('div');
  return initProsemirrorEditor(host, html, {});
}

function expectFormulaSurvives(html: string) {
  const saved = htmlAfterOneCharacterEdit(html);
  const root = document.createElement('div');
  root.innerHTML = saved;
  const formulas = root.querySelectorAll('span[data-inline-math]');
  expect(formulas).toHaveLength(1);
  expect(formulas[0].getAttribute('data-inline-math')).toBe(LATEX);
  expect(formulas[0].textContent).toBe(LATEX);
  expect(root.querySelector('.katex')).toBeNull();
  expect(root.textContent).toContain(`Ohm's law: x${LATEX}, …`);
  expect(root.textContent).not.toContain('I=UR');

  const reopened = createDocument(saved);
  expect(inlineMathLatex(reopened)).toEqual([LATEX]);
  expect(reopened.textContent).toBe(`Ohm's law: x${LATEX}, …`);
}

describe('legacy canvas inline formulas', () => {
  it("keeps the Ohm's-law formula when one character is inserted", () => {
    expectFormulaSurvives(OHMS_LAW_HTML);
  });

  it('reads a KaTeX annotation and keeps it across the same edit', () => {
    expectFormulaSurvives(OHMS_LAW_KATEX_HTML);
  });

  it('does not store a trailing break or separator for a formula-only paragraph', () => {
    const view = mount(`<p><span data-inline-math="${LATEX}">${LATEX}</span></p>`);
    try {
      const saved = savedHtml(view);
      expect(saved).toBe(`<p style=""><span data-inline-math="${LATEX}">${LATEX}</span></p>`);
      expect(inlineMathLatex(createDocument(saved))).toEqual([LATEX]);
    } finally {
      view.destroy();
    }
  });

  it('does not store a trailing break or separator when the paragraph ends on the formula', () => {
    const view = mount(`<p>Ohm's law <span data-inline-math="${LATEX}">${LATEX}</span></p>`);
    try {
      let pos = 1;
      view.state.doc.descendants((node, nodePos) => {
        if (node.type.name === 'inline_math') {
          pos = nodePos;
          return false;
        }
      });
      view.dispatch(view.state.tr.insertText('x', pos));
      const saved = savedHtml(view);
      expect(saved).toBe(
        `<p style="">Ohm's law x<span data-inline-math="${LATEX}">${LATEX}</span></p>`,
      );
      expect(inlineMathLatex(createDocument(saved))).toEqual([LATEX]);
    } finally {
      view.destroy();
    }
  });

  it('keeps the sole break in an empty paragraph', () => {
    const view = mount('<p></p>');
    try {
      expect(savedHtml(view)).toBe('<p style=""><br class="ProseMirror-trailingBreak"></p>');
    } finally {
      view.destroy();
    }
  });

  it('does not rewrite a text paragraph that shares a box with an empty paragraph', () => {
    const view = mount('<p>hello <strong>there</strong></p><p></p>');
    try {
      expect(savedHtml(view)).toBe(view.dom.innerHTML);
    } finally {
      view.destroy();
    }
  });

  it('keeps an empty data-inline-math value across an edit', () => {
    const saved = htmlAfterOneCharacterEdit('<p>before<span data-inline-math=""></span>after</p>');
    const root = document.createElement('div');
    root.innerHTML = saved;
    const formulas = root.querySelectorAll('span[data-inline-math]');
    expect(formulas).toHaveLength(1);
    expect(formulas[0].getAttribute('data-inline-math')).toBe('');
    expect(inlineMathLatex(createDocument(saved))).toEqual(['']);
  });
});
