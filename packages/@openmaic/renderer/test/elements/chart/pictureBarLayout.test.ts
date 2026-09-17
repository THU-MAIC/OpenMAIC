import { expect, it } from 'vitest';
import * as echarts from 'echarts/core';
import { BarChart, PictorialBarChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { getChartOption, type ChartOptionPayload } from '../../../src/elements/chart/chartOption';

echarts.use([BarChart, PictorialBarChart, GridComponent, SVGRenderer]);

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=';
interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ModelAccess {
  getModel(): {
    getSeriesByIndex(index: number): { getData(): { getItemLayout(index: number): Layout } };
  };
}
function render(input: ChartOptionPayload) {
  const chart = echarts.init(null, undefined, {
    renderer: 'svg',
    ssr: true,
    width: 600,
    height: 400,
  });
  chart.setOption({ ...getChartOption(input), animation: false });
  const model = (chart as unknown as ModelAccess).getModel();
  const layouts = input.data.series.map((_, index) =>
    model.getSeriesByIndex(index).getData().getItemLayout(0),
  );
  const svg = chart.renderToSVGString();
  chart.dispose();
  return { layouts, svg };
}

it.each(['bar', 'column'] as const)(
  'keeps clustered picture and ordinary %s series separate',
  (type) => {
    const base: ChartOptionPayload = {
      type,
      data: {
        labels: ['A', 'B'],
        legends: ['S1', 'S2'],
        series: [
          [3, 4],
          [5, 6],
        ],
      },
      themeColors: ['#ff0000', '#0000ff'],
    };
    for (const series of [
      [{ pointImages: { '0': image } }, { pointImages: { '0': image } }],
      [{ pointImages: { '0': image } }, {}],
      [{ pointImages: { '0': image } }],
      [{}, { pointImages: { '0': image } }],
    ]) {
      const { layouts, svg } = render({ ...base, importedStyle: { series } });
      const [a, b] = layouts;
      if (type === 'bar') expect(a.x + a.width).toBeLessThanOrEqual(b.x);
      else expect(Math.max(a.y, a.y + a.height)).toBeLessThanOrEqual(Math.min(b.y, b.y + b.height));
      expect(svg).toContain('<image');
    }
  },
);

it.each([
  ['bar', 10],
  ['bar', -10],
  ['column', 10],
  ['column', -10],
] as const)('clips picture %s outside the value bounds: %s', (type, value) => {
  const { svg } = render({
    type,
    data: { labels: ['A'], legends: ['S'], series: [[value]] },
    themeColors: ['#ff0000'],
    importedStyle: { series: [{ pointImages: { '0': image } }], valueAxis: { min: -5, max: 5 } },
  });
  expect(svg).toContain('<image');
  expect(svg).toMatch(/<g clip-path="url\(#/);
  expect(svg).toContain('<clipPath');
});

it('keeps stacked charts on the ordinary bar layout even with imported pictures', () => {
  const input: ChartOptionPayload = {
    type: 'bar',
    stack: true,
    data: { labels: ['A'], legends: ['S1', 'S2'], series: [[3], [5]] },
    themeColors: ['#ff0000', '#0000ff'],
    importedStyle: { series: [{ pointImages: { '0': image } }, {}] },
  };
  const { layouts, svg } = render(input);
  expect(svg).not.toContain('<image');
  expect(layouts[0].x).toBe(layouts[1].x);
  expect(layouts[0].y + layouts[0].height).toBeCloseTo(layouts[1].y);
});
