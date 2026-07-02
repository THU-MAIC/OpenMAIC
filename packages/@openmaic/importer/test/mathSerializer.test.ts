import { describe, it, expect } from 'vitest';
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
