// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextFormatState } from '../../src/editing/text/types';
import { stepTextToolbarFontSize, TextFormatToolbar } from '../../src/editing-ui';

const format: TextFormatState = {
  bold: true,
  em: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  code: false,
  color: '#112233',
  backcolor: '',
  fontsize: '20px',
  fontname: 'Microsoft YaHei',
  link: '',
  align: 'left',
  bulletList: false,
  orderedList: false,
  blockquote: false,
};

afterEach(cleanup);

function renderToolbar(overrides: Partial<ComponentProps<typeof TextFormatToolbar>> = {}) {
  const onCommand = vi.fn();
  const view = render(
    <TextFormatToolbar
      elementId="text-1"
      format={format}
      locale="zh-CN"
      onCommand={onCommand}
      {...overrides}
    />,
  );

  return { ...view, onCommand };
}

describe('TextFormatToolbar', () => {
  it('renders active formatting and dispatches text commands without stealing focus', () => {
    const { onCommand } = renderToolbar();

    expect(screen.getByRole('button', { name: '粗体' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '居中对齐' }));
    expect(onCommand).toHaveBeenCalledWith({ command: 'align', value: 'center' });
    fireEvent.click(screen.getByRole('button', { name: '无序列表' }));
    expect(onCommand).toHaveBeenCalledWith({ command: 'bulletList' });

    const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByRole('button', { name: '粗体' }).dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);
  });

  it('selects fonts and keeps an unknown current font selectable', () => {
    const { onCommand } = renderToolbar({
      format: { ...format, fontname: 'Futura' },
      fonts: [{ label: 'Arial', value: 'Arial' }],
    });

    const font = screen.getByRole('combobox', { name: '字体' });
    expect((font as HTMLSelectElement).value).toBe('Futura');
    expect((screen.getByRole('option', { name: 'Futura' }) as HTMLOptionElement).value).toBe(
      'Futura',
    );
    fireEvent.change(font, { target: { value: 'Arial' } });
    expect(onCommand).toHaveBeenCalledWith({ command: 'fontname', value: 'Arial' });
  });

  it('commits direct font size changes and restores the controlled value on Escape', () => {
    const { onCommand } = renderToolbar();
    const fontSize = screen.getByRole('spinbutton', { name: '字号' });

    fireEvent.change(fontSize, { target: { value: '27abc' } });
    expect((fontSize as HTMLInputElement).value).toBe('27');
    fireEvent.keyDown(fontSize, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith({ command: 'fontsize', value: '27px' });

    fireEvent.change(fontSize, { target: { value: '44' } });
    fireEvent.keyDown(fontSize, { key: 'Escape' });
    expect((fontSize as HTMLInputElement).value).toBe('20');
  });

  it.each([
    ['4px', '8px'],
    ['100px', '96px'],
  ])('corrects an out-of-range current font size on direct commit', (current, expected) => {
    const { onCommand } = renderToolbar({ format: { ...format, fontsize: current } });

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '字号' }), { key: 'Enter' });

    expect(onCommand).toHaveBeenCalledWith({ command: 'fontsize', value: expected });
  });

  it('steps font size through bounded explicit font-size commands', () => {
    const { onCommand } = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '减小字号' }));
    fireEvent.click(screen.getByRole('button', { name: '增大字号' }));

    expect(onCommand).toHaveBeenNthCalledWith(1, { command: 'fontsize', value: '19px' });
    expect(onCommand).toHaveBeenNthCalledWith(2, { command: 'fontsize', value: '21px' });
  });

  it('renders optional element action buttons only when callbacks are supplied', () => {
    const onBringToFront = vi.fn();
    const { rerender } = renderToolbar({ onBringToFront });

    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    expect(onBringToFront).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '置于底层' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();

    rerender(
      <TextFormatToolbar
        elementId="text-1"
        format={format}
        locale="zh-CN"
        onCommand={vi.fn()}
        onSendToBack={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '置于底层' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '删除' })).not.toBeNull();
  });

  it.each([
    ['20px', 1, '21px'],
    ['8px', -1, '8px'],
    ['96px', 1, '96px'],
    ['invalid', 1, '17px'],
  ])('clamps font size %s by %i to %s', (current, delta, expected) => {
    expect(stepTextToolbarFontSize(current, delta)).toBe(expected);
  });
});
