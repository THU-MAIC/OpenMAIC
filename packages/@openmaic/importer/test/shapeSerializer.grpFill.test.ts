import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseShapeNode } from '../src/model/nodes/ShapeNode';
import { renderShape } from '../src/serializer/shapeSerializer';
import { minimalCtx } from './helpers';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function shapeXml(spPrInner: string, styleInner = ''): string {
  return `<p:sp ${NS}>
    <p:nvSpPr><p:cNvPr id="1" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      ${spPrInner}
    </p:spPr>
    ${styleInner ? `<p:style>${styleInner}</p:style>` : ''}
    <p:txBody><a:bodyPr/><a:p/></p:txBody>
  </p:sp>`;
}

function customShapeXml(spPrInner: string): string {
  return `<p:sp ${NS}>
    <p:nvSpPr><p:cNvPr id="2" name="custom"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr>
      <a:xfrm><a:off x="0" y="0"/><a:ext cx="20000" cy="5000"/></a:xfrm>
      <a:custGeom>
        <a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>
        <a:rect l="l" t="t" r="r" b="b"/>
        <a:pathLst>
          <a:path w="20000" h="5000">
            <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
            <a:lnTo><a:pt x="20000" y="0"/></a:lnTo>
            <a:lnTo><a:pt x="20000" y="5000"/></a:lnTo>
            <a:lnTo><a:pt x="0" y="5000"/></a:lnTo>
            <a:close/>
          </a:path>
        </a:pathLst>
      </a:custGeom>
      ${spPrInner}
    </p:spPr>
    <p:txBody><a:bodyPr/><a:p/></p:txBody>
  </p:sp>`;
}

describe('shapeSerializer · grpFill 继承父 group 填充', () => {
  it('父 group 有 solidFill 时，子 shape 的 grpFill 继承父填充色', async () => {
    const groupFillNode = parseXml(`<p:grpSpPr ${NS}>
      <a:solidFill><a:srgbClr val="6124C3"/></a:solidFill>
    </p:grpSpPr>`);
    const el = await renderShape(
      parseShapeNode(parseXml(shapeXml('<a:grpFill/>'))),
      minimalCtx({ groupFillNode }),
      0,
    );

    expect(el.fill).toEqual({ type: 'color', value: '#6124C3' });
  });

  it('没有父 group 填充时，grpFill 不回退到 fillRef', async () => {
    const el = await renderShape(
      parseShapeNode(
        parseXml(
          shapeXml('<a:grpFill/>', '<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>'),
        ),
      ),
      minimalCtx({
        theme: {
          ...minimalCtx().theme,
          fillStyles: [parseXml(`<a:solidFill ${NS}><a:srgbClr val="FF0000"/></a:solidFill>`)],
        },
      }),
      0,
    );

    expect(el.fill).toEqual({ type: 'color', value: 'transparent' });
  });
});

describe('shapeSerializer · filled customGeometry 不应被误判为线段', () => {
  it('局部高度很小但有显式渐变填充的 customGeometry 保留面积填充', async () => {
    const el = await renderShape(
      parseShapeNode(
        parseXml(
          customShapeXml(`
            <a:gradFill flip="none" rotWithShape="1">
              <a:gsLst>
                <a:gs pos="0"><a:srgbClr val="EBE0FD"/></a:gs>
                <a:gs pos="100000"><a:srgbClr val="C3A2F7"/></a:gs>
              </a:gsLst>
              <a:lin ang="5400000" scaled="0"/>
            </a:gradFill>
          `),
        ),
      ),
      minimalCtx(),
      0,
    );

    expect(el.fill.type).toBe('gradient');
  });
});
