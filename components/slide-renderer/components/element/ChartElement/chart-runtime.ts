import type * as EChartsCore from 'echarts/core';

export type EChartsRuntime = typeof EChartsCore;

let runtime: Promise<EChartsRuntime> | undefined;

/**
 * Load and register the ECharts surface chart elements use, once. A dynamic
 * import keeps it out of every page that renders slides: most courses have no
 * chart, and these libraries are the largest part of the classroom bundle. A
 * failed load is forgotten, so the next chart retries it.
 */
export function loadChartRuntime(): Promise<EChartsRuntime> {
  if (!runtime) {
    const attempt: Promise<EChartsRuntime> = Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
      import('echarts/features'),
    ]).then(([echarts, charts, components, renderers, features]) => {
      echarts.use([
        charts.BarChart,
        charts.LineChart,
        charts.PieChart,
        charts.ScatterChart,
        charts.RadarChart,
        components.LegendComponent,
        renderers.SVGRenderer,
      ]);
      // ECharts 6 makes the ECharts 5 containLabel layout an opt-in feature.
      if (features.LegacyGridContainLabel) echarts.use(features.LegacyGridContainLabel);
      return echarts;
    });
    runtime = attempt;
    attempt.catch(() => {
      if (runtime === attempt) runtime = undefined;
    });
  }
  return runtime;
}
