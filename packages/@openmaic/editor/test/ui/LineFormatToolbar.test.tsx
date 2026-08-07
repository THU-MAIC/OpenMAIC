// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTLineElement } from '@openmaic/dsl';
import { LineFormatToolbar } from '../../src/ui/line/LineFormatToolbar';

const line: PPTLineElement = {
  id: 'line-1',
  type: 'line',
  left: 100,
  top: 80,
  width: 2,
  start: [0, 0],
  end: [120, 80],
  style: 'solid',
  color: '#333333',
  points: ['', 'arrow'],
};

afterEach(cleanup);

function renderToolbar(element: PPTLineElement = line) {
  const onChange = vi.fn();
  render(<LineFormatToolbar element={element} locale="zh-CN" onChange={onChange} />);
  return { onChange };
}

describe('LineFormatToolbar', () => {
  it('dispatches each discrete line formatting change as one element update', () => {
    const { onChange } = renderToolbar();

    fireEvent.change(screen.getByRole('combobox', { name: '线条类型' }), {
      target: { value: 'curve' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '线宽' }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('combobox', { name: '线条样式' }), {
      target: { value: 'dashed' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '起点样式' }), {
      target: { value: 'dot' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '终点样式' }), {
      target: { value: '' },
    });

    expect(onChange).toHaveBeenNthCalledWith(1, [
      {
        type: 'element.update',
        id: 'line-1',
        props: { broken: undefined, broken2: undefined, curve: [60, 40], cubic: undefined },
      },
    ]);
    expect(onChange).toHaveBeenNthCalledWith(2, [
      { type: 'element.update', id: 'line-1', props: { width: 6 } },
    ]);
    expect(onChange).toHaveBeenNthCalledWith(3, [
      { type: 'element.update', id: 'line-1', props: { style: 'dashed' } },
    ]);
    expect(onChange).toHaveBeenNthCalledWith(4, [
      { type: 'element.update', id: 'line-1', props: { points: ['dot', 'arrow'] } },
    ]);
    expect(onChange).toHaveBeenNthCalledWith(5, [
      { type: 'element.update', id: 'line-1', props: { points: ['', ''] } },
    ]);
  });

  it('commits a swatch color as one element update', () => {
    const { onChange } = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '线条颜色' }));
    fireEvent.click(screen.getByRole('button', { name: '#ef4444' }));

    expect(onChange).toHaveBeenCalledWith([
      { type: 'element.update', id: 'line-1', props: { color: '#ef4444' } },
    ]);
  });
});
