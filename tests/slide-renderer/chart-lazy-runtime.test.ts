// @vitest-environment jsdom

/**
 * A chart element draws once the chart library has loaded, which happens after
 * its first render: it must draw the props of that moment, and draw nothing at
 * all if it has already gone away.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartData } from '@openmaic/dsl';

const probe = vi.hoisted(() => ({
  resolve: (_runtime: unknown) => {},
  reject: (_error: unknown) => {},
}));

vi.mock('@/components/slide-renderer/components/element/ChartElement/chart-runtime', () => ({
  loadChartRuntime: () =>
    new Promise((resolve, reject) => {
      probe.resolve = resolve;
      probe.reject = reject;
    }),
}));

import { Chart } from '@/components/slide-renderer/components/element/ChartElement/Chart';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const instance = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
const runtime = { init: vi.fn(() => instance) };
const data = (label: string): ChartData => ({
  labels: [label],
  legends: ['Series'],
  series: [[1]],
});

let root: Root;
const render = (label: string) =>
  act(async () =>
    root.render(
      createElement(Chart, {
        width: 400,
        height: 300,
        type: 'bar',
        data: data(label),
        themeColors: ['#5b9bd5', '#ed7d31'],
      }),
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('a chart element drawing after its library loads', () => {
  it('draws the props current when the library arrives, not the first ones', async () => {
    await render('first');
    expect(runtime.init).not.toHaveBeenCalled();
    await render('latest');
    await act(async () => probe.resolve(runtime));
    expect(runtime.init).toHaveBeenCalledTimes(1);
    expect(instance.setOption).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(instance.setOption.mock.calls[0]![0])).toContain('latest');
  });

  it('applies later prop changes to the chart it drew', async () => {
    await render('first');
    await act(async () => probe.resolve(runtime));
    await render('second');
    expect(JSON.stringify(instance.setOption.mock.lastCall![0])).toContain('second');
  });

  it('draws nothing when it unmounted before the library arrived', async () => {
    await render('first');
    const resolve = probe.resolve;
    await act(async () => root.unmount());
    await act(async () => resolve(runtime));
    expect(runtime.init).not.toHaveBeenCalled();
    root = createRoot(document.createElement('div'));
  });

  it('survives a library that fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render('first');
    await act(async () => probe.reject(new Error('chunk failed')));
    expect(runtime.init).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
