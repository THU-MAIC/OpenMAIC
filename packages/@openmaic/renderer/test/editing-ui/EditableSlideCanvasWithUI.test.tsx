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
          .filter(
            (element) =>
              element.type === 'text' ||
              element.type === 'table' ||
              element.type === 'line' ||
              element.type === 'latex',
          )
          .map((element) =>
            React.createElement(
              'div',
              { id: `${prefix}${element.id}`, key: element.id },
              React.createElement(
                element.type === 'text' ? 'button' : 'div',
                {
                  className:
                    element.type === 'text'
                      ? 'base-element-text'
                      : element.type === 'table'
                        ? 'base-element-table'
                        : element.type === 'line'
                          ? 'base-element-line'
                          : 'base-element-latex',
                  onClick:
                    element.type === 'text'
                      ? () =>
                          props.onSelectionChange?.({
                            elementIds: [element.id],
                            primaryId: element.id,
                            editingId: element.id,
                          })
                      : undefined,
                  type: element.type === 'text' ? 'button' : undefined,
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
  elements: [
    textElement,
    { ...textElement, id: 'text-2', content: '<p>Second</p>' },
    {
      id: 'line-1',
      type: 'line',
      left: 40,
      top: 160,
      width: 2,
      start: [0, 0],
      end: [120, 80],
      style: 'solid',
      color: '#333333',
      points: ['', ''],
    },
    {
      id: 'table-1',
      type: 'table',
      left: 40,
      top: 260,
      width: 240,
      height: 80,
      rotate: 0,
      colWidths: [1],
      cellMinHeight: 80,
      outline: { width: 1, color: '#333333', style: 'solid' },
      data: [[{ id: 'cell-1', colspan: 1, rowspan: 1, text: 'Cell' }]],
    },
  ],
} as unknown as Slide;

const latexElement = {
  id: 'formula-1',
  type: 'latex',
  left: 100,
  top: 100,
  width: 180,
  height: 60,
  rotate: 0,
  latex: 'x^2',
  html: '<span class="katex">x<sup>2</sup></span>',
  color: '#2563eb',
  align: 'center',
} as const;

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
    if (this.classList.contains('base-element-table')) return rect(100, 260, 240, 80);
    if (this.classList.contains('base-element-line')) return rect(100, 200, 120, 80);
    if (this.classList.contains('base-element-latex')) return rect(100, 100, 180, 60);
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

  it('renders a configured renderer insert toolbar and forwards its action', () => {
    const onInsert = vi.fn();
    const { getByRole } = renderControlled({
      insertToolbar: {
        label: 'Insert',
        items: [
          {
            id: 'insert-text',
            label: 'Text box',
            icon: <span>T</span>,
            onInvoke: onInsert,
          },
        ],
      },
    });

    fireEvent.click(getByRole('button', { name: 'Text box' }));

    expect(getByRole('toolbar', { name: 'Insert' })).not.toBeNull();
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('opens the shared dialog from the Formula insert icon', () => {
    const onInsert = vi.fn();

    renderControlled({
      insertToolbar: { label: 'Insert', items: [] },
      latexEditor: { onInsert, onUpdate: vi.fn() },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert formula' }));

    expect(screen.getByRole('dialog', { name: 'Formula editor' })).not.toBeNull();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('opens the shared dialog prefilled for a selected Latex element', async () => {
    const onUpdate = vi.fn();

    renderControlled({
      slide: { ...slide, elements: [latexElement] } as unknown as Slide,
      initialSelection: { elementIds: ['formula-1'], primaryId: 'formula-1' },
      latexEditor: { onInsert: vi.fn(), onUpdate },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit formula' }));
    expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe('x^2');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onUpdate).toHaveBeenCalledWith(
      'formula-1',
      expect.objectContaining({ latex: 'x^2', html: expect.stringContaining('katex') }),
    );
  });

  it('groups selected Latex actions into one renderer toolbar', () => {
    const onBringToFront = vi.fn();
    const onSendToBack = vi.fn();
    const onDelete = vi.fn();

    renderControlled({
      slide: { ...slide, elements: [latexElement] } as unknown as Slide,
      initialSelection: { elementIds: ['formula-1'], primaryId: 'formula-1' },
      latexEditor: {
        onInsert: vi.fn(),
        onUpdate: vi.fn(),
        onBringToFront,
        onSendToBack,
        onDelete,
      },
    });

    expect(screen.getByRole('toolbar', { name: 'Formula toolbar' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Edit formula' }).getAttribute('data-tooltip')).toBe(
      'Edit formula',
    );
    expect(screen.getByRole('button', { name: 'Bring to front' }).getAttribute('data-tooltip')).toBe(
      'Bring to front',
    );
    expect(screen.getByRole('button', { name: 'Send to back' }).getAttribute('data-tooltip')).toBe(
      'Send to back',
    );
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('data-tooltip')).toBe(
      'Delete',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bring to front' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onBringToFront).toHaveBeenCalledWith('formula-1');
    expect(onSendToBack).toHaveBeenCalledWith('formula-1');
    expect(onDelete).toHaveBeenCalledWith('formula-1');
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

  it('shows the line toolbar for a single selected line and forwards its update intent', async () => {
    const onElementsChange = vi.fn();
    renderControlled({
      initialSelection: { elementIds: ['line-1'], primaryId: 'line-1' },
      onElementsChange,
      lineToolbar: { locale: 'zh-CN' },
    });

    expect(await screen.findByRole('toolbar', { name: '线条工具栏' })).not.toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: '线宽' }), { target: { value: '6' } });
    expect(onElementsChange).toHaveBeenCalledWith([
      { type: 'element.update', id: 'line-1', props: { width: 6 } },
    ]);
  });

  it('hides the line toolbar for a multi-selection or locked line', () => {
    const onElementsChange = vi.fn();
    const view = renderControlled({
      initialSelection: { elementIds: ['line-1', 'text-1'], primaryId: 'line-1' },
      onElementsChange,
      lineToolbar: { locale: 'zh-CN' },
    });
    expect(screen.queryByRole('toolbar', { name: '线条工具栏' })).toBeNull();

    view.rerender(
      <EditableSlideCanvasWithUI
        slide={{
          ...slide,
          elements: slide.elements.map((element) =>
            element.id === 'line-1' ? { ...element, lock: true } : element,
          ),
        }}
        scale={1}
        selection={{ elementIds: ['line-1'], primaryId: 'line-1' }}
        onElementsChange={onElementsChange}
        lineToolbar={{ locale: 'zh-CN' }}
      />,
    );
    expect(screen.queryByRole('toolbar', { name: '线条工具栏' })).toBeNull();
  });

  it('routes line z-order and deletion through renderer intents', async () => {
    const onElementsChange = vi.fn();
    const onSelectionChange = vi.fn();
    renderControlled({
      initialSelection: { elementIds: ['line-1'], primaryId: 'line-1' },
      onElementsChange,
      onSelectionChange,
      lineToolbar: { locale: 'zh-CN' },
    });

    await screen.findByRole('toolbar', { name: '线条工具栏' });
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    expect(onElementsChange).toHaveBeenLastCalledWith([
      { type: 'element.reorder', id: 'line-1', command: 'front' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onElementsChange).toHaveBeenLastCalledWith([
      { type: 'element.delete', ids: ['line-1'] },
    ]);
    expect(onSelectionChange).toHaveBeenLastCalledWith({ elementIds: [] });
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

  it('reuses the text toolbar for a table-cell controller without element actions', async () => {
    canvasMock.autoRegister = false;
    renderControlled({
      initialSelection: { elementIds: ['table-1'], primaryId: 'table-1', editingId: 'table-1' },
      onElementsChange: vi.fn(),
    });
    const controller = { ...createController('table-1'), kind: 'table-cell' as const };

    emitController(controller);
    emitFormat('table-1');

    expect(await screen.findByRole('toolbar', { name: '文本格式' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '置于顶层' })).toBeNull();
    expect(screen.queryByRole('button', { name: '置于底层' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: '字体' }), {
      target: { value: 'Inter' },
    });
    expect(canvasMock.executions).toEqual([
      { elementId: 'table-1', command: { command: 'fontname', value: 'Inter' } },
    ]);
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
