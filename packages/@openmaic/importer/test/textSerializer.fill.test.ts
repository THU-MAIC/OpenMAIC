import { describe, it, expect } from 'vitest';
import { renderTxBodyHtml } from './helpers';

/**
 * 回归（auto-fix.md 坑表）：rPr 的 noFill / solidFill / gradFill 是互斥的。
 *
 * 现象：圆里白色编号 01-05 在画布全不可见、色块还在。
 * 根因：master 给 noFill、slide 给 solidFill(白)，旧逻辑把两者当可共存 →
 *       CSS 输出 `color:#FFF;color:transparent;`，浏览器取后者 → 文字透明看不见。
 * 修复：mergeRunProps 里三种 fill 互斥——后处理层级显式声明一种就清掉其余两种。
 *
 * 这里用「继承层 defRPr=noFill + run rPr=solidFill(白)」复现：run 的 solidFill
 * 应该赢，最终只剩白色、不出现 transparent。
 */
describe('textSerializer · fill 互斥（noFill/solidFill/gradFill）', () => {
  const html = renderTxBodyHtml(`
    <a:lstStyle><a:lvl1pPr><a:defRPr><a:noFill/></a:defRPr></a:lvl1pPr></a:lstStyle>
    <a:p><a:r><a:rPr sz="2000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>01</a:t></a:r></a:p>`);

  it('run 的 solidFill 覆盖继承的 noFill：文字保留白色', () => {
    expect(html).toContain('color: #FFFFFF');
  });

  it('不会同时输出 transparent（否则文字隐形）', () => {
    expect(html).not.toContain('transparent');
  });
});
