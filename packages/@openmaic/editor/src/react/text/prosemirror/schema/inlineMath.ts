import katex from 'katex';
import type { NodeSpec } from 'prosemirror-model';

/** Keep rendered formulas opaque to the prose parser, including hidden MathML. */
export const inlineMath: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  leafText: (node) => node.attrs.latex,
  attrs: { latex: {} },
  parseDOM: [
    {
      tag: 'span[data-inline-math]',
      priority: 100,
      getAttrs: (dom) => {
        const latex = (dom as HTMLElement).getAttribute('data-inline-math');
        return latex ? { latex } : false;
      },
    },
    {
      tag: 'span.katex',
      priority: 100,
      getAttrs: (dom) => {
        const latex = (dom as HTMLElement).querySelector(
          'annotation[encoding="application/x-tex"]',
        )?.textContent;
        return latex ? { latex } : false;
      },
    },
  ],
  toDOM: (node) => {
    const host = document.createElement('span');
    // Rebuild trusted markup from the source rather than storing arbitrary HTML.
    katex.render(node.attrs.latex, host, {
      displayMode: false,
      throwOnError: false,
      trust: false,
    });
    const formula = host.firstElementChild as HTMLElement;
    formula.setAttribute('data-inline-math', node.attrs.latex);
    formula.setAttribute('contenteditable', 'false');
    return formula;
  },
};
