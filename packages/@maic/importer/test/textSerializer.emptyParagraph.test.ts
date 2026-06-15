import { describe, it, expect } from 'vitest';
import { renderTxBodyHtml } from './helpers';

/**
 * 回归（auto-fix.md 坑表）：空段（占位空行）的填充与高度。
 *
 * 现象①（a2m）：用 `<p><br/></p>` 撑高度的空段，在 ProseMirror 里 hard_break 结尾
 *   会再补一个 trailingBreak → `<br><br>` = 2 行，累积把下方图标/正文整体压下去错位。
 *   修复：空段填充改用 `&nbsp;`（raw-HTML 与 ProseMirror 两端都恰好 1 行）。
 * 现象②：空 `<p>` 高度为 0（没有内联盒），需要按 endParaRPr 的字号撑出空行高度。
 */
describe('textSerializer · 空段填充', () => {
  const html = renderTxBodyHtml(`<a:p><a:endParaRPr sz="3600"/></a:p>`);

  it('空段用 &nbsp; 填充，而不是 <br/>（避免 a2m 里被加倍成两行）', () => {
    expect(html).toContain('&nbsp;');
    expect(html).not.toContain('<br');
  });

  it('空段按 endParaRPr 字号撑出行高（sz=3600 → 36pt）', () => {
    expect(html).toContain('font-size: 36pt');
  });
});
