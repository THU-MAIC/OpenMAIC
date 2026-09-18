import { describe, it, expect } from 'vitest';
import katex from 'katex';
import { ommlToLatex } from '../src/serializer/mathSerializer';

const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const omath = (inner: string) => `<m:oMath ${M}>${inner}</m:oMath>`;

/**
 * 回归（auto-fix.md 坑表）：OMML → LaTeX 转换的 JS 兜底路径（ommlToLatex）。
 *
 * - 分数等基本结构要转成正确的 LaTeX 命令。
 * - 梯度/反向传播页用的 ∂(U+2202)/∇(U+2207)：早先因为不在 Greek 归一化范围 →
 *   泄漏成 lone surrogate，KaTeX 报错把源码渲染成红字。postProcessLatex 补了
 *   ∂→\partial、∇→\nabla 的兜底。
 */
describe('mathSerializer · ommlToLatex', () => {
  it('分数 m:f → \\frac{a}{b}', () => {
    const latex = ommlToLatex(
      omath(
        '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>',
      ),
    );
    expect(latex).toBe('\\frac{a}{b}');
  });

  it('∂ (U+2202) → \\partial（不泄漏原字符）', () => {
    const latex = ommlToLatex(omath('<m:r><m:t>\u2202</m:t></m:r>'));
    expect(latex).toContain('\\partial');
    expect(latex).not.toContain('\u2202');
  });

  it('∇ (U+2207) → \\nabla（不泄漏原字符）', () => {
    const latex = ommlToLatex(omath('<m:r><m:t>\u2207</m:t></m:r>'));
    expect(latex).toContain('\\nabla');
    expect(latex).not.toContain('\u2207');
  });
});

describe('OMML equation delimiters', () => {
  const run = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;
  const power = (base: string, exponent: string) =>
    `<m:sSup><m:e><m:d><m:e>${run(base)}</m:e></m:d></m:e><m:sup>${run(exponent)}</m:sup></m:sSup>`;

  it('preserves a two-row system with a left brace, invisible right delimiter and powers', () => {
    const rows = [
      `${run('X')}${power('1.02', '40')}${run('+Y')}${power('1.03', '20')}${run('=1000')}`,
      `${run('X')}${power('1.02', '20')}${run('=2Y')}${power('1.03', '10')}`,
    ];
    const latex = ommlToLatex(
      omath(
        `<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e><m:eqArr>${rows.map((row) => `<m:e>${row}</m:e>`).join('')}</m:eqArr></m:e></m:d>`,
      ),
    );
    expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow();
    expect(latex).toContain('\\left\\{');
    expect(latex).toContain('\\right.');
    expect(latex).toContain('\\\\');
    expect(latex).toContain('^{40}');
    expect(latex).toContain('^{10}');
  });

  it.each([
    ['{', '}', '\\left\\{', '\\right\\}'],
    ['', '}', '\\left.', '\\right\\}'],
    ['[', '', '\\left[', '\\right.'],
  ])('preserves explicit delimiters %s / %s', (open, close, left, right) => {
    const latex = ommlToLatex(
      omath(
        `<m:d><m:dPr><m:begChr m:val="${open}"/><m:endChr m:val="${close}"/></m:dPr><m:e>${run('x')}</m:e></m:d>`,
      ),
    );
    expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow();
    expect(latex).toContain(left);
    expect(latex).toContain(right);
  });
});
