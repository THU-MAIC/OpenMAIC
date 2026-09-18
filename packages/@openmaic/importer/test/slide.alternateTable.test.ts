// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseChildNode } from '../src/model/Slide';
import { tableToElement } from '../src/serializer/tableSerializer';
import { parsedToSlides } from '../src/import-pipeline';
import { minimalCtx } from './helpers';

const frame = `<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="95250" y="190500"/><a:ext cx="1905000" cy="952500"/></p:xfrm>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
    <a:tblPr/><a:tblGrid><a:gridCol w="952500"/><a:gridCol w="952500"/></a:tblGrid>
    <a:tr h="952500">
      <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>实际利率</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
      <a:tc><a:txBody><a:bodyPr/><a:p><a14:m><m:oMath><m:f>
        <m:num><m:r><m:t>i</m:t></m:r></m:num>
        <m:den><m:r><m:t>1+i</m:t></m:r></m:den>
      </m:f></m:oMath></a14:m></a:p></a:txBody><a:tcPr/></a:tc>
    </a:tr>
  </a:tbl></a:graphicData></a:graphic>
</p:graphicFrame>`;
const namespaces = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;

describe('tables inside compatibility choices', () => {
  it('imports the editable table with its inline formula instead of dropping it or using the preview', async () => {
    const xml = `<mc:AlternateContent ${namespaces}><mc:Choice Requires="a14">${frame}</mc:Choice>
      <mc:Fallback><p:pic><p:nvPicPr><p:cNvPr id="6" name="Preview"/></p:nvPicPr></p:pic></mc:Fallback>
    </mc:AlternateContent>`;
    const node = parseChildNode(parseXml(xml), new Map(), 'ppt/slides/slide23.xml');
    expect(node?.nodeType).toBe('table');
    if (node?.nodeType !== 'table') throw new Error('Expected table');
    expect(node.columns).toHaveLength(2);
    expect(node.rows).toHaveLength(1);
    const table = tableToElement(node, minimalCtx(), 0);
    expect(JSON.stringify(table)).toContain('实际利率');
    expect(JSON.stringify(table)).toContain('katex');
    expect(JSON.stringify(table)).toContain('frac');
    const slides = await parsedToSlides({
      size: { width: 960, height: 540 },
      themeColors: [],
      slides: [
        {
          fill: { type: 'color', value: '#ffffff' },
          note: '',
          layoutElements: [],
          elements: [table],
        },
      ],
    } as unknown as Parameters<typeof parsedToSlides>[0]);
    const result = slides[0].elements[0];
    expect(result.type).toBe('table');
    if (result.type !== 'table') throw new Error('Expected final table');
    expect(result.data[0][1].text).toContain('class="katex"');
    expect(result.data[0][1].text).toContain('class="mfrac"');
  });
});
