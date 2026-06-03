import { describe, expect, it } from 'vitest';

import { normalizeJsonStringBackslashes, parseJsonResponse } from '@/lib/generation/json-repair';

describe('json-repair targeted fixes', () => {
  it('repairs quoted key-value fragments such as "height: 76"', () => {
    const raw = `{
  "background": {
    "type": "solid",
    "color": "#ffffff"
  },
  "elements": [
    {
      "id": "code_text",
      "type": "text",
      "left": 80,
      "top": 420,
      "width": 840,
      "height: 76",
      "content": "<p style=\\"font-size: 22px;\\">age = 25</p>",
      "defaultFontName": "",
      "defaultColor": "#333333"
    }
  ]
}`;

    const parsed = parseJsonResponse<{
      elements: Array<{ height: number; content: string }>;
    }>(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.elements[0]?.height).toBe(76);
    expect(parsed?.elements[0]?.content).toContain('age = 25');
  });

  it('repairs boolean property fragments without touching valid string values', () => {
    const raw = `{
  "elements": [
    {
      "id": "shape_1",
      "fixedRatio: false",
      "height: 58",
      "content": "<p>literal text: height: 58</p>"
    }
  ]
}`;

    const parsed = parseJsonResponse<{
      elements: Array<{ fixedRatio: boolean; height: number; content: string }>;
    }>(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.elements[0]?.fixedRatio).toBe(false);
    expect(parsed?.elements[0]?.height).toBe(58);
    expect(parsed?.elements[0]?.content).toBe('<p>literal text: height: 58</p>');
  });
});

describe('json-repair LaTeX backslash handling', () => {
  // Each `parse` input embeds a *single* backslash before the command (the
  // `\\` in the template literal is one backslash), reproducing the raw LaTeX
  // an LLM emits.
  const parse = (raw: string) => parseJsonResponse<{ latex: string }>(raw)?.latex;

  it('preserves a bare \\frac (silently corrupted by JSON.parse before this fix)', () => {
    // `\f` is a valid JSON escape, so JSON.parse would otherwise decode this to a
    // form-feed character instead of throwing — corrupting the math content.
    expect(parse('{"latex":"\\frac{1}{2}"}')).toBe('\\frac{1}{2}');
  });

  it('preserves control-letter LaTeX commands (\\times, \\theta, \\nu, \\rho, \\beta)', () => {
    expect(parse('{"latex":"a \\times b"}')).toBe('a \\times b');
    expect(parse('{"latex":"\\theta"}')).toBe('\\theta');
    expect(parse('{"latex":"\\nu_i"}')).toBe('\\nu_i');
    expect(parse('{"latex":"\\rho"}')).toBe('\\rho');
    expect(parse('{"latex":"\\beta"}')).toBe('\\beta');
  });

  it('preserves a mix of control-letter and throwing commands', () => {
    expect(parse('{"latex":"\\nu = \\frac{a}{b}"}')).toBe('\\nu = \\frac{a}{b}');
    expect(parse('{"latex":"\\left(\\frac{a}{b}\\right)"}')).toBe('\\left(\\frac{a}{b}\\right)');
  });

  it('preserves non-escape-letter commands and LaTeX punctuation', () => {
    expect(parse('{"latex":"\\sum \\alpha"}')).toBe('\\sum \\alpha');
    expect(parse('{"latex":"50\\% a\\_b"}')).toBe('50\\% a\\_b');
  });

  it('is a no-op on genuine JSON escapes (no regression)', () => {
    // A newline followed by a lowercase word must stay a newline, not become \nu.
    expect(parse('{"latex":"line1\\nline2"}')).toBe('line1\nline2');
    expect(parse('{"latex":"x\\nunder y"}')).toBe('x\nunder y');
    expect(parse('{"latex":"col\\tval"}')).toBe('col\tval');
    expect(parse('{"latex":"\\u00e9"}')).toBe('é');
    expect(parse('{"latex":"C:\\\\dir"}')).toBe('C:\\dir');
    // Already-correctly-escaped LaTeX is untouched.
    expect(parse('{"latex":"\\\\frac{1}{2}"}')).toBe('\\frac{1}{2}');
  });

  it('normalizeJsonStringBackslashes only touches string contents', () => {
    // Structure (braces, numbers, keys) is preserved verbatim.
    expect(normalizeJsonStringBackslashes('{"a": 1, "b": [2, 3]}')).toBe('{"a": 1, "b": [2, 3]}');
    // A standalone control escape is left alone; a LaTeX command is double-escaped.
    expect(normalizeJsonStringBackslashes('"a\\nb"')).toBe('"a\\nb"');
    expect(normalizeJsonStringBackslashes('"\\frac"')).toBe('"\\\\frac"');
  });
});
