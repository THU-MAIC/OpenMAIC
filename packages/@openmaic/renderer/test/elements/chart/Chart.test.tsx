// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Chart } from '../../../src/elements/chart/Chart';

const setOption = vi.fn();
const init = vi.fn(() => ({
  setOption,
  resize: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../../../src/elements/chart/chartRuntime', () => ({
  loadChartRuntime: () => Promise.resolve({ init }),
}));

describe('Chart', () => {
  it('loads ECharts asynchronously and applies the option after it is ready', async () => {
    const { container } = render(
      <Chart
        width={320}
        height={180}
        type="bar"
        data={{ labels: ['A'], legends: ['Series'], series: [[1]] }}
        themeColors={['#3366ff']}
      />,
    );

    expect(container.firstElementChild?.getAttribute('data-chart-state')).toBe('loading');
    await waitFor(() => {
      expect(container.firstElementChild?.getAttribute('data-chart-state')).toBe('ready');
    });
    expect(init).toHaveBeenCalledTimes(1);
    expect(setOption).toHaveBeenCalledOnce();
  });
});
