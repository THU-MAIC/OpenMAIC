import { describe, it, expect } from 'vitest';
import { renderTxBodyHtml } from './helpers';

/**
 * 回归（auto-fix.md 坑表）：标题/列表行用「前导 \t + 自定义 a:tabLst」推到图标右侧。
 *
 * 现象：标题整体右移、与图标间距过大、被甩到 96px 默认网格列（窄框还触发换行）；
 *       a2m 里裸 tab/tab-size 又不被 ProseMirror 保留 → 行塌回左边被图标盖住。
 * 修复：textSerializer 解析 a:tabLst 首个停靠位，把行首 \t 折进段落 margin-left
 *       （整块右移，单行与首行缩进视觉等价，a2m 也能忠实渲染），并把行首空白从 run 剥掉。
 */
describe('textSerializer · 行首 tab + tabLst 折叠成 margin-left', () => {
  const html = renderTxBodyHtml(`
    <a:p>
      <a:pPr marL="0" indent="0"><a:tabLst><a:tab pos="914400"/></a:tabLst></a:pPr>
      <a:r><a:rPr sz="1800"/><a:t>\t物资管理</a:t></a:r>
    </a:p>`);

  it('行首 \\t 折进 margin-left（tab pos=914400 EMU = 96px）', () => {
    expect(html).toContain('margin-left: 96px');
  });

  it('已折叠的行首 \\t 从正文剥掉：文本直接以「物」开头', () => {
    expect(html).toMatch(/>物资管理</);
    expect(html).not.toContain('\t物资管理');
  });
});
