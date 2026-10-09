// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { isWebKitEngine, repaintClipPaths } from '../../../src/elements/chart/clipRepaint';

echarts.use([LineChart, GridComponent, SVGRenderer]);

describe('isWebKitEngine', () => {
  it.each([
    [
      'Safari on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    ],
    [
      'Safari on iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ],
    [
      'Chrome on iOS (WebKit underneath)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
    ],
  ])('detects %s', (_, userAgent) => {
    expect(isWebKitEngine(userAgent)).toBe(true);
  });

  it.each([
    [
      'Chrome',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ],
    [
      'Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    ],
    [
      'Chrome on Android',
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    ],
    [
      'Firefox',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
    ],
    ['no user agent', undefined],
  ])('leaves %s alone', (_, userAgent) => {
    expect(isWebKitEngine(userAgent)).toBe(false);
  });
});

function host(): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: 400 });
  Object.defineProperty(element, 'clientHeight', { value: 200 });
  document.body.append(element);
  return element;
}

const lineOption = {
  xAxis: { type: 'category', data: ['a', 'b', 'c'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [1, 3, 2] }],
};

describe('repaintClipPaths', () => {
  it("re-sets the clip shapes of an animated line series without changing the chart's DOM", () => {
    const element = host();
    const chart = echarts.init(element, null, { renderer: 'svg', width: 400, height: 200 });
    chart.setOption(lineOption);
    // The entry animation reveals the line through a clip path on its group.
    const clipShape = element.querySelector('clipPath')?.firstElementChild;
    expect(clipShape).not.toBeNull();
    expect(element.querySelector('[clip-path]')).not.toBeNull();

    const before = element.innerHTML;
    const observer = new MutationObserver(() => undefined);
    observer.observe(element, { subtree: true, attributes: true, childList: true });
    repaintClipPaths(element);
    const records = observer.takeRecords();
    observer.disconnect();

    // Each attribute of the clip shape is written again (which is what makes
    // WebKit repaint), and nothing else is touched.
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.type === 'attributes')).toBe(true);
    expect(records.every((record) => record.target === clipShape)).toBe(true);
    expect(records.map((record) => record.attributeName)).toContain('d');
    expect(element.innerHTML).toBe(before);
    chart.dispose();
  });

  it('is a no-op for charts without clip paths', () => {
    const element = host();
    const chart = echarts.init(element, null, { renderer: 'svg', width: 400, height: 200 });
    chart.setOption({ ...lineOption, animation: false, series: [] });
    const observer = new MutationObserver(() => undefined);
    observer.observe(element, { subtree: true, attributes: true, childList: true });
    repaintClipPaths(element);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    chart.dispose();
  });
});
