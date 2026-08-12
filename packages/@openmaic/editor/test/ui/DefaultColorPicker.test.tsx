// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextFormatState } from '../../src/react/text/types';
import {
  DefaultColorPicker,
  TextFormatToolbar,
  normalizeToolbarColor,
  resolveTextToolbarLabels,
} from '../../src/ui';

const labels = resolveTextToolbarLabels('zh-CN');
const format: TextFormatState = {
  bold: false,
  em: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  code: false,
  color: '#112233',
  backcolor: '',
  fontsize: '20px',
  fontname: 'Arial',
  link: '',
  align: 'left',
  bulletList: false,
  orderedList: false,
  blockquote: false,
};

afterEach(cleanup);

describe('normalizeToolbarColor', () => {
  it('normalizes only three- and six-digit hexadecimal colors', () => {
    expect(normalizeToolbarColor('#ABC')).toBe('#aabbcc');
    expect(normalizeToolbarColor('#12abef')).toBe('#12abef');
    expect(normalizeToolbarColor('red')).toBeNull();
  });
});

describe('DefaultColorPicker', () => {
  it('matches the legacy editor picker controls and common-color palette', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <DefaultColorPicker
        value="#112233"
        labels={labels}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );

    expect(container.querySelector('.react-colorful')).not.toBeNull();
    expect(container.querySelector('.react-colorful__saturation')).not.toBeNull();
    expect(container.querySelector('.react-colorful__hue')).not.toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(10);
    expect(screen.getByRole('button', { name: '#525252' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '#8b5cf6' })).not.toBeNull();
  });

  it('commits legacy common-color swatches immediately', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <DefaultColorPicker
        value="#112233"
        labels={labels}
        onChange={onChange}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '#ef4444' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith('#ef4444');
  });

  it('synchronizes the displayed hex value from controlled color changes', () => {
    const { rerender } = render(
      <DefaultColorPicker value="#112233" labels={labels} onChange={vi.fn()} onCommit={vi.fn()} />,
    );

    expect(screen.getByText('#112233')).not.toBeNull();
    rerender(
      <DefaultColorPicker value="#abcdef" labels={labels} onChange={vi.fn()} onCommit={vi.fn()} />,
    );
    expect(screen.getByText('#abcdef')).not.toBeNull();
  });

  it('passes the current value and callbacks to a custom toolbar renderer', () => {
    const onCommand = vi.fn();
    const renderColorPicker = vi.fn(({ value, onChange, onCommit }) => (
      <button type="button" onClick={() => onCommit('#abcdef')}>
        {value}
        <span onClick={() => onChange('#fedcba')}>change</span>
      </button>
    ));
    render(
      <TextFormatToolbar
        elementId="text-1"
        format={format}
        locale="zh-CN"
        onCommand={onCommand}
        renderColorPicker={renderColorPicker}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '文字颜色' }));
    expect(renderColorPicker).toHaveBeenCalledWith(
      expect.objectContaining({
        value: '#112233',
        onChange: expect.any(Function),
        onCommit: expect.any(Function),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '#112233change' }));
    expect(onCommand).toHaveBeenLastCalledWith({ command: 'forecolor', value: '#abcdef' });
    expect(screen.queryByRole('button', { name: '#112233' })).toBeNull();
  });
});

describe('TextFormatToolbar color popover', () => {
  it('renders the color picker outside the scrollable toolbar', () => {
    render(
      <TextFormatToolbar elementId="text-1" format={format} locale="zh-CN" onCommand={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '文字颜色' }));

    const toolbar = screen.getByRole('toolbar');
    const popover = screen.getByRole('dialog', { name: '文字颜色' });
    expect(toolbar.contains(popover)).toBe(false);
    expect(popover.parentElement).toBe(document.body);
  });

  it('commits a swatch once and closes the popover', () => {
    const onCommand = vi.fn();

    function ControlledToolbar() {
      const [controlledFormat, setControlledFormat] = useState(format);
      return (
        <TextFormatToolbar
          elementId="text-1"
          format={controlledFormat}
          locale="en-US"
          onCommand={(command) => {
            onCommand(command);
            if (command.command === 'forecolor') {
              setControlledFormat((current) => ({
                ...current,
                color: command.value ?? current.color,
              }));
            }
          }}
        />
      );
    }

    render(<ControlledToolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Text color' }));
    const swatch = screen.getByRole('button', { name: '#ef4444' });

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    swatch.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.click(swatch);

    expect(onCommand).toHaveBeenNthCalledWith(1, { command: 'forecolor', value: '#ef4444' });
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Text color' })).toBeNull();
  });

  it('prevents selection loss, dispatches preview changes, and closes on outside pointer events', () => {
    const onCommand = vi.fn();
    render(
      <TextFormatToolbar elementId="text-1" format={format} locale="zh-CN" onCommand={onCommand} />,
    );

    const button = screen.getByRole('button', { name: '文字颜色' });
    const pointerDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);

    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: labels.color })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '#3b82f6' }));
    expect(onCommand).toHaveBeenNthCalledWith(1, { command: 'forecolor', value: '#3b82f6' });
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: labels.color })).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: labels.color })).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: labels.color })).toBeNull();
  });
});
