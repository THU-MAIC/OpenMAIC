// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTextDocument } from '../../src/react/text/prosemirror/document';
import { renderLatexSource } from '../../src/ui/latex/latex-editor';

const LEAF = 'x'.repeat(400);
const times = (name: string, count: number) => `\\${name}`.repeat(count);

/** Short formulas whose own macro definitions would expand far beyond their size. */
const EXPANDING_INPUTS = {
  nestedDef: `\\def\\ma{${LEAF}}\\def\\mb{${times('ma', 30)}}\\def\\mc{${times('mb', 30)}}\\mc`,
  nestedNewcommand: `\\newcommand{\\ma}{${LEAF}}\\newcommand{\\mb}{${times('ma', 30)}}\\newcommand{\\mc}{${times('mb', 30)}}\\mc`,
  gdefAndLet: `\\gdef\\ma{${LEAF}}\\let\\mb\\ma\\global\\def\\mc{${times('mb', 30)}}${times('mc', 30)}`,
};

function timed<T>(render: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = render();
  return { value, ms: performance.now() - start };
}

describe('editor math rendering ignores formula-defined macros', () => {
  for (const [name, latex] of Object.entries(EXPANDING_INPUTS)) {
    it(`latex dialog: ${name}`, () => {
      const { value, ms } = timed(() => renderLatexSource(latex));
      expect(ms).toBeLessThan(100);
      // The definitions are dropped, so the later use is an unknown command.
      expect(value).toMatchObject({ error: expect.stringMatching(/Undefined control sequence/) });
    });

    it(`inline math node: ${name}`, () => {
      const { value, ms } = timed(() =>
        createTextDocument(`<p><span data-inline-math="${latex}"></span></p>`),
      );
      expect(ms).toBeLessThan(100);
      expect(JSON.stringify(value.toJSON()).length).toBeLessThan(64 * 1024);
    });
  }

  it('keeps built-in equation numbering', () => {
    const html = (latex: string) => {
      const result = renderLatexSource(latex);
      return 'html' in result ? (result.html ?? '') : `ERROR ${result.error}`;
    };
    const text = (markup: string) => markup.replace(/<[^>]*>/g, '');
    const numbers = (markup: string) => markup.match(/class="eqn-num"/g)?.length ?? 0;
    expect(text(html('E=mc^2\\tag{1}'))).toContain('(1)');
    expect(text(html('E=mc^2\\tag*{(A)}'))).toContain('(A)');
    expect(numbers(html('\\begin{align} a &= b \\\\ c &= d \\\\ e &= f \\end{align}'))).toBe(3);
    expect(
      numbers(
        html('\\begin{align} a &= b \\notag \\\\ c &= d \\nonumber \\\\ e &= f \\end{align}'),
      ),
    ).toBe(1);
    // A self-referencing tag is dropped rather than recursed into.
    expect(text(html('x \\tag{\\df@tag}'))).not.toMatch(/ERROR|\(/);
  });

  it('still renders legitimate formulas', () => {
    expect(renderLatexSource('x \\neq \\frac{1}{2} \\iff a, \\dots, b')).toMatchObject({
      html: expect.stringContaining('katex'),
    });
  });
});
