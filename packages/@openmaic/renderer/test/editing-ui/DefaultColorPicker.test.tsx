// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextFormatState } from '../../src/editing/text/types';
import {
  DefaultColorPicker,
  TextFormatToolbar,
  normalizeToolbarColor,
  resolveTextToolbarLabels,
} from '../../src/editing-ui';

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
  it('commits a valid hex draft on Enter', () => {
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

    const input = screen.getByRole('textbox', { name: labels.colorHex });
    fireEvent.change(input, { target: { value: '#ff0000' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith('#ff0000');
  });

  it('previews and commits a native color change once when followed by blur', () => {
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

    const input = container.querySelector<HTMLInputElement>('input[type="color"]');
    if (!input) throw new Error('Native color input not found');
    fireEvent.change(input, { target: { value: '#ff0000' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith('#ff0000');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('#ff0000');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('does not call either callback for invalid hex input', () => {
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

    const input = screen.getByRole('textbox', { name: labels.colorHex });
    fireEvent.change(input, { target: { value: 'red' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('restores the normalized opening color after a controlled preview update on Escape', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const englishLabels = resolveTextToolbarLabels('en-US');

    function ControlledPicker() {
      const [value, setValue] = useState('#ABC');
      return (
        <DefaultColorPicker
          value={value}
          labels={englishLabels}
          onChange={(color) => {
            onChange(color);
            setValue(color);
          }}
          onCommit={onCommit}
        />
      );
    }

    render(<ControlledPicker />);

    const input = screen.getByRole('textbox', { name: 'Color hex' });
    fireEvent.change(input, { target: { value: '#ff0000' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect((input as HTMLInputElement).value).toBe('#aabbcc');
    expect(onChange).toHaveBeenLastCalledWith('#aabbcc');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits swatches immediately and restores the incoming value on Escape', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Red' }));
    expect(onChange).toHaveBeenCalledWith('#ef4444');
    expect(onCommit).toHaveBeenCalledWith('#ef4444');

    const input = screen.getByRole('textbox', { name: labels.colorHex });
    fireEvent.change(input, { target: { value: '#00ff00' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('#112233');
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
  it('commits a swatch after the focused hex input receives its mouse down, blur, and click events', () => {
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
    const input = screen.getByRole('textbox', { name: 'Color hex' });
    const swatch = screen.getByRole('button', { name: 'Red' });
    input.focus();
    expect(document.activeElement).toBe(input);

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    swatch.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.blur(input);
    fireEvent.click(swatch);

    expect(onCommand).toHaveBeenNthCalledWith(1, { command: 'forecolor', value: '#ef4444' });
    expect(onCommand).toHaveBeenNthCalledWith(2, { command: 'forecolor', value: '#ef4444' });
    expect(screen.queryByRole('textbox', { name: 'Color hex' })).toBeNull();
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
    expect(screen.getByRole('textbox', { name: labels.colorHex })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    expect(onCommand).toHaveBeenNthCalledWith(1, { command: 'forecolor', value: '#3b82f6' });
    expect(onCommand).toHaveBeenNthCalledWith(2, { command: 'forecolor', value: '#3b82f6' });
    expect(screen.queryByRole('textbox', { name: labels.colorHex })).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole('textbox', { name: labels.colorHex })).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('textbox', { name: labels.colorHex })).toBeNull();
  });
});
