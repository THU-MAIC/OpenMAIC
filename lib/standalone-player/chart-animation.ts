import type { init as echartsInit } from 'echarts/core';

type Init = typeof echartsInit;
type SetOption = (option: unknown, ...rest: unknown[]) => void;

/**
 * Wrap ECharts `init` so every chart it creates renders without animation.
 *
 * Why: line series animate in by growing an SVG `<clipPath>` from zero width.
 * WebKit (Safari) does not repaint the clipped group when the clip path's
 * geometry changes afterwards, so the line stays clipped to its first,
 * near-empty frame: points and labels show, the connecting line does not.
 * Re-setting the clip path's `d` to the same value makes the line appear,
 * which confirms the stale paint. Without the entry animation
 * the clip path is created at its final size and nothing needs repainting.
 * The exported file is a static player, so charts simply appear drawn.
 *
 * The renderer's chart element now repaints clipped series on WebKit itself;
 * this stays so the offline file draws every chart in its final state on the
 * first frame, whatever the browser, with no repaint work per frame.
 */
export function initWithoutAnimation(init: Init): Init {
  return ((...args: Parameters<Init>) => {
    const chart = init(...args);
    const setOption = chart.setOption.bind(chart) as SetOption;
    (chart as unknown as { setOption: SetOption }).setOption = (option, ...rest) =>
      setOption(
        option && typeof option === 'object' ? { ...option, animation: false } : option,
        ...rest,
      );
    return chart;
  }) as Init;
}
