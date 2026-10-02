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

it('preserves explicit bar style and series label deletion over chart defaults', () => {
  const xml = `<c:chartSpace ${NS}><c:chart><c:plotArea>
    <c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.02"/><c:y val="0.05"/><c:w val="0.96"/><c:h val="0.8"/></c:manualLayout></c:layout>
    <c:barChart><c:ser><c:dLbls><c:delete val="1"/></c:dLbls><c:dPt><c:idx val="2"/><c:spPr><a:gradFill><a:gsLst><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="0"><a:srgbClr val="FF8800"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></c:spPr></c:dPt></c:ser><c:dLbls><c:showVal val="1"/></c:dLbls><c:gapWidth val="150"/></c:barChart>
    <c:catAx><c:delete val="0"/><c:majorGridlines/><c:txPr><a:p><a:pPr><a:defRPr sz="1600" b="1"/></a:pPr></a:p></c:txPr></c:catAx>
    <c:valAx><c:delete val="1"/><c:majorUnit val="1"/></c:valAx>
  </c:plotArea></c:chart></c:chartSpace>`;
  const ctx = minimalCtx();
  ctx.presentation = {
    ...ctx.presentation,
    charts: new Map([['ppt/charts/chart1.xml', parseXml(xml)]]),
  };
  const el = chartToElement(chartNode(), ctx, 0);
  if (!('importedStyle' in el)) throw new Error('Expected imported chart style');
  expect(el.importedStyle?.series[0].showValue).toBe(false);
  expect(el.importedStyle?.series[0].pointFills?.['2']).toMatchObject({
    colorStops: [
      { offset: 0, color: '#FF8800' },
      { offset: 1, color: '#FFFFFF' },
    ],
  });
  expect(el.importedStyle?.valueAxis?.show).toBe(false);
  expect(el.importedStyle?.valueAxis?.majorUnit).toBe(1);
  expect(el.importedStyle?.categoryAxis?.labelFontSize).toBe(16);
  expect(el.importedStyle?.plotArea?.w).toBe(0.96);
});

it('carries chart formatting through the slide adapter and scales axis text', async () => {
  const { transformParsedToSlides } =
    await import('../src/import-pipeline/transformParsedToSlides');
  const { createMockImportContext } = await import('../src/import-pipeline/mockContext');
  const { slides } = await transformParsedToSlides(
    {
      size: { width: 960, height: 540 },
      themeColors: [],
      slides: [
        {
          fill: { type: 'color', value: '#fff' },
          note: '',
          layoutElements: [],
          elements: [
            {
              type: 'chart',
              chartType: 'barChart',
              barDir: 'col',
              left: 0,
              top: 0,
              width: 400,
              height: 200,
              order: 1,
              colors: ['#123456'],
              data: [{ key: 'A', values: [{ x: '0', y: 0.6 }], xlabels: { '0': 'Example' } }],
              importedStyle: {
                series: [{ showValue: false, fill: '#123456' }],
                categoryAxis: { labelFontSize: 16 },
                valueAxis: { show: false },
              },
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({ ratio: 2 }),
  );
  const chart = slides[0].elements[0];
  if (chart.type !== 'chart') throw new Error('expected chart');
  expect(chart.importedStyle?.series[0].fill).toBe('#123456');
  expect(chart.importedStyle?.categoryAxis?.labelFontSize).toBe(32);
  expect(chart.importedStyle?.valueAxis?.show).toBe(false);
});
it('resolves picture fills through chart-local relationships and reads percent format', () => {
  const xml = `<c:chartSpace ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:barChart><c:ser><c:dPt><c:idx val="1"/><c:spPr><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></c:spPr></c:dPt></c:ser></c:barChart><c:valAx><c:numFmt formatCode="0%"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
  const ctx = minimalCtx();
  ctx.presentation = {
    ...ctx.presentation,
    charts: new Map([['ppt/charts/chart1.xml', parseXml(xml)]]),
    chartRels: new Map([
      [
        'ppt/charts/chart1.xml',
        new Map([['rId2', { type: 'image', target: '../media/test.png' }]]),
      ],
    ]),
    media: new Map([['ppt/media/test.png', new Uint8Array([1, 2, 3])]]),
  };
  const el = chartToElement(chartNode(), ctx, 0);
  if (!('importedStyle' in el)) throw new Error('Expected imported chart style');
  expect(el.importedStyle?.series[0].pointImages?.['1']).toBe('data:image/png;base64,AQID');
  expect(el.importedStyle?.valueAxis?.numberFormat).toBe('0%');
});

it.each([
  ['', 'General', 'General'],
  ['sourceLinked="1"', 'General', 'General'],
  ['sourceLinked="true"', '0%', '0%'],
  ['sourceLinked="0"', 'General', '0%'],
  ['sourceLinked="false"', 'General', '0%'],
  ['sourceLinked="1"', '', '0%'],
])('resolves axis source format (%s, %s)', (linked, cached, expected) => {
  const xml = `<c:chartSpace ${NS}><c:chart><c:plotArea>
    <c:barChart><c:ser><c:val><c:numRef><c:numCache>
      ${cached ? `<c:formatCode>${cached}</c:formatCode>` : ''}
      <c:ptCount val="1"/><c:pt idx="0"><c:v>0.6</c:v></c:pt>
    </c:numCache></c:numRef></c:val></c:ser></c:barChart>
    <c:valAx><c:numFmt formatCode="0%" ${linked}/></c:valAx>
  </c:plotArea></c:chart></c:chartSpace>`;
  const ctx = minimalCtx();
  ctx.presentation = {
    ...ctx.presentation,
    charts: new Map([['ppt/charts/chart1.xml', parseXml(xml)]]),
  };
  const el = chartToElement(chartNode(), ctx, 0);
  if (!('importedStyle' in el)) throw new Error('Expected bar chart style');
  expect(el.importedStyle?.valueAxis?.numberFormat).toBe(expected);
});

it('keeps explicitly unpainted category gridlines hidden', () => {
  const ctx = minimalCtx();
  ctx.presentation = {
    ...ctx.presentation,
    charts: new Map([
      [
        'ppt/charts/chart1.xml',
        parseXml(
          `<c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart><c:ser/></c:barChart><c:catAx><c:majorGridlines><c:spPr><a:ln><a:noFill/></a:ln></c:spPr></c:majorGridlines></c:catAx></c:plotArea></c:chart></c:chartSpace>`,
        ),
      ],
    ]),
  };
  const el = chartToElement(chartNode(), ctx, 0);
  if (!('importedStyle' in el)) throw new Error('Expected bar chart style');
  expect(el.importedStyle?.categoryAxis?.gridlines).toBe(false);
});

it.each(
  ['barChart', 'lineChart', 'areaChart'].flatMap((chartType) =>
    ['percentStacked', 'stacked'].flatMap((grouping) =>
      [false, true].map((sparse) => [chartType, grouping, sparse] as const),
    ),
  ),
)(
  'converts %s %s (sparse labels: %s) without dropping values',
  async (chartType, grouping, sparse) => {
    const { parsedToSlides } = await import('../src/import-pipeline');
    const slides = await parsedToSlides({
      size: { width: 960, height: 540 },
      themeColors: [],
      slides: [
        {
          fill: { type: 'color', value: '#fff' },
          note: '',
          layoutElements: [],
          elements: [
            {
              type: 'chart',
              chartType,
              grouping,
              barDir: 'col',
              left: 0,
              top: 0,
              width: 400,
              height: 200,
              order: 1,
              colors: ['#ff0000', '#0000ff'],
              data: [
                [40, 0, 20],
                [60, 0, 20],
              ].map((values, i) => ({
                key: String(i),
                xlabels: sparse ? { 0: 'A', 2: 'C' } : { 0: 'A', 1: 'B', 2: 'C' },
                values: values.map((y, x) => ({ x: String(x), y })),
              })),
              importedStyle: {
                series: [{}, {}],
                valueAxis: { min: 0, max: 1, numberFormat: '0%' },
              },
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof parsedToSlides>[0]);
    const chart = slides[0].elements[0];
    if (chart.type !== 'chart') throw new Error('expected chart');
    expect(chart.data.series).toEqual([
      [40, 0, 20],
      [60, 0, 20],
    ]);
    expect(chart.options?.percentStack).toBe(grouping === 'percentStacked' ? true : undefined);
    expect(chart.importedStyle?.valueAxis?.max).toBe(1);
  },
);
