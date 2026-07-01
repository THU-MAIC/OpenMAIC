import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseShapeNode } from '../src/model/nodes/ShapeNode';
import { renderShape } from '../src/serializer/shapeSerializer';
import { minimalCtx } from './helpers';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function renderShapeXml(
  spPrInner: string,
  txBodyInner = '<a:bodyPr/><a:p/>',
  rot = '',
  txBox = false,
  ext = '<a:ext cx="17870" cy="1871"/>',
) {
  const xml = `<p:sp ${NS}>
    <p:nvSpPr><p:cNvPr id="15" name="shape"/><p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm${rot ? ` rot="${rot}"` : ''}><a:off x="821" y="1546"/>${ext}</a:xfrm>
      ${spPrInner}
    </p:spPr>
    <p:txBody>${txBodyInner}</p:txBody>
  </p:sp>`;
  return renderShape(parseShapeNode(parseXml(xml)), minimalCtx(), 0);
}

describe('shapeSerializer · group 局部坐标的亚像素形状', () => {
  it('保留 noFill + dashed outline 的亚像素 roundRect 面积路径', async () => {
    const el = await renderShapeXml(`
      <a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 3697"/></a:avLst></a:prstGeom>
      <a:noFill/>
      <a:ln w="9525">
        <a:solidFill><a:srgbClr val="C3A2F7"/></a:solidFill>
        <a:prstDash val="sysDash"/>
      </a:ln>
    `);

    if (el.type !== 'shape') {
      throw new Error(`Expected shape element, got ${el.type}`);
    }
    expect(el.height).toBeLessThan(0.75);
    expect(el.path).toContain(String(el.height));
    expect(el.borderWidth).toBeGreaterThan(0);
    expect(el.borderType).toBe('dashed');
  });

  it('270 度旋转的单行 spAutoFit 文本不在 HTML 阶段换行', async () => {
    const el = await renderShapeXml(
      `
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
      `,
      `<a:bodyPr wrap="square" lIns="0" rIns="0"><a:spAutoFit/></a:bodyPr>
       <a:lstStyle/>
       <a:p>
         <a:pPr algn="ctr"/>
         <a:r><a:rPr sz="800"/><a:t>Copyright © 元知进化Cog Evol. All Rights Reserved</a:t></a:r>
      </a:p>`,
      '16200000',
      true,
    );

    if (el.type !== 'text') {
      throw new Error(`Expected text element, got ${el.type}`);
    }
    expect(el.content).toContain('white-space: nowrap');
  });

  it('保留 textArchUp/textArchDown 的弧形文字排布', async () => {
    const up = await renderShapeXml(
      `
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
      `,
      `<a:bodyPr wrap="square"><a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp><a:spAutoFit/></a:bodyPr>
       <a:lstStyle/>
       <a:p>
         <a:pPr algn="ctr"/>
         <a:r><a:rPr sz="1400"/><a:t>显著降低推理时延</a:t></a:r>
       </a:p>`,
      '',
      true,
    );
    const down = await renderShapeXml(
      `
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
      `,
      `<a:bodyPr wrap="square"><a:prstTxWarp prst="textArchDown"><a:avLst/></a:prstTxWarp><a:spAutoFit/></a:bodyPr>
       <a:lstStyle/>
       <a:p>
         <a:pPr algn="ctr"/>
         <a:r><a:rPr sz="1400"/><a:t>显著降低Token消耗</a:t></a:r>
       </a:p>`,
      '',
      true,
    );
    expect(up.content).toContain('data-pptx-text-warp="textArchUp"');
    expect(up.content).toContain('transform: translate(-50%, -50%) rotate(');
    expect(down.content).toContain('data-pptx-text-warp="textArchDown"');
    expect(down.content).toContain('显');
  });

  it('textArchUp/textArchDown 分别贴近文本框上沿和下沿', async () => {
    const up = await renderShapeXml(
      `
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
      `,
      `<a:bodyPr wrap="square"><a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp><a:spAutoFit/></a:bodyPr>
       <a:lstStyle/>
       <a:p>
         <a:pPr algn="ctr"/>
         <a:r><a:rPr sz="1400"/><a:t>显著降低推理时延</a:t></a:r>
       </a:p>`,
      '',
      true,
      '<a:ext cx="952500" cy="952500"/>',
    );
    const down = await renderShapeXml(
      `
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
      `,
      `<a:bodyPr wrap="square"><a:prstTxWarp prst="textArchDown"><a:avLst/></a:prstTxWarp><a:spAutoFit/></a:bodyPr>
       <a:lstStyle/>
       <a:p>
         <a:pPr algn="ctr"/>
         <a:r><a:rPr sz="1400"/><a:t>显著降低Token消耗</a:t></a:r>
       </a:p>`,
      '',
      true,
    );

    const extractTopPercentages = (html: string) =>
      [...html.matchAll(/top: ([\d.]+)%/g)].map((m) => Number(m[1]));

    const upTops = extractTopPercentages(up.content);
    const downTops = extractTopPercentages(down.content);

    expect(up.content).toContain('height: 90.40px');
    expect(Math.max(...upTops)).toBeLessThanOrEqual(32);
    expect(Math.min(...downTops)).toBeGreaterThanOrEqual(68);
  });
});
