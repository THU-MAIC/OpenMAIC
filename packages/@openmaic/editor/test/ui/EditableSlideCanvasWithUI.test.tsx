// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { EditableSlideCanvasProps, Selection } from '../../src/react/types';
import type {
  TextEditCommand,
  TextEditorController,
  TextFormatState,
} from '../../src/react/text/types';

const canvasMock = vi.hoisted(() => ({
  latestProps: null as EditableSlideCanvasProps | null,
  activeController: null as { discard: ReturnType<typeof vi.fn> } | null,
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

function controller(
  elementId: string,
  onTextContentChange: EditableSlideCanvasProps['onTextContentChange'],
): TextEditorController {
  const next = {
    elementId,
    execute(_command: TextEditCommand | TextEditCommand[]) {
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
  canvasMock.activeController = next;
  return next;
}

vi.mock('../../src/react/EditableSlideCanvas', async () => {
  const React = await import('react');
  return {
    EditableSlideCanvas(props: EditableSlideCanvasProps) {
      canvasMock.latestProps = props;
      const editingId = props.selection?.editingId;
      const { onTextContentChange, onTextEditorChange, onTextFormatChange } = props;
      React.useEffect(() => {
        if (!editingId) return;
        onTextEditorChange?.(controller(editingId, onTextContentChange));
        onTextFormatChange?.(editingId, canvasMock.format);
        return () => onTextEditorChange?.(null);
      }, [editingId, onTextContentChange, onTextEditorChange, onTextFormatChange]);
      const prefix = props.elementIdPrefix ?? 'slide-element-';
      return React.createElement(
        'div',
        { 'data-testid': 'editable-slide-canvas' },
        props.slide.elements.map((element) =>
          React.createElement(
            'div',
            {
              'data-element-id': element.id,
              id: `${prefix}${element.id}`,
              key: element.id,
            },
            React.createElement('div', {
              className: `base-element-${element.type}`,
            }),
          ),
        ),
      );
    },
  };
});

import { EditableSlideCanvasWithUI } from '../../src/ui';

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
} as const;

const elements = [
  textElement,
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
  {
    id: 'formula-1',
    type: 'latex',
    left: 100,
    top: 100,
    width: 180,
    height: 60,
    rotate: 0,
    latex: 'x^2',
    html: '<span>x²</span>',
    color: '#2563eb',
    align: 'center',
  },
  {
    id: 'video-1',
    type: 'video',
    left: 100,
    top: 100,
    width: 320,
    height: 180,
    rotate: 0,
    src: 'video.mp4',
    poster: 'cover.png',
    autoplay: false,
  },
  {
    id: 'audio-1',
    type: 'audio',
    left: 100,
    top: 100,
    width: 240,
    height: 64,
    rotate: 0,
    fixedRatio: true,
    color: '#7c3aed',
    loop: false,
    autoplay: false,
    src: 'lesson.mp3',
  },
  {
    id: 'image-1',
    type: 'image',
    left: 100,
    top: 100,
    width: 240,
    height: 160,
    rotate: 0,
    fixedRatio: true,
    src: 'cover.png',
  },
] as const;

const slide = {
  id: 'slide-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: {
    backgroundColor: '#ffffff',
    themeColors: ['#2563eb'],
    fontColor: '#111111',
    fontName: 'Arial',
  },
  elements,
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

interface HarnessProps extends Omit<ComponentProps<typeof EditableSlideCanvasWithUI>, 'selection'> {
  readonly initialSelection?: Selection;
}

function Harness({
  initialSelection = { elementIds: [] },
  onSelectionChange,
  ...props
}: HarnessProps) {
  const [selection, setSelection] = useState(initialSelection);
  const updateSelection = useCallback(
    (next: Selection) => {
      setSelection(next);
      onSelectionChange(next);
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

function renderEditor(overrides: Partial<HarnessProps> = {}) {
  const onTransaction = vi.fn();
  const onSelectionChange = vi.fn();
  const view = render(
    <Harness
      slide={slide}
      scale={1}
      host={{ locale: 'en-US', createElementId: (type) => `new-${type}` }}
      onTransaction={onTransaction}
      onSelectionChange={onSelectionChange}
      {...overrides}
    />,
  );
  return { ...view, onTransaction, onSelectionChange };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-toolbar-overlay')) return rect(0, 0, 640, 48);
    if (this.classList.contains('base-element-line')) return rect(100, 200, 120, 80);
    return rect(100, 100, 240, 80);
  });
});

afterEach(() => {
  cleanup();
  canvasMock.latestProps = null;
  canvasMock.activeController = null;
  vi.restoreAllMocks();
});

describe('EditableSlideCanvasWithUI canonical host', () => {
  it('uses the built-in insert order and emits a canonical text-add transaction', () => {
    const { onTransaction, onSelectionChange } = renderEditor();
    const toolbar = screen.getByRole('toolbar', { name: 'Insert toolbar' });
    expect(
      Array.from(toolbar.querySelectorAll('button')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual([
      'Insert text box',
      'Insert image',
      'Insert table',
      'Insert chart',
      'Insert line',
      'Slide background',
      'Insert formula',
      'Insert video',
      'Insert audio',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Insert text box' }));
    act(() =>
      canvasMock.latestProps?.onTextCreate?.({ left: 10, top: 20, width: 200, height: 60 }),
    );
    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            type: 'element.add',
            element: expect.objectContaining({ id: 'new-text', type: 'text' }),
          }),
        ],
      }),
    );
    expect(onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['new-text'],
      primaryId: 'new-text',
      editingId: 'new-text',
    });
  });

  it('uses insertItems as the visibility filter and display order', () => {
    renderEditor({ insertItems: ['audio', 'text', 'image'] });
    const toolbar = screen.getByRole('toolbar', { name: 'Insert toolbar' });
    expect(
      Array.from(toolbar.querySelectorAll('button')).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['Insert audio', 'Insert text box', 'Insert image']);
  });

  it('updates visible editor labels when the host language changes', () => {
    const translate = (language: string) => (key: string) => `${language}:${key}`;
    const onTransaction = vi.fn();
    const onSelectionChange = vi.fn();
    const view = render(
      <Harness
        slide={slide}
        scale={1}
        host={{ locale: 'ja-JP', translate: translate('ja') }}
        onTransaction={onTransaction}
        onSelectionChange={onSelectionChange}
      />,
    );

    expect(screen.getByRole('toolbar', { name: 'ja:insert.toolbar' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ja:insert.textBox' })).not.toBeNull();

    view.rerender(
      <Harness
        slide={slide}
        scale={1}
        host={{ locale: 'fr-FR', translate: translate('fr') }}
        onTransaction={onTransaction}
        onSelectionChange={onSelectionChange}
      />,
    );

    expect(screen.getByRole('toolbar', { name: 'fr:insert.toolbar' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'fr:insert.textBox' })).not.toBeNull();
  });

  it('removes the insert rail for an empty insertItems array', () => {
    renderEditor({ insertItems: [] });
    expect(screen.queryByRole('toolbar', { name: 'Insert toolbar' })).toBeNull();
    expect(screen.getByTestId('editable-slide-canvas').parentElement?.parentElement).toHaveStyle({
      height: '100%',
    });
  });

  it('converts text editor changes into canonical transactions', async () => {
    const { onTransaction } = renderEditor({
      initialSelection: { elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' },
    });
    expect(canvasMock.latestProps?.selection).toEqual({
      elementIds: ['text-1'],
      primaryId: 'text-1',
      editingId: 'text-1',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Bold' }));
    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          {
            type: 'text.updateContent',
            elementId: 'text-1',
            content: '<p><strong>text-1</strong></p>',
          },
        ],
      }),
    );
  });

  it('discards a buffered text draft before toolbar deletion', async () => {
    const { onTransaction } = renderEditor({
      initialSelection: { elementIds: ['text-1'], primaryId: 'text-1', editingId: 'text-1' },
    });
    const activeController = canvasMock.activeController;
    expect(activeController).not.toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(activeController?.discard).toHaveBeenCalledBefore(onTransaction);
    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'element.deleteMany', elementIds: ['text-1'] }],
      }),
    );
  });

  it('keeps geometry handles editable and routes canvas changes through transactions', () => {
    const { onTransaction } = renderEditor({
      initialSelection: { elementIds: ['image-1'], primaryId: 'image-1' },
    });

    expect(canvasMock.latestProps?.onElementsChange).toBeTypeOf('function');
    act(() => {
      canvasMock.latestProps?.onElementsChange?.([
        {
          type: 'element.update',
          id: 'image-1',
          props: { left: 160, top: 120, width: 300, height: 200 },
        },
      ]);
    });

    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          {
            type: 'element.update',
            elementId: 'image-1',
            patch: { left: 160, top: 120, width: 300, height: 200 },
          },
        ],
      }),
    );
  });

  it.each([
    ['formula-1', 'Formula toolbar'],
    ['video-1', 'Video toolbar'],
    ['audio-1', 'Audio toolbar'],
    ['image-1', 'Image toolbar'],
    ['table-1', 'Element toolbar'],
    ['line-1', 'Line toolbar'],
  ])('provides the registered %s editing overlay', async (id, toolbarName) => {
    renderEditor({ initialSelection: { elementIds: [id], primaryId: id } });
    expect(canvasMock.latestProps?.selection).toEqual({ elementIds: [id], primaryId: id });
    expect(await screen.findByRole('toolbar', { name: toolbarName })).not.toBeNull();
  });

  it('routes an audio property edit through the canonical transaction sink', async () => {
    const { onTransaction } = renderEditor({
      initialSelection: { elementIds: ['audio-1'], primaryId: 'audio-1' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Loop' }));
    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'element.update', elementId: 'audio-1', patch: { loop: true } }],
      }),
    );
  });

  it('keeps exactly one editing style element across rerenders', () => {
    const view = renderEditor();
    expect(view.container.querySelectorAll('style')).toHaveLength(1);
    view.rerender(
      <Harness
        slide={slide}
        scale={1}
        host={{ locale: 'en-US' }}
        onTransaction={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(view.container.querySelectorAll('style')).toHaveLength(1);
  });

  it('uses canonical document data for clipboard commands', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    const resolved = { ...slide, elements: [{ ...elements[6], src: 'blob:preview' }] } as Slide;
    const canonical = {
      ...slide,
      elements: [{ ...elements[6], src: 'asset://image' }],
    } as Slide;
    renderEditor({
      slide: resolved,
      documentSlide: canonical,
      initialSelection: { elementIds: ['image-1'], primaryId: 'image-1' },
    });
    fireEvent.keyDown(document, { key: 'c', metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(JSON.parse(writeText.mock.calls[0][0]).elements[0].src).toBe('asset://image');
  });
});
