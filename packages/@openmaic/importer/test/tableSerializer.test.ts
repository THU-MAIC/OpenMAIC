import { describe, it, expect, beforeAll } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseTableNode } from '../src/model/nodes/TableNode';
import { tableToElement } from '../src/serializer/tableSerializer';
import { minimalCtx } from './helpers';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/**
 * 回归（auto-fix.md 坑表）：表格 cell 的 <a:noFill/> 必须清掉填充。
 *
 * 现象：教师表每个 cell 显式 <a:noFill/>，但表格样式 firstRow/wholeTbl=accent1，
 *       不处理 noFill 会把整张表错误染成橙色。
 * 修复：tcPr 的 noFill 显式清掉继承自表格样式的填充色。
 *
 * 断言粒度：noFill 的 cell 在 DSL 里没有 fillColor；solidFill 的 cell 取到该色。
 */
describe('tableSerializer · cell noFill 清掉填充', () => {
  const tblXml = `<p:graphicFrame ${NS}>
    <p:nvGraphicFramePr><p:cNvPr id="1" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
    <p:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="1000000"/></p:xfrm>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
      <a:tblPr/>
      <a:tblGrid><a:gridCol w="1500000"/><a:gridCol w="1500000"/></a:tblGrid>
      <a:tr h="500000">
        <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody><a:tcPr><a:noFill/></a:tcPr></a:tc>
        <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:tcPr></a:tc>
      </a:tr>
    </a:tbl></a:graphicData></a:graphic>
  </p:graphicFrame>`;

  let cellNoFill: { fillColor?: string };
  let cellSolid: { fillColor?: string };

  beforeAll(() => {
    const table = tableToElement(parseTableNode(parseXml(tblXml)), minimalCtx(), 0) as {
      data: Array<Array<{ fillColor?: string }>>;
    };
    [cellNoFill, cellSolid] = table.data[0];
  });

  it('noFill 的 cell 没有 fillColor', () => {
    expect(cellNoFill.fillColor).toBeUndefined();
  });

  it('solidFill 的 cell 取到对应颜色', () => {
    expect(cellSolid.fillColor).toBe('#FF0000');
  });
});
