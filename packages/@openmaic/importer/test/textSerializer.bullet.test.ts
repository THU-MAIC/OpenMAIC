import { describe, it, expect } from 'vitest';
import { renderTxBodyHtml } from './helpers';

/**
 * 回归：hanging-indent（负 indent）+ Wingdings symbol bullet 的槽位定位。
 *
 * 现场（第1.0讲 课程概论 slide 3「课程目标」）的真实 XML：
 *   <a:pPr indent="-457200">          // = text-indent:-48px，且无 marL
 *     <a:buClr><a:srgbClr val="FFC000"/></a:buClr>
 *     <a:buFont typeface="Wingdings"/><a:buChar char="n"/>   // 'n' → ■
 *   </a:pPr>
 *
 * 坑：序列化器为带 bullet 的负 indent 段合成 margin-left:48 并把 bullet 放进
 * width:48 的 inline-block 槽位；但 <p> 上的 text-indent:-48 会被该 inline-block
 * 当作块级容器继承，把槽内 ■ 再左移 48px → 落到 element 左外（压住左侧编号圆）。
 * 修复是在槽位上显式 text-indent:0 切断继承。
 *
 * 注意：这条断言保护的是「输出的 CSS 结构正确」。■ 实际位移到 -31px 这种
 * 浏览器布局问题，字符串断言看不出来，需配合 puppeteer/regression 量几何。
 */
describe('textSerializer · 负 indent + Wingdings bullet 槽位', () => {
  const PARA = `
    <a:p>
      <a:pPr indent="-457200">
        <a:buClr><a:srgbClr val="FFC000"/></a:buClr>
        <a:buFont typeface="Wingdings"/>
        <a:buChar char="n"/>
      </a:pPr>
      <a:r><a:rPr lang="zh-CN" altLang="en-US" sz="2000"/><a:t>掌握科学学习、生涯规划、积极心理学等领域的理论知识</a:t></a:r>
    </a:p>`;

  it('Wingdings "n" 渲染成 ■ 并取 buClr 颜色', () => {
    const html = renderTxBodyHtml(PARA);
    expect(html).toContain('■');
    expect(html).toContain('color: #FFC000;');
  });

  it('段落保留 hanging-indent：margin-left:48px + text-indent:-48px', () => {
    const html = renderTxBodyHtml(PARA);
    expect(html).toContain('margin-left: 48px');
    expect(html).toContain('text-indent: -48px');
  });

  it('bullet 槽位带 text-indent:0，切断父级负 indent 的继承（核心回归点）', () => {
    const html = renderTxBodyHtml(PARA);
    // 槽位是 width=marL 的 inline-block，必须自带 text-indent:0
    expect(html).toMatch(/display:inline-block;width:48px;text-indent:0;/);
  });

  it('回归护栏：槽位里不能出现没有 text-indent:0 的裸 padding-left（旧 buggy 形态）', () => {
    const html = renderTxBodyHtml(PARA);
    expect(html).not.toMatch(/width:48px;padding-left:16px/);
  });

  it('真实 marL ≫ |indent| 时，槽宽取 |indent| 而非 marL（否则 bullet 离正文很远）', () => {
    // 现场（第1.2讲 在集体中成长 slide 2 右侧 ■ 框）lvl2pPr：marL=742950(78px) indent=-285750(-30px)
    const html = renderTxBodyHtml(`
      <a:p>
        <a:pPr marL="742950" indent="-285750">
          <a:buFont typeface="Wingdings"/><a:buChar char="n"/>
        </a:pPr>
        <a:r><a:rPr sz="2200"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>1954年清华大学首创</a:t></a:r>
      </a:p>`);
    // 段落保留真实 marL / indent
    expect(html).toContain('margin-left: 78px');
    expect(html).toContain('text-indent: -30px');
    // 槽宽 = |indent| = 30px，绝不能是 marL = 78px（旧 bug）
    expect(html).toMatch(/display:inline-block;width:30px;text-indent:0;/);
    expect(html).not.toContain('width:78px');
    // 真实 marL（非合成）时 symbol bullet 不补 padding-left:16（落在 marL+indent 悬挂位）
    expect(html).not.toContain('padding-left:16px');
  });

  it('buClr 决定 bullet 颜色，且不被正文 run 的颜色带偏', () => {
    // 正文 run 显式黑色，bullet 的 buClr 是金色：两者应各自生效
    const html = renderTxBodyHtml(`
      <a:p>
        <a:pPr indent="-457200">
          <a:buClr><a:srgbClr val="FFC000"/></a:buClr>
          <a:buFont typeface="Wingdings"/><a:buChar char="n"/>
        </a:pPr>
        <a:r><a:rPr sz="2000"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>正文</a:t></a:r>
      </a:p>`);
    expect(html).toMatch(/■<\/span>/); // bullet 槽位存在
    expect(html).toContain('color: #FFC000;'); // bullet 用 buClr 金色
    expect(html).toContain('color: #000000'); // 正文用 run 的黑色
  });
});
