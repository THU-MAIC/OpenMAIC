// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { init, use as registerEcharts } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { initWithoutAnimation } from '@/lib/standalone-player/chart-animation';

registerEcharts([LineChart, GridComponent, SVGRenderer]);

function host(): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: 400 });
  Object.defineProperty(element, 'clientHeight', { value: 200 });
  document.body.append(element);
  return element;
}

/** Width of the line series' clip rectangle (`M x y l w 0 …`). */
function clipWidth(element: HTMLElement): number {
  const d = element.querySelector('clipPath path')?.getAttribute('d') ?? '';
  return Number(/l([\d.]+) 0/.exec(d)?.[1] ?? Number.NaN);
}

const option = {
  animation: true,
  xAxis: { type: 'category', data: ['a', 'b', 'c'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [1, 3, 2] }],
};

describe('standalone player charts', () => {
  it('renders every chart without the entry animation', () => {
    const chart = initWithoutAnimation(init)(host(), null, {
      renderer: 'svg',
      width: 400,
      height: 200,
    });
    chart.setOption(option);
    expect(chart.getOption().animation).toBe(false);
    // Later updates (the renderer re-applies options on change) stay unanimated.
    chart.setOption({ ...option, series: [{ type: 'line', data: [2, 1, 3] }] }, true);
    expect(chart.getOption().animation).toBe(false);
    chart.dispose();
  });

  it('draws a line chart with its clip path at full size from the start', () => {
    const element = host();
    const chart = initWithoutAnimation(init)(element, null, {
      renderer: 'svg',
      width: 400,
      height: 200,
    });
    chart.setOption(option);
    const clip = element.querySelector('clipPath path, clipPath rect');
    // With the entry animation the first frame's clip is a sliver a few px
    // wide; WebKit keeps painting that frame.
    const width = Number(
      /l([\d.]+) 0/.exec(clip?.getAttribute('d') ?? '')?.[1] ?? clip?.getAttribute('width'),
    );
    expect(width).toBeGreaterThan(300);
    chart.dispose();
  });

  it('leaves the stock init animating, starting from a sliver-wide clip', () => {
    const element = host();
    const chart = init(element, null, { renderer: 'svg', width: 400, height: 200 });
    chart.setOption(option);
    expect(chart.getOption().animation).toBe(true);
    expect(clipWidth(element)).toBeLessThan(50);
    chart.dispose();
  });
});
