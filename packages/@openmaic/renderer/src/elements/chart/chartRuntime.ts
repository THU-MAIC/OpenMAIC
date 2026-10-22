import type * as echartsCore from 'echarts/core';

type EChartsRuntime = typeof echartsCore;

let runtimePromise: Promise<EChartsRuntime> | undefined;

/**
 * Load and register the small ECharts surface used by chart elements.
 *
 * Keeping this behind a shared promise is important for two reasons: charts
 * remain optional for consumers that only render text/images, and multiple
 * charts on one slide do not race to register the same ECharts extensions.
 */
export function loadChartRuntime(): Promise<EChartsRuntime> {
  runtimePromise ??= Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
    import('echarts/features'),
  ]).then(([echarts, charts, components, renderers, features]) => {
    echarts.use([
      charts.BarChart,
      charts.PictorialBarChart,
      charts.LineChart,
      charts.PieChart,
      charts.ScatterChart,
      charts.RadarChart,
      components.LegendComponent,
      renderers.SVGRenderer,
    ]);
    // ECharts 5 includes containLabel; ECharts 6 exposes it as an opt-in.
    if (features.LegacyGridContainLabel) echarts.use(features.LegacyGridContainLabel);
    return echarts;
  });

  return runtimePromise;
}
