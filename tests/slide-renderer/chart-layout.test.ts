import { beforeAll, describe, expect, it } from 'vitest';
import * as echarts from 'echarts/core';
import type { ComponentModel } from 'echarts/core';

import { getChartOption as getAppChartOption } from '@/components/slide-renderer/components/element/ChartElement/chartOption';
import { getChartOption as getPackageChartOption } from '@/packages/@openmaic/renderer/src/elements/chart/chartOption';
import { loadChartRuntime } from '@/packages/@openmaic/renderer/src/elements/chart/chartRuntime';

beforeAll(() => loadChartRuntime());

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ModelAccess {
  getModel(): {
    getComponent(type: string): ComponentModel & { coordinateSystem: { getRect(): Rect } };
  };
  getViewOfComponentModel(model: ComponentModel): {
    group: InstanceType<typeof echarts.graphic.Group>;
  };
}

const chartTypes = ['bar', 'column', 'line', 'area', 'scatter'] as const;
const sizes = [
  { width: 280, height: 140 },
  { width: 280, height: 145 },
  { width: 160, height: 100 },
  { width: 560, height: 300 },
];
const data = {
  labels: ['A', 'B'],
  legends: ['First', 'Second'],
  series: [
    [1, 2],
    [2, 1],
  ],
};
const themeColors = ['#5b9bd5', '#ed7d31'];

function render(option: ReturnType<typeof getPackageChartOption>, size = sizes[0]) {
  const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, ...size });
  chart.setOption({ ...option, animation: false });
  return chart;
}

function plotRect(chart: echarts.ECharts): Rect {
  return (chart as unknown as ModelAccess)
    .getModel()
    .getComponent('grid')
    .coordinateSystem.getRect();
}

function componentRect(chart: echarts.ECharts, type: string): Rect {
  const access = chart as unknown as ModelAccess;
  const { group } = access.getViewOfComponentModel(access.getModel().getComponent(type));
  const rect = group.getBoundingRect().clone();
  const transform = group.getComputedTransform();
  if (transform) rect.applyTransform(transform);
  return rect;
}

function expectInside(rect: Rect, width: number, height: number) {
  expect(rect.x).toBeGreaterThanOrEqual(-1);
  expect(rect.y).toBeGreaterThanOrEqual(-1);
  expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(height + 1);
}

describe.each([
  ['app', getAppChartOption],
  ['SDK', getPackageChartOption],
] as const)('%s Cartesian chart layout', (_, getChartOption) => {
  describe.each(chartTypes)('%s', (type) => {
    it.each(sizes)('fits the plot, axes and legend in $width x $height', ({ width, height }) => {
      for (const seriesCount of [1, 2]) {
        const chart = render(
          getChartOption({
            type,
            data: { ...data, series: data.series.slice(0, seriesCount) },
            themeColors,
          }),
          { width, height },
        );
        try {
          const plot = plotRect(chart);
          expect(plot.height).toBeGreaterThan(height * 0.3);
          expect(plot.width).toBeGreaterThan(width * 0.4);
          expectInside(plot, width, height);
          const xAxis = componentRect(chart, 'xAxis');
          expectInside(xAxis, width, height);
          expectInside(componentRect(chart, 'yAxis'), width, height);
          if (type !== 'scatter' && seriesCount > 1) {
            const legend = componentRect(chart, 'legend');
            expectInside(legend, width, height);
            expect(xAxis.y + xAxis.height).toBeLessThanOrEqual(legend.y);
          }
          expect(chart.renderToSVGString()).toContain('<path');
          for (const element of chart.getZr().storage.getDisplayList()) {
            if (element.type !== 'tspan' || element.invisible) continue;
            const rect = element.getBoundingRect().clone();
            const transform = element.getComputedTransform();
            if (transform) rect.applyTransform(transform);
            expectInside(rect, width, height);
          }
        } finally {
          chart.dispose();
        }
      }
    });

    it('reflows when resized from tall to short and back without rebuilding options', () => {
      const chart = render(getChartOption({ type, data, themeColors }), {
        width: 560,
        height: 300,
      });
      try {
        for (const size of [...sizes, sizes[0]]) {
          chart.resize(size);
          const fresh = render(getChartOption({ type, data, themeColors }), size);
          try {
            expect(plotRect(chart).height).toBeGreaterThan(size.height * 0.3);
            expect(plotRect(chart)).toEqual(plotRect(fresh));
          } finally {
            fresh.dispose();
          }
        }
      } finally {
        chart.dispose();
      }
    });
  });

  it('keeps many long legend entries in a single scrollable row', () => {
    const chart = render(
      getChartOption({
        type: 'bar',
        themeColors,
        data: {
          labels: ['A', 'B'],
          legends: Array.from({ length: 8 }, (_, i) => `Long series name ${i}`),
          series: Array.from({ length: 8 }, () => [1, 2]),
        },
      }),
    );
    try {
      expect(chart.getOption().legend).toMatchObject([{ type: 'scroll', orient: 'horizontal' }]);
      expect(plotRect(chart).height).toBeGreaterThan(42);
      expect(chart.renderToSVGString()).toContain('<clipPath');
    } finally {
      chart.dispose();
    }
  });
});

it.each(chartTypes)('preserves an imported %s plot area on render and resize', (type) => {
  const plotArea = { x: 0.02, y: 0.05, w: 0.96, h: 0.8 };
  const chart = render(
    getPackageChartOption({ type, data, themeColors, importedStyle: { plotArea, series: [] } }),
  );
  try {
    for (const { width, height } of sizes) {
      chart.resize({ width, height });
      const plot = plotRect(chart);
      expect(plot.x).toBeCloseTo(width * plotArea.x);
      expect(plot.y).toBeCloseTo(height * plotArea.y);
      expect(plot.width).toBeCloseTo(width * plotArea.w);
      expect(plot.height).toBeCloseTo(height * plotArea.h);
    }
  } finally {
    chart.dispose();
  }
});
