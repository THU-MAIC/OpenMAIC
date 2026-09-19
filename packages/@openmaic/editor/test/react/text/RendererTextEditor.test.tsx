// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RendererTextEditor } from '../../../src/react/text/RendererTextEditor';
import type {
  TextContentChange,
  TextEditorController,
  TextFormatState,
} from '../../../src/react/text/types';

describe('RendererTextEditor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('publishes a controller, format state, then content before requesting layout', () => {
    let controller: TextEditorController | null = null;
    const onControllerChange = vi.fn((next: TextEditorController | null) => {
      controller = next;
    });
    const onFormatChange = vi.fn<(id: string, state: TextFormatState) => void>();
    const onContentChange = vi.fn<(change: TextContentChange) => void>();
    const onLayoutChange = vi.fn();

    render(
      <RendererTextEditor
        elementId="txt"
        value="<p>Hello</p>"
        defaultColor="#112233"
        defaultFontName="Inter"
        onControllerChange={onControllerChange}
        onFormatChange={onFormatChange}
        onContentChange={onContentChange}
        onLayoutChange={onLayoutChange}
      />,
    );

    expect(controller).not.toBeNull();
    expect(onFormatChange).toHaveBeenCalledWith(
      'txt',
      expect.objectContaining({ color: '#112233', fontname: 'Inter' }),
    );

    act(() => controller?.execute({ command: 'replace', value: 'Edited' }));
    expect(onLayoutChange).not.toHaveBeenCalled();
    expect(onContentChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));

    expect(onContentChange).toHaveBeenLastCalledWith({
      intent: {
        type: 'text.updateContent',
        id: 'txt',
        content: expect.stringContaining('Edited'),
        target: 'text',
      },
      history: 'record',
    });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus from a toolbar input when executing a command', () => {
    let controller: TextEditorController | null = null;
    render(
      <RendererTextEditor
        elementId="txt"
        value="<p>Hello</p>"
        defaultColor="#000000"
        defaultFontName="Inter"
        onControllerChange={(next) => {
          controller = next;
        }}
      />,
    );
    const colorInput = document.createElement('input');
    document.body.append(colorInput);
    colorInput.focus();

    act(() => controller?.execute({ command: 'forecolor', value: '#ff0000' }));

    expect(document.activeElement).toBe(colorInput);
    colorInput.remove();
  });

  it('flushes pending content on blur and lets the Escape host decide how to exit', () => {
    let controller: TextEditorController | null = null;
    const onContentChange = vi.fn<(change: TextContentChange) => void>();
    const onEscape = vi.fn(() => controller?.flush());
    const { container } = render(
      <RendererTextEditor
        elementId="txt"
        value="<p>Hello</p>"
        defaultColor="#000000"
        defaultFontName="Inter"
        onControllerChange={(next) => {
          controller = next;
        }}
        onContentChange={onContentChange}
        onEscape={onEscape}
      />,
    );
    expect(controller).not.toBeNull();
    const editor = container.querySelector('.ProseMirror') as HTMLElement;

    act(() => controller?.execute({ command: 'replace', value: 'Blurred' }));
    fireEvent.blur(editor);
    expect(onContentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ content: expect.stringContaining('Blurred') }),
      }),
    );

    act(() => controller?.execute({ command: 'replace', value: 'Escaped' }));
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onContentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ content: expect.stringContaining('Escaped') }),
      }),
    );
  });

  it('does not commit normalized HTML when focus changes without an edit', () => {
    const onContentChange = vi.fn<(change: TextContentChange) => void>();
    const { container } = render(
      <RendererTextEditor
        elementId="txt"
        value='<p style="font-size: 14px">Hello</p>'
        defaultColor="#000000"
        defaultFontName="Inter"
        autoFocus
        onContentChange={onContentChange}
      />,
    );

    fireEvent.blur(container.querySelector('.ProseMirror') as HTMLElement);

    expect(onContentChange).not.toHaveBeenCalled();
  });

  it.each(['text', 'shape'] as const)(
    'keeps literal line breaks when saving a %s editor',
    (target) => {
      let controller: TextEditorController | null = null;
      const onContentChange = vi.fn<(change: TextContentChange) => void>();
      render(
        <RendererTextEditor
          elementId="txt"
          target={target}
          value={'First line\nSecond line'}
          defaultColor="#000000"
          defaultFontName="Inter"
          onControllerChange={(next) => {
            controller = next;
          }}
          onContentChange={onContentChange}
        />,
      );

      act(() => controller?.execute({ command: 'insert', value: '!' }));
      act(() => vi.advanceTimersByTime(300));

      expect(onContentChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({
            target,
            content: expect.stringContaining('First line<br>Second line'),
          }),
        }),
      );
    },
  );

  it('marks ProseMirror undo content as history-neutral and releases focus on unmount', () => {
    let controller: TextEditorController | null = null;
    const onControllerChange = vi.fn((next: TextEditorController | null) => {
      controller = next;
    });
    const onContentChange = vi.fn<(change: TextContentChange) => void>();
    const onFocusChange = vi.fn();
    const { container, unmount } = render(
      <RendererTextEditor
        elementId="txt"
        value="<p>Hello</p>"
        defaultColor="#000000"
        defaultFontName="Inter"
        onControllerChange={onControllerChange}
        onContentChange={onContentChange}
        onFocusChange={onFocusChange}
      />,
    );
    expect(controller).not.toBeNull();
    const editor = container.querySelector('.ProseMirror') as HTMLElement;

    act(() => controller?.execute({ command: 'replace', value: 'Changed' }));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    act(() => vi.advanceTimersByTime(300));

    expect(onContentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ history: 'navigate' }),
    );

    fireEvent.focus(editor);
    unmount();
    expect(onControllerChange).toHaveBeenLastCalledWith(null);
    expect(onFocusChange).toHaveBeenLastCalledWith(false);
  });

  it('adopts an external canonical value while focused without emitting stale content', () => {
    const onContentChange = vi.fn<(change: TextContentChange) => void>();
    const props = {
      elementId: 'txt',
      defaultColor: '#000000',
      defaultFontName: 'Inter',
      onContentChange,
    } as const;
    const { container, rerender } = render(<RendererTextEditor {...props} value="<p>Local</p>" />);
    const editor = container.querySelector('.ProseMirror') as HTMLElement;
    act(() => editor.focus());
    expect(document.activeElement).toBe(editor);

    rerender(<RendererTextEditor {...props} value="<p>External</p>" />);

    expect(editor.textContent).toBe('External');
    act(() => vi.advanceTimersByTime(300));
    expect(onContentChange).not.toHaveBeenCalled();
  });
});
