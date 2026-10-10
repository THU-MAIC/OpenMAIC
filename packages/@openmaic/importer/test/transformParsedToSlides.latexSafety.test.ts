import { describe, expect, it } from 'vitest';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';

const LEAF = 'x'.repeat(400);
const times = (name: string, count: number) => `\\${name}`.repeat(count);

/** Short formulas whose own macro definitions would expand far beyond their size. */
const EXPANDING_INPUTS = {
  nestedDef: `\\def\\ma{${LEAF}}\\def\\mb{${times('ma', 30)}}\\def\\mc{${times('mb', 30)}}\\mc`,
  nestedNewcommand: `\\newcommand{\\ma}{${LEAF}}\\newcommand{\\mb}{${times('ma', 30)}}\\newcommand{\\mc}{${times('mb', 30)}}\\mc`,
  gdefAndLet: `\\gdef\\ma{${LEAF}}\\let\\mb\\ma\\global\\def\\mc{${times('mb', 30)}}${times('mc', 30)}`,
};

async function importMath(latex: string) {
  const json = {
    size: { width: 960, height: 540 },
    themeColors: [],
    slides: [
      {
        fill: { type: 'color', value: '#ffffff' },
        note: '',
        layoutElements: [],
        elements: [
          {
            type: 'math',
            left: 30,
            top: 40,
            width: 200,
            height: 40,
            order: 1,
            latex,
            text: 'formula',
          },
        ],
      },
    ],
  };
  const start = performance.now();
  const { slides } = await transformParsedToSlides(
    json as unknown as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({ viewportWidth: 1280 }),
  );
  return { elements: slides[0].elements, ms: performance.now() - start };
}

describe('imported formulas ignore formula-defined macros', () => {
  for (const [name, latex] of Object.entries(EXPANDING_INPUTS)) {
    it(name, async () => {
      const { elements, ms } = await importMath(latex);
      expect(ms).toBeLessThan(100);
      expect(JSON.stringify(elements).length).toBeLessThan(64 * 1024);
      // The definitions are dropped, so KaTeX rejects the formula and the
      // importer keeps its plain-text fallback.
      expect(elements.map((e) => e.type)).not.toContain('latex');
    });
  }

  it('still renders a legitimate formula as a latex element', async () => {
    const { elements } = await importMath('x \\neq \\frac{1}{2} \\iff a, \\dots, b');
    const latex = elements.find((e) => e.type === 'latex') as { html?: string } | undefined;
    expect(latex?.html).toContain('katex');
  });
});
