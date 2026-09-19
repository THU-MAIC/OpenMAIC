import { describe, expect, it } from 'vitest';
import { insertLatexAtSelection, renderLatexSource } from '../../src/ui/latex/latex-editor';

describe('latex editor helpers', () => {
  it('creates display-mode KaTeX HTML from valid source', () => {
    expect(renderLatexSource('x^2')).toMatchObject({ html: expect.stringContaining('katex') });
  });

  it('reports a parse error instead of committing invalid source', () => {
    expect(renderLatexSource('\\frac{')).toMatchObject({ error: expect.any(String) });
  });

  it('inserts a symbol at the current textarea selection', () => {
    expect(insertLatexAtSelection('a+b', 1, 2, '\\times')).toEqual({
      value: 'a\\timesb',
      cursor: 7,
    });
  });
});
