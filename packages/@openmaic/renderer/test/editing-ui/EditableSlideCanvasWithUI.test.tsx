// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { EditableSlideCanvasProps, Selection } from '../../src/editing/types';
import type {
  TextEditCommand,
  TextEditorController,
  TextFormatState,
} from '../../src/editing/text/types';

const canvasMock = vi.hoisted(() => ({
  autoRegister: true,
  autoFormat: true,
  executions: [] as Array<{ elementId: string; command: TextEditCommand }>,
  latestProps: null as EditableSlideCanvasProps | null,
  format: {
    bold: false,
    em: false,
    underline: false,
    strikethrough: false,
    superscript: false,
    subscript: false,
    code: false,
    color: '#111111',
    backcolor: '',
    fontsize: '20px',
    fontname: 'Arial',
    link: '',
    align: 'left',
    bulletList: false,
    orderedList: false,
    blockquote: false,
  } satisfies TextFormatState,
}));

vi.mock('../../src/editing/EditableSlideCanvas', async () => {
  const React = await import('react');

  return {
    EditableSlideCanvas(props: EditableSlideCanvasProps) {
      canvasMock.latestProps = props;
      const editingId = props.selection?.editingId;

      React.useEffect(() => {
        if (!editingId || !canvasMock.autoRegister) return;

        const controller = createController(editingId, props.onTextContentChange);
        props.onTextEditorChange?.(controller);
        if (canvasMock.autoFormat) {
          props.onTextFormatChange?.(editingId, canvasMock.format);
        }
        return () => props.onTextEditorChange?.(null);
      }, [editingId]);

      const prefix = props.elementIdPrefix ?? 'slide-element-';
      return React.createElement(
        'div',
        { 'data-testid': 'editable-slide-canvas' },
        props.slide.elements
          .filter((element) => element.type === 'text')
          .map((element) =>
            React.createElement(
              'div',
              { id: `${prefix}${element.id}`, key: element.id },
              React.createElement(
                'button',
                {
                  className: 'base-element-text',
                  onClick: () =>
                    props.onSelectionChange?.({
                      elementIds: [element.id],
                      primaryId: element.id,
                      editingId: element.id,
                    }),
                  type: 'button',
                },
                element.id === 'text-1' ? 'Hello' : 'Second',
              ),
            ),
          ),
      );
    },
  };
});

import { EDITING_UI_STYLES, EditableSlideCanvasWithUI } from '../../src/editing-ui';

const textElement = {
  id: 'text-1',
  type: 'text',
  left: 20,
  top: 30,
  width: 240,
  height: 80,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
  lineHeight: 1.4,
} as const;

const slide = {
  id: 'slide-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [textElement, { ...textElement, id: 'text-2', content: '<p>Second</p>' }],
} as unknown as Slide;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function createController(
  elementId: string,
  onTextContentChange?: EditableSlideCanvasProps['onTextContentChange'],
): TextEditorController {
  return {
    elementId,
    execute(command) {
      const commands = Array.isArray(command) ? command : [command];
      for (const item of commands) canvasMock.executions.push({ elementId, command: item });
      onTextContentChange?.({
        intent: {
          type: 'text.updateContent',
          id: elementId,
          content: `<p><strong>${elementId}</strong></p>`,
          target: 'text',
        },
        history: 'record',
      });
    },
    discard: vi.fn(),
    flush: vi.fn(),
    focus: vi.fn(),
    getHTML: () => `<p>${elementId}</p>`,
  };
}

interface ControlledHarnessProps extends Omit<
  ComponentProps<typeof EditableSlideCanvasWithUI>,
  'selection'
> {
  readonly initialSelection?: Selection;
}

function ControlledHarness({
  initialSelection = { elementIds: [] },
  onSelectionChange,
  ...props
}: ControlledHarnessProps) {
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const updateSelection = useCallback(
    (next: Selection) => {
      setSelection(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  return (
    <EditableSlideCanvasWithUI
      {...props}
      selection={selection}
      onSelectionChange={updateSelection}
    />
  );
}

function renderControlled(overrides: Partial<ControlledHarnessProps> = {}) {
  const onTextContentChange = vi.fn();
  const view = render(
    <ControlledHarness
      slide={slide}
      scale={1}
      textToolbar={{ locale: 'zh-CN', labels: { toolbar: '文本格式' } }}
      onTextContentChange={onTextContentChange}
      {...overrides}
    />,
  );
  return { ...view, onTextContentChange };
}

function emitController(controller: TextEditorController | null) {
  act(() => canvasMock.latestProps?.onTextEditorChange?.(controller));
}

function emitFormat(elementId: string, format: TextFormatState = canvasMock.format) {
  act(() => canvasMock.latestProps?.onTextFormatChange?.(elementId, format));
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-toolbar-overlay')) return rect(0, 0, 640, 48);
    if (this.classList.contains('base-element-text')) return rect(100, 100, 240, 80);
    return new DOMRect();
  });
});

afterEach(() => {
  cleanup();
  canvasMock.autoRegister = true;
  canvasMock.autoFormat = true;
  canvasMock.executions.length = 0;
  canvasMock.latestProps = null;
  vi.restoreAllMocks();
});

describe('EditableSlideCanvasWithUI', () => {
  it('composes controlled text editing and forwards toolbar commands', async () => {
    const onSelectionChange = vi.fn();
    const { onTextContentChange } = renderControlled({ onSelectionChange });

    fireEvent.click(screen.getByText('Hello'));
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      elementIds: ['text-1'],
      primaryId: 'text-1',
      editingId: 'text-1',
    });
    const toolbar = await screen.findByRole('toolbar', { name: '文本格式' });
    expect((toolbar.parentElement as HTMLElement).style.visibility).toBe('visible');

    fireEvent.click(screen.getByRole('button', { name: '粗体' }));
    expect(onTextContentChange).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ type: 'text.updateContent', id: 'text-1' }),
      }),
    );
  });

  it('waits for controller and format state matching the controlled editing id', () => {
    canvasMock.autoRegister = false;
    renderControlled({
      initialSelection: { elementIds: ['text-1'], editingId: 'text-1' },
    });

    emitController(createController('text-1'));
    expect(screen.queryByRole('toolbar')).toBeNull();

    emitFormat('text-2');
    expect(screen.queryByRole('toolbar')).toBeNull();

    emitFormat('text-1');
    expect(screen.getByRole('toolbar', { name: '文本格式' })).not.toBeNull();
  });

  it('rejects stale controller and format updates before dispatching commands', () => {
    canvasMock.autoRegister = false;
    renderControlled({
      initialSelection: { elementIds: ['text-2'], editingId: 'text-2' },
    });

    emitFormat('text-2');
    emitController(createController('text-1'));
    expect(screen.queryByRole('toolbar')).toBeNull();

    emitController(createController('text-2'));
    expect(screen.getByRole('toolbar')).not.toBeNull();

    emitFormat('text-1');
    emitController(createController('text-1'));
    fireEvent.click(screen.getByRole('button', { name: '粗体' }));
    expect(canvasMock.executions).toEqual([{ elementId: 'text-2', command: { command: 'bold' } }]);
  });

  it('clears lifecycle state across controlled selection changes and unregisters', () => {
    canvasMock.autoRegister = false;
    const props = {
      slide,
      scale: 1,
      onTextContentChange: vi.fn(),
    };
    const view = render(
      <EditableSlideCanvasWithUI
        {...props}
        selection={{ elementIds: ['text-1'], editingId: 'text-1' }}
      />,
    );

    emitController(createController('text-1'));
    emitFormat('text-1');
    expect(screen.getByRole('toolbar')).not.toBeNull();

    view.rerender(
      <EditableSlideCanvasWithUI
        {...props}
        selection={{ elementIds: ['text-2'], editingId: 'text-2' }}
      />,
    );
    view.rerender(
      <EditableSlideCanvasWithUI
        {...props}
        selection={{ elementIds: ['text-1'], editingId: 'text-1' }}
      />,
    );
    expect(screen.queryByRole('toolbar')).toBeNull();

    emitController(createController('text-1'));
    emitFormat('text-1');
    emitController(null);
    expect(screen.queryByRole('toolbar')).toBeNull();

    emitController(createController('text-1'));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('ignores a stale controller unregister from the previous editing id', () => {
    canvasMock.autoRegister = false;
    const props = {
      slide,
      scale: 1,
      onTextContentChange: vi.fn(),
    };
    const view = render(
      <EditableSlideCanvasWithUI
        {...props}
        selection={{ elementIds: ['text-1'], editingId: 'text-1' }}
      />,
    );
    const unregisterTextOne = canvasMock.latestProps?.onTextEditorChange;

    view.rerender(
      <EditableSlideCanvasWithUI
        {...props}
        selection={{ elementIds: ['text-2'], editingId: 'text-2' }}
      />,
    );
    emitController(createController('text-2'));
    emitFormat('text-2');
    expect(screen.getByRole('toolbar')).not.toBeNull();

    act(() => unregisterTextOne?.(null));
    expect(screen.getByRole('toolbar')).not.toBeNull();
  });

  it('forwards intercepted lifecycle callbacks without committing toolbar-only content', async () => {
    const onTextEditorChange = vi.fn();
    const onTextFormatChange = vi.fn();
    const { onTextContentChange, unmount } = renderControlled({
      initialSelection: { elementIds: ['text-1'], editingId: 'text-1' },
      onTextEditorChange,
      onTextFormatChange,
    });

    expect(await screen.findByRole('toolbar')).not.toBeNull();
    expect(onTextEditorChange).toHaveBeenCalledWith(
      expect.objectContaining({ elementId: 'text-1' }),
    );
    expect(onTextFormatChange).toHaveBeenCalledWith('text-1', canvasMock.format);
    expect(onTextContentChange).not.toHaveBeenCalled();

    unmount();
    expect(onTextEditorChange).toHaveBeenLastCalledWith(null);
  });

  it('disables the toolbar UI without disabling the editable canvas', async () => {
    renderControlled({
      initialSelection: { elementIds: ['text-1'], editingId: 'text-1' },
      textToolbar: false,
    });

    await waitFor(() => expect(canvasMock.latestProps?.onTextEditorChange).toBeTypeOf('function'));
    expect(screen.getByTestId('editable-slide-canvas')).not.toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('emits exact reorder and delete intents before clearing selection', async () => {
    const onElementsChange = vi.fn();
    const onSelectionChange = vi.fn();
    renderControlled({
      initialSelection: { elementIds: ['text-1'], editingId: 'text-1' },
      onElementsChange,
      onSelectionChange,
    });

    expect(await screen.findByRole('toolbar')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    expect(onElementsChange).toHaveBeenLastCalledWith([
      { type: 'element.reorder', id: 'text-1', command: 'front' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: '置于底层' }));
    expect(onElementsChange).toHaveBeenLastCalledWith([
      { type: 'element.reorder', id: 'text-1', command: 'back' },
    ]);

    onElementsChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onElementsChange).toHaveBeenCalledWith([{ type: 'element.delete', ids: ['text-1'] }]);
    expect(onSelectionChange).toHaveBeenLastCalledWith({ elementIds: [] });
    expect(onElementsChange.mock.invocationCallOrder[0]).toBeLessThan(
      onSelectionChange.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });

  it('hides all element actions when no element mutation callback is available', async () => {
    renderControlled({
      initialSelection: { elementIds: ['text-1'], editingId: 'text-1' },
    });

    expect(await screen.findByRole('toolbar')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '置于顶层' })).toBeNull();
    expect(screen.queryByRole('button', { name: '置于底层' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('mounts the editing UI styles exactly once across rerenders', () => {
    const { container, rerender } = render(
      <EditableSlideCanvasWithUI slide={slide} scale={1} onTextContentChange={vi.fn()} />,
    );

    expect(
      Array.from(container.querySelectorAll('style')).filter(
        (style) => style.textContent === EDITING_UI_STYLES,
      ),
    ).toHaveLength(1);

    rerender(
      <EditableSlideCanvasWithUI
        slide={slide}
        scale={1}
        textToolbar={{ locale: 'en-US' }}
        onTextContentChange={vi.fn()}
      />,
    );
    expect(
      Array.from(container.querySelectorAll('style')).filter(
        (style) => style.textContent === EDITING_UI_STYLES,
      ),
    ).toHaveLength(1);
  });
});
