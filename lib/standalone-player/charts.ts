/**
 * Entry of the optional charts script of the standalone player. It registers
 * exactly the ECharts surface the renderer's chart element loads (see
 * `@openmaic/renderer` `chartRuntime`) on a global; the export inlines it only
 * for classrooms whose slides contain charts.
 */
import { init, use } from 'echarts/core';
import {
  BarChart,
  LineChart,
  PictorialBarChart,
  PieChart,
  RadarChart,
  ScatterChart,
} from 'echarts/charts';
import { LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { STANDALONE_CHARTS_GLOBAL } from '@/lib/export/standalone-html/contract';
import { initWithoutAnimation } from './chart-animation';

(globalThis as Record<string, unknown>)[STANDALONE_CHARTS_GLOBAL] = {
  // The renderer calls only `use` and `init` on the core namespace. Charts
  // render without their entry animation (see initWithoutAnimation).
  core: { init: initWithoutAnimation(init), use },
  charts: { BarChart, LineChart, PictorialBarChart, PieChart, RadarChart, ScatterChart },
  components: { LegendComponent },
  renderers: { SVGRenderer },
};
