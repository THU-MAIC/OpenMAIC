'use client';

import dynamic from 'next/dynamic';

/**
 * Lazy boundary for the chart renderer. `Chart` pulls in ECharts (~500 KB),
 * which most lessons never use, so loading it eagerly bloated the initial
 * classroom bundle. Here it is fetched on demand — only when a slide actually
 * contains a chart element. Chart is already client-only (it calls
 * `echarts.init` on a DOM ref in an effect), so `ssr: false` matches its
 * behaviour. Same props as the underlying `Chart`.
 */
export const Chart = dynamic(() => import('./Chart').then((m) => m.Chart), {
  ssr: false,
  loading: () => <div className="w-full h-full" />,
});
