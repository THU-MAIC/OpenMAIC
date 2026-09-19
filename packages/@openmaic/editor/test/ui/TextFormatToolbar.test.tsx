// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextFormatState } from '../../src/react/text/types';
import { stepTextToolbarFontSize, TextFormatToolbar } from '../../src/ui';

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

  it('clamps imported 0px on commit and step while preserving its display on Escape', () => {
    const { onCommand } = renderToolbar({ format: { ...format, fontsize: '0px' } });
    const fontSize = screen.getByRole('spinbutton', { name: '字号' });

    expect((fontSize as HTMLInputElement).value).toBe('0');
    fireEvent.change(fontSize, { target: { value: '44' } });
    fireEvent.keyDown(fontSize, { key: 'Escape' });
    expect((fontSize as HTMLInputElement).value).toBe('0');

    fireEvent.keyDown(fontSize, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith({ command: 'fontsize', value: '8px' });

    onCommand.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '减小字号' }));
    expect(onCommand).toHaveBeenCalledWith({ command: 'fontsize', value: '8px' });
  });

  it('steps font size through bounded explicit font-size commands', () => {
    const { onCommand } = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '减小字号' }));
    fireEvent.click(screen.getByRole('button', { name: '增大字号' }));

    expect(onCommand).toHaveBeenNthCalledWith(1, { command: 'fontsize', value: '18px' });
    expect(onCommand).toHaveBeenNthCalledWith(2, { command: 'fontsize', value: '22px' });
  });

  it('uses the legacy control order and visual structure', () => {
    const { container } = renderToolbar({
      onBringToFront: vi.fn(),
      onSendToBack: vi.fn(),
      onDelete: vi.fn(),
    });
    const toolbar = screen.getByRole('toolbar');

    expect(toolbar.classList).toContain('maic-editing-ui-text-toolbar');
    expect(container.querySelector('.maic-editing-ui-font-size-stepper')).not.toBeNull();
    expect(container.querySelectorAll('.maic-editing-ui-divider')).toHaveLength(4);
    expect(
      Array.from(toolbar.querySelectorAll('button')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual([
      '减小字号',
      '增大字号',
      '粗体',
      '斜体',
      '下划线',
      '文字颜色',
      '左对齐',
      '居中对齐',
      '右对齐',
      '无序列表',
      '置于顶层',
      '置于底层',
      '删除',
    ]);
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
    ['20px', 2, '22px'],
    ['0px', -2, '8px'],
    ['8px', -2, '8px'],
    ['96px', 2, '96px'],
    ['invalid', 2, '18px'],
  ])('clamps font size %s by %i to %s', (current, delta, expected) => {
    expect(stepTextToolbarFontSize(current, delta)).toBe(expected);
  });
});
