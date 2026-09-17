import { expect, it } from 'vitest';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { getChartOption } from '../../../src/elements/chart/chartOption';

echarts.use([BarChart, LineChart, GridComponent, SVGRenderer]);
it.each(['bar', 'column', 'line', 'area'] as const)(
  'plots percent %s as fractions while retaining raw value labels',
  (type) => {
    const data = {
      labels: ['A', 'B', 'C'],
      legends: ['one', 'two'],
      series: [
        [40, 0, 20],
        [60, 0, 20],
      ],
    };
    const option = getChartOption({
      type,
      data,
      themeColors: ['red', 'blue'],
      stack: true,
      percentStack: true,
      importedStyle: {
        series: [{ showValue: true }, { showValue: true }],
        valueAxis: { min: 0, max: 1 },
      },
    });
    const series = option!.series as { data: (number | { value: number })[] }[];
    expect(series.map((s) => s.data.map((v) => (typeof v === 'number' ? v : v.value)))).toEqual([
      [0.4, 0, 0.5],
      [0.6, 0, 0.5],
    ]);
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
    try {
      chart.setOption({ ...option, animation: false });
      const svg = chart.renderToSVGString();
      expect(svg).toMatch(/>40<\/text>/);
      expect(svg).toMatch(/>60<\/text>/);
    } finally {
      chart.dispose();
    }
    expect(data.series).toEqual([
      [40, 0, 20],
      [60, 0, 20],
    ]);
  },
);
