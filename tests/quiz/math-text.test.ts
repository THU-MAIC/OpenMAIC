import { describe, expect, it } from 'vitest';
import {
  isLikelyStandaloneMathText,
  parseQuizMathText,
  renderQuizMathText,
} from '@/lib/quiz/math-text';

describe('parseQuizMathText', () => {
  it('splits explicit inline math from surrounding prose', () => {
    const segments = parseQuizMathText('Solve $x^2=4$ before moving on.');

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: 'text', value: 'Solve ' });
    expect(segments[1]).toMatchObject({ type: 'math', value: 'x^2=4', displayMode: false });
    expect(segments[1].type === 'math' ? segments[1].html : '').toContain('katex');
    expect(segments[2]).toEqual({ type: 'text', value: ' before moving on.' });
  });

  it('renders explicit inline math with subtraction', () => {
    const segments = parseQuizMathText('Solve $x-2$ before moving on.');

    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({ type: 'math', value: 'x-2', displayMode: false });
  });

  it('supports display delimiters', () => {
    const segments = parseQuizMathText('$$\\frac{1}{2}$$');

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'math', value: '\\frac{1}{2}', displayMode: true });
  });

  it('leaves escaped dollars as text', () => {
    const segments = parseQuizMathText('Cost is \\$5, not math.');

    expect(segments).toEqual([{ type: 'text', value: 'Cost is \\$5, not math.' }]);
  });

  it('does not treat ordinary currency as dollar-delimited math', () => {
    const segments = parseQuizMathText('Cost is $5 and $7');

    expect(segments).toEqual([{ type: 'text', value: 'Cost is $5 and $7' }]);
  });

  it('falls back to the original delimited text when KaTeX rejects it', () => {
    const segments = parseQuizMathText('Bad $\\definitelyunknown{1}$ input');

    expect(segments).toEqual([{ type: 'text', value: 'Bad $\\definitelyunknown{1}$ input' }]);
  });
});

describe('isLikelyStandaloneMathText', () => {
  it('recognizes delimiter-free algebra like the issue report', () => {
    expect(isLikelyStandaloneMathText('a(x-2)+b(2-x)^2=a(x-2)+b(x-2)^2')).toBe(true);
  });

  it('does not classify ordinary quiz prose as math', () => {
    expect(isLikelyStandaloneMathText('Chapter 2 review question')).toBe(false);
  });

  it('does not classify short instruction prompts as standalone math', () => {
    expect(isLikelyStandaloneMathText('Solve x=2')).toBe(false);
    expect(isLikelyStandaloneMathText('Simplify x^2')).toBe(false);
  });

  it('does not classify prose that mentions a LaTeX command as standalone math', () => {
    expect(isLikelyStandaloneMathText('Use \\sqrt{2} not 2 here')).toBe(false);
  });

  it('does not classify code-like answer options as standalone math', () => {
    expect(isLikelyStandaloneMathText('i = i + 1')).toBe(false);
    expect(isLikelyStandaloneMathText('Answer = True')).toBe(false);
  });

  it('still recognizes delimiter-free LaTeX command expressions', () => {
    expect(isLikelyStandaloneMathText('\\sqrt{2}')).toBe(true);
  });

  it('does not classify slash, protocol, date, or hyphenated prose as math', () => {
    expect(isLikelyStandaloneMathText('A/B test')).toBe(false);
    expect(isLikelyStandaloneMathText('HTTP/2')).toBe(false);
    expect(isLikelyStandaloneMathText('COVID-19')).toBe(false);
    expect(isLikelyStandaloneMathText('2026-07-01')).toBe(false);
  });
});

describe('renderQuizMathText', () => {
  it('renders delimiter-free algebra as one math segment', () => {
    const segments = renderQuizMathText('a(x-2)+b(2-x)^2=a(x-2)+b(x-2)^2');

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: 'math',
      value: 'a(x-2)+b(2-x)^2=a(x-2)+b(x-2)^2',
      displayMode: false,
    });
  });

  it('preserves non-math text as plain text', () => {
    expect(renderQuizMathText('Which option is correct?')).toEqual([
      { type: 'text', value: 'Which option is correct?' },
    ]);
  });

  it('preserves percent content in delimiter-free math', () => {
    const segments = renderQuizMathText('25%*4 = 100%');

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: 'math',
      value: '25%*4 = 100%',
      displayMode: false,
    });
    expect(segments[0].type === 'math' ? segments[0].html : '').toContain('%');
    expect(segments[0].type === 'math' ? segments[0].html : '').toContain('100');
  });

  it('preserves prose prompts as plain text even with math-looking expressions', () => {
    expect(renderQuizMathText('Solve x=2')).toEqual([{ type: 'text', value: 'Solve x=2' }]);
    expect(renderQuizMathText('Simplify x^2')).toEqual([{ type: 'text', value: 'Simplify x^2' }]);
    expect(renderQuizMathText('Use \\sqrt{2} not 2 here')).toEqual([
      { type: 'text', value: 'Use \\sqrt{2} not 2 here' },
    ]);
  });

  it('preserves code-like answer options as plain text', () => {
    expect(renderQuizMathText('i = i + 1')).toEqual([{ type: 'text', value: 'i = i + 1' }]);
    expect(renderQuizMathText('Answer = True')).toEqual([{ type: 'text', value: 'Answer = True' }]);
  });

  it('renders embedded algebra without consuming surrounding prose', () => {
    const formula = 'a(x-2)+b(2-x)^2=a(x-2)+b(x-2)^2';
    const segments = renderQuizMathText(`The simplification is ${formula}.`);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: 'text', value: 'The simplification is ' });
    expect(segments[1]).toMatchObject({
      type: 'math',
      value: formula,
      displayMode: false,
    });
    expect(segments[2]).toEqual({ type: 'text', value: '.' });
  });
});
