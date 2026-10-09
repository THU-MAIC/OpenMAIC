import { describe, expect, test } from 'vitest';

import { generateSceneContent } from '@openmaic/generation';
import type { GeneratedSlideContent } from '@openmaic/generation';

import { slideOutline } from './scene-fixtures.js';

const LEAF = 'x'.repeat(400);
const times = (name: string, count: number) => `\\${name}`.repeat(count);

/** Short formulas whose own macro definitions would expand far beyond their size. */
const EXPANDING_INPUTS = {
  nestedDef: `\\def\\ma{${LEAF}}\\def\\mb{${times('ma', 30)}}\\def\\mc{${times('mb', 30)}}\\mc`,
  nestedNewcommand: `\\newcommand{\\ma}{${LEAF}}\\newcommand{\\mb}{${times('ma', 30)}}\\newcommand{\\mc}{${times('mb', 30)}}\\mc`,
  gdefAndLet: `\\gdef\\ma{${LEAF}}\\let\\mb\\ma\\global\\def\\mc{${times('mb', 30)}}${times('mc', 30)}`,
};

function latexElement(latex: string) {
  return { type: 'latex', latex, left: 0, top: 0, width: 400, height: 80 };
}

async function renderLatex(latex: string): Promise<{ html: string; ms: number }> {
  const aiCall = async () => JSON.stringify({ elements: [latexElement(latex)], remark: '' });
  const start = performance.now();
  const content = (await generateSceneContent(slideOutline(), aiCall)) as GeneratedSlideContent;
  const ms = performance.now() - start;
  const element = content.elements.find((el) => el.type === 'latex') as { html?: string };
  return { html: element?.html ?? '', ms };
}

describe('generated latex elements ignore formula-defined macros', () => {
  for (const [name, latex] of Object.entries(EXPANDING_INPUTS)) {
    test(name, async () => {
      const { html, ms } = await renderLatex(latex);
      expect(ms).toBeLessThan(100);
      expect(html.length).toBeLessThan(64 * 1024);
    });
  }

  test('legitimate formulas still render', async () => {
    const { html } = await renderLatex('x \\neq \\frac{1}{2} \\iff a, \\dots, b');
    expect(html).toContain('katex');
    expect(html).not.toContain('katex-error');
  });
});
