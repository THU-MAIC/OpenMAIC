import katex from 'katex';
import { safeKatexOptions } from '@openmaic/dsl';
import { MAX_INLINE_MATH_SOURCE } from '@openmaic/renderer';
import type { NodeSpec } from 'prosemirror-model';

/** Keep rendered formulas opaque to the prose parser, including hidden MathML. */
export const inlineMath: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  leafText: (node) => (typeof node.attrs.latex === 'string' ? node.attrs.latex : ''),
  attrs: { latex: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-inline-math]',
      priority: 100,
      getAttrs: (dom) => {
        const latex = (dom as HTMLElement).getAttribute('data-inline-math');
        return latex !== null ? { latex } : false;
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
    const latex = typeof node.attrs.latex === 'string' ? node.attrs.latex : '';
    const host = document.createElement('span');
    // Empty/malformed source must not prevent the surrounding text from saving.
    // Preserve the atom and source even when KaTeX cannot produce markup.
    let formula = host;
    if (latex.length > MAX_INLINE_MATH_SOURCE) {
      // Same bound as the slide renderer: an over-long source stays a formula
      // atom with its source, shown as text instead of being typeset.
      host.textContent = latex;
    } else if (latex.trim()) {
      try {
        // Rebuild trusted markup rather than storing arbitrary imported HTML.
        katex.render(
          latex,
          host,
          safeKatexOptions({
            displayMode: false,
            throwOnError: false,
          }),
        );
        formula = (host.firstElementChild as HTMLElement | null) ?? host;
      } catch {
        host.textContent = latex;
      }
    }
    formula.setAttribute('data-inline-math', latex);
    formula.setAttribute('contenteditable', 'false');
    return formula;
  },
};
