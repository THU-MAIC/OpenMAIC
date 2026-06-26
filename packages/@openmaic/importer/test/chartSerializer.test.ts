import { describe, expect, it } from 'vitest';
import type { ChartNodeData } from '../src/model/nodes/ChartNode';
import { parseXml, SafeXmlNode } from '../src/parser/XmlParser';
import { chartToElement } from '../src/serializer/chartSerializer';
import { minimalCtx } from './helpers';

const NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function chartNode(): ChartNodeData {
  return {
    id: 'chart',
    name: 'chart',
    nodeType: 'chart',
    chartPath: 'ppt/charts/chart1.xml',
    position: { x: 0, y: 0 },
    size: { w: 640, h: 360 },
    rotation: 0,
    flipH: false,
    flipV: false,
    source: new SafeXmlNode(null),
    xmlOrder: 1,
  };
}

describe('chartSerializer', () => {
  it('line+area 组合图保留面积图类型，并按 numFmt 格式化日期横轴', () => {
    const chartXml = `<c:chartSpace ${NS}>
      <c:chart><c:plotArea>
        <c:areaChart>
          <c:ser>
            <c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>辅助列</c:v></c:pt></c:strCache></c:strRef></c:tx>
            <c:cat><c:numRef><c:numCache><c:formatCode>m&quot;月&quot;d&quot;日&quot;;@</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>46098</c:v></c:pt><c:pt idx="1"><c:v>46112</c:v></c:pt></c:numCache></c:numRef></c:cat>
            <c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>16504</c:v></c:pt><c:pt idx="1"><c:v>107753</c:v></c:pt></c:numCache></c:numRef></c:val>
          </c:ser>
        </c:areaChart>
        <c:lineChart>
          <c:ser>
            <c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>全站历史累计用户总数（人）</c:v></c:pt></c:strCache></c:strRef></c:tx>
            <c:spPr><a:ln><a:solidFill><a:srgbClr val="6124C3"/></a:solidFill></a:ln></c:spPr>
            <c:marker><c:symbol val="circle"/></c:marker>
            <c:cat><c:numRef><c:numCache><c:formatCode>m&quot;月&quot;d&quot;日&quot;;@</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>46098</c:v></c:pt><c:pt idx="1"><c:v>46112</c:v></c:pt></c:numCache></c:numRef></c:cat>
            <c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>16504</c:v></c:pt><c:pt idx="1"><c:v>107753</c:v></c:pt></c:numCache></c:numRef></c:val>
          </c:ser>
        </c:lineChart>
      </c:plotArea></c:chart>
    </c:chartSpace>`;

    const el = chartToElement(
      chartNode(),
      minimalCtx({
        presentation: {
          charts: new Map([['ppt/charts/chart1.xml', parseXml(chartXml)]]),
        } as unknown as ReturnType<typeof minimalCtx>['presentation'],
      }),
      0,
    );

    expect(el.chartType).toBe('areaChart');
    const data = el.data as Exclude<typeof el.data, [number[], number[]]>;
    expect(data[0].key).toBe('全站历史累计用户总数（人）');
    expect(data[0].xlabels).toEqual({
      '0': '3月17日',
      '1': '3月31日',
    });
    expect(el.colors[0]).toBe('#6124C3');
  });

  it('keeps blank date-formatted category labels blank', () => {
    const chartXml = `<c:chartSpace ${NS}>
      <c:chart><c:plotArea>
        <c:lineChart>
          <c:ser>
            <c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>累计用户</c:v></c:pt></c:strCache></c:strRef></c:tx>
            <c:cat><c:numRef><c:numCache><c:formatCode>m&quot;月&quot;d&quot;日&quot;;@</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>46098</c:v></c:pt><c:pt idx="1"><c:v>   </c:v></c:pt></c:numCache></c:numRef></c:cat>
            <c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>16504</c:v></c:pt><c:pt idx="1"><c:v>107753</c:v></c:pt></c:numCache></c:numRef></c:val>
          </c:ser>
        </c:lineChart>
      </c:plotArea></c:chart>
    </c:chartSpace>`;

    const el = chartToElement(
      chartNode(),
      minimalCtx({
        presentation: {
          charts: new Map([['ppt/charts/chart1.xml', parseXml(chartXml)]]),
        } as unknown as ReturnType<typeof minimalCtx>['presentation'],
      }),
      0,
    );

    const data = el.data as Exclude<typeof el.data, [number[], number[]]>;
    expect(data[0].xlabels).toEqual({
      '0': '3月17日',
      '1': '   ',
    });
  });
});
