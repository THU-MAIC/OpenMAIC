import { expect, it } from 'vitest';
import { getChartOption } from '../../../src/elements/chart/chartOption';
// The assertions below exercise the concrete bar option shape returned here.
interface TestedBarOption {
  series: Array<{
    type: string;
    label: { show: boolean };
    data: Array<number | { itemStyle: { color: unknown }; symbol: string }>;
    barCategoryGap: string;
    symbolSize: string[];
  }>;
  xAxis: {
    min: number;
    max: number;
    splitLine: { show: boolean };
    axisLabel: { fontWeight: string };
  };
  yAxis: {
    show: boolean;
    interval: number;
    type: string;
    max: (extent: { min?: number; max: number }) => number;
    axisLabel: { formatter: (value: number) => string };
  };
  grid: { left: string };
}
function point(value: TestedBarOption['series'][number]['data'][number]) {
  if (typeof value === 'number') throw new Error('Expected a styled chart point');
  return value;
}
const base = {
  type: 'bar' as const,
  data: { labels: ['A', 'B'], legends: ['S'], series: [[0.45, 0.6]] },
  themeColors: ['#ff8800'],
};
it('keeps legacy chart defaults without imported style', () => {
  const o = getChartOption(base) as unknown as TestedBarOption;
  expect(o.series[0].label.show).toBe(true);
  expect(o.series[0].data).toEqual([0.45, 0.6]);
});
it('honors imported bar point fills, hidden labels and axis configuration', () => {
  const gradient = {
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: '#ff8800' },
      { offset: 1, color: '#ffccaa' },
    ],
  };
  const o = getChartOption({
    ...base,
    importedStyle: {
      series: [{ showValue: false, fill: '#ff0000', pointFills: { '1': gradient } }],
      categoryAxis: { show: true, gridlines: true, labelFontSize: 16, labelBold: true },
      valueAxis: { show: false, gridlines: false, majorUnit: 1 },
      gapWidth: 150,
      plotArea: { x: 0.02, y: 0.05, w: 0.96, h: 0.8 },
    },
  }) as unknown as TestedBarOption;
  expect(o.series[0].label.show).toBe(false);
  expect(point(o.series[0].data[1]).itemStyle.color).toEqual(gradient);
  expect(point(o.series[0].data[0]).itemStyle.color).toBe('#ff0000');
  expect(o.series[0].barCategoryGap).toBe('60%');
  expect(o.yAxis.show).toBe(false);
  expect(o.yAxis.interval).toBe(1);
  expect(o.yAxis.max({ max: 0.6 })).toBe(1);
  expect(o.xAxis.splitLine.show).toBe(true);
  expect(o.xAxis.axisLabel.fontWeight).toBe('bold');
  expect(o.grid.left).toBe('2%');
});

it('preserves explicit bounds and applies styles to horizontal bars', () => {
  const o = getChartOption({
    ...base,
    type: 'column',
    importedStyle: { series: [], valueAxis: { min: -2, max: 3, majorUnit: 1 } },
  }) as unknown as TestedBarOption;
  expect(o.xAxis.min).toBe(-2);
  expect(o.xAxis.max).toBe(3);
  expect(o.yAxis.type).toBe('category');
});
it('renders stretched point images and percentage axis without value labels', () => {
  const o = getChartOption({
    ...base,
    importedStyle: {
      series: [{ pointImages: { '0': 'data:image/png;base64,AA==' }, showValue: false }],
      gapWidth: 0,
      valueAxis: { numberFormat: '0%' },
    },
  }) as unknown as TestedBarOption;
  expect(o.series[0].type).toBe('pictorialBar');
  expect(decodeURIComponent(point(o.series[0].data[0]).symbol)).toContain(
    'preserveAspectRatio="none"',
  );
  expect(decodeURIComponent(point(o.series[0].data[0]).symbol)).toContain(
    'data:image/png;base64,AA==',
  );
  expect(point(o.series[0].data[1]).symbol).toBe('rect');
  expect(o.series[0].symbolSize).toEqual(['100%', '100%']);
  expect(o.yAxis.axisLabel.formatter(0.6)).toBe('60%');
  expect(o.yAxis.max({ max: 0.6, min: 0 })).toBeCloseTo(0.7);
});

it.each(['bar', 'column'] as const)(
  'preserves default and explicit axis line visibility for %s',
  (type) => {
    for (const lineVisible of [undefined, true, false]) {
      const o = getChartOption({
        ...base,
        type,
        importedStyle: { series: [], valueAxis: { lineVisible } },
      }) as unknown as Record<string, { axisLine: { show: boolean } }>;
      expect(o[type === 'bar' ? 'yAxis' : 'xAxis'].axisLine.show).toBe(lineVisible ?? true);
    }
  },
);
it('tolerates persisted imported styles without a series array', () => {
  expect(() => getChartOption({ ...base, importedStyle: {} as never })).not.toThrow();
});
