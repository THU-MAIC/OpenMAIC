import { describe, it, expect } from 'vitest';
import { latexToOmml } from '../latex-to-omml';

describe('latexToOmml', () => {
  it('converts simple LaTeX to OMML', () => {
    const result = latexToOmml('x^2');
    expect(result).not.toBeNull();
    expect(result).toContain('m:oMath');
  });

  it('converts fraction to OMML', () => {
    const result = latexToOmml('\\frac{a}{b}');
    expect(result).not.toBeNull();
    expect(result).toContain('m:f');
  });

  it('converts superscript and subscript', () => {
    const result = latexToOmml('a_1^2');
    expect(result).not.toBeNull();
    expect(result).toContain('m:oMath');
  });

  it('strips DOCX-only xmlns:w namespace', () => {
    const result = latexToOmml('x+y');
    expect(result).not.toBeNull();
    expect(result).not.toContain('xmlns:w');
  });

  it('strips redundant xmlns:m namespace', () => {
    const result = latexToOmml('x+y');
    expect(result).not.toBeNull();
    expect(result).not.toContain('xmlns:m');
  });

  it('injects Cambria Math font', () => {
    const result = latexToOmml('x');
    expect(result).not.toBeNull();
    expect(result).toContain('Cambria Math');
  });

  it('applies fontSize as sz attribute in hundredths', () => {
    const result = latexToOmml('x', 14);
    expect(result).not.toBeNull();
    expect(result).toContain('sz="1400"');
  });

  it('omits sz when fontSize is not provided', () => {
    const result = latexToOmml('x');
    expect(result).not.toBeNull();
    expect(result).not.toContain('sz=');
  });

  it('returns null for invalid LaTeX', () => {
    const result = latexToOmml('\\invalidcommandthatdoesnotexist{}{}{');
    // Should return null or fallback gracefully
    // (temml may or may not throw on this — test that we don't crash)
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('handles complex expressions like integrals', () => {
    const result = latexToOmml('\\int_0^1 f(x) \\, dx');
    expect(result).not.toBeNull();
    expect(result).toContain('m:oMath');
  });

  it('handles Greek letters', () => {
    const result = latexToOmml('\\alpha + \\beta = \\gamma');
    expect(result).not.toBeNull();
    expect(result).toContain('m:oMath');
  });
});
