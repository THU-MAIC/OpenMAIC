// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chart } from '../../../src/elements/chart/Chart';

const setOption = vi.fn();
const on = vi.fn();
const init = vi.fn(() => ({
  setOption,
  on,
  resize: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../../../src/elements/chart/chartRuntime', () => ({
  loadChartRuntime: () => Promise.resolve({ init }),
}));

const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function renderChart() {
  return render(
    <Chart
      width={320}
      height={180}
      type="line"
      data={{ labels: ['A', 'B'], legends: ['Series'], series: [[1, 2]] }}
      themeColors={['#3366ff']}
    />,
  );
}

async function waitUntilReady(container: HTMLElement) {
  await waitFor(() => {
    expect(container.firstElementChild?.getAttribute('data-chart-state')).toBe('ready');
  });
}

describe('Chart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads ECharts asynchronously and applies the option after it is ready', async () => {
    const { container } = renderChart();

    expect(container.firstElementChild?.getAttribute('data-chart-state')).toBe('loading');
    await waitUntilReady(container);
    expect(init).toHaveBeenCalledTimes(1);
    expect(setOption).toHaveBeenCalledOnce();
  });

  it('repaints clip paths after every rendered frame on WebKit', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(SAFARI);
    const { container } = renderChart();
    await waitUntilReady(container);

    expect(on).toHaveBeenCalledWith('rendered', expect.any(Function));
    const chartElement = container.firstElementChild as HTMLElement;
    chartElement.innerHTML =
      '<svg><g clip-path="url(#c)"></g><defs><clipPath id="c"><path d="M0 0l10 0"></path></clipPath></defs></svg>';
    const observer = new MutationObserver(() => undefined);
    observer.observe(chartElement, { subtree: true, attributes: true });
    const onRendered = on.mock.calls[0][1] as () => void;
    onRendered();
    expect(observer.takeRecords().map((record) => record.attributeName)).toEqual(['d']);
    observer.disconnect();
  });

  it('does not touch the chart on other engines', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME);
    const { container } = renderChart();
    await waitUntilReady(container);

    expect(on).not.toHaveBeenCalled();
  });
});
