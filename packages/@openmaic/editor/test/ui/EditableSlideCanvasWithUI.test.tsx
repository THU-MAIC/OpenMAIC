// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { EditableSlideCanvasProps, Selection } from '../../src/react/types';
import type {
  TextEditCommand,
  TextEditorController,
  TextFormatState,
} from '../../src/react/text/types';

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

vi.mock('../../src/react/EditableSlideCanvas', async () => {
  const React = await import('react');

  return {
    EditableSlideCanvas(props: EditableSlideCanvasProps) {
      canvasMock.latestProps = props;
      const editingId = props.selection?.editingId;
      const { onTextContentChange, onTextEditorChange, onTextFormatChange } = props;

      React.useEffect(() => {
        if (!editingId || !canvasMock.autoRegister) return;

        const controller = createController(editingId, onTextContentChange);
        onTextEditorChange?.(controller);
        if (canvasMock.autoFormat) {
          onTextFormatChange?.(editingId, canvasMock.format);
        }
        return () => onTextEditorChange?.(null);
      }, [editingId, onTextContentChange, onTextEditorChange, onTextFormatChange]);

      const prefix = props.elementIdPrefix ?? 'slide-element-';
      return React.createElement(
        'div',
        { 'data-testid': 'editable-slide-canvas' },
        props.slide.elements
          .filter(
            (element) =>
              element.type === 'text' ||
              element.type === 'table' ||
              element.type === 'image' ||
              element.type === 'shape' ||
              element.type === 'chart' ||
              element.type === 'line' ||
              element.type === 'latex' ||
              element.type === 'video' ||
              element.type === 'audio',
          )
          .map((element) =>
            React.createElement(
              'div',
              { id: `${prefix}${element.id}`, key: element.id, 'data-element-id': element.id },
              React.createElement(
                element.type === 'text' ? 'button' : 'div',
                {
                  className: `base-element-${element.type}`,
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

import { EDITING_UI_STYLES, EditableSlideCanvasWithUI } from '../../src/ui';

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

const videoElement = {
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
} as const;

const audioElement = {
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
} as const;

const imageElement = {
  id: 'image-1',
  type: 'image',
  left: 100,
  top: 100,
  width: 240,
  height: 160,
  rotate: 0,
  src: 'cover.png',
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
    if (this.classList.contains('base-element-image')) return rect(100, 100, 240, 160);
    if (this.classList.contains('base-element-line')) return rect(100, 200, 120, 80);
    if (this.classList.contains('base-element-latex')) return rect(100, 100, 180, 60);
    if (this.classList.contains('base-element-video')) return rect(100, 100, 320, 180);
    if (this.classList.contains('base-element-audio')) return rect(100, 100, 240, 64);
    if (this.classList.contains('maic-editing-ui-video-toolbar')) return rect(0, 0, 192, 40);
    if (this.classList.contains('maic-editing-ui-audio-toolbar')) return rect(0, 0, 224, 40);
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
  vi.unstubAllGlobals();
});

describe('EditableSlideCanvasWithUI', () => {
  it('keeps the canvas read-only when no mutation sink is supplied', () => {
    renderControlled({
      onTextContentChange: undefined,
      onElementsChange: undefined,
      onTransaction: undefined,
    });

    expect(canvasMock.latestProps?.onElementsChange).toBeUndefined();
    expect(canvasMock.latestProps?.onTextContentChange).toBeUndefined();
    expect(canvasMock.latestProps?.onTextAutoSize).toBeUndefined();
    expect(canvasMock.latestProps?.onTableCellChange).toBeUndefined();
  });

  it('copies canonical media references instead of resolved render URLs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    const resolvedImage = { ...imageElement, src: 'blob:resolved-preview' };
    const canonicalImage = { ...imageElement, src: 'asset://canonical-image' };

    renderControlled({
      slide: { ...slide, elements: [resolvedImage] } as unknown as Slide,
      documentSlide: { ...slide, elements: [canonicalImage] } as unknown as Slide,
      initialSelection: { elementIds: ['image-1'], primaryId: 'image-1' },
      host: { locale: 'en-US' },
      onTransaction: vi.fn(),
    });

    fireEvent.keyDown(document, { key: 'c', metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.elements[0].src).toBe('asset://canonical-image');
  });

  it('provides built-in insert tools and creates elements with only a host', () => {
    const onTransaction = vi.fn();
    const onSelectionChange = vi.fn();
    renderControlled({
      host: { locale: 'en-US', createElementId: (type) => `new-${type}` },
      onTransaction,
      onSelectionChange,
    });

    expect(screen.getByRole('toolbar', { name: 'Insert toolbar' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Insert text box' }));
    act(() =>
      canvasMock.latestProps?.onTextCreate?.({ left: 40, top: 50, width: 240, height: 80 }),
    );

    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'toolbar',
        operations: [
          expect.objectContaining({
            type: 'element.add',
            element: expect.objectContaining({ id: 'new-text', type: 'text', left: 40, top: 50 }),
          }),
        ],
      }),
    );
    expect(onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['new-text'],
      primaryId: 'new-text',
      editingId: 'new-text',
    });
    expect(screen.getByRole('button', { name: 'Insert image' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Insert table' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Insert chart' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Insert line' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Insert formula' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Insert video' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Insert audio' })).not.toBeNull();
    expect(Object.keys(canvasMock.latestProps?.shapePathFormulas ?? {})).not.toHaveLength(0);
  });

  it('preserves image aspect ratio when a custom asset picker only returns src', async () => {
    class TestImage {
      naturalWidth = 1200;
      naturalHeight = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', TestImage);
    const onTransaction = vi.fn();
    renderControlled({
      host: {
        locale: 'en-US',
        createElementId: () => 'new-image',
        renderAssetPicker: ({ onPick }) => (
          <button type="button" onClick={() => onPick({ src: 'custom-image.png' })}>
            Pick custom image
          </button>
        ),
      },
      onTransaction,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick custom image' }));

    await waitFor(() =>
      expect(onTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          operations: [
            expect.objectContaining({
              type: 'element.add',
              element: expect.objectContaining({ width: 600, height: 300 }),
            }),
          ],
        }),
      ),
    );
  });

  it('cancels an editor-owned insertion mode with Escape', () => {
    renderControlled({
      host: { locale: 'en-US' },
      onTransaction: vi.fn(),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert text box' }));
    expect(canvasMock.latestProps?.creatingText).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(canvasMock.latestProps?.creatingText).toBe(false);
  });

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

  it('defaults to a top rail and supports an explicit left rail without covering the canvas', () => {
    const { rerender } = renderControlled({
      insertToolbar: { label: 'Insert', items: [] },
    });

    expect(screen.getByTestId('editable-slide-canvas').parentElement?.style).toMatchObject({
      bottom: '0px',
      left: '0px',
      right: '0px',
      top: '48px',
    });

    rerender(
      <ControlledHarness
        slide={slide}
        scale={1}
        textToolbar={{ locale: 'zh-CN', labels: { toolbar: '文本格式' } }}
        onTextContentChange={vi.fn()}
        insertToolbar={{ label: 'Insert', items: [], placement: 'left' }}
      />,
    );

    expect(screen.getByTestId('editable-slide-canvas').parentElement?.style).toMatchObject({
      bottom: '0px',
      left: '48px',
      right: '0px',
      top: '0px',
    });
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

  it('adds the renderer-owned video picker to the insert toolbar', () => {
    const onInsert = vi.fn();

    renderControlled({
      insertToolbar: { label: 'Insert', items: [] },
      videoInsert: {
        labels: {
          insertVideo: 'Insert video',
          videoDrop: 'Drop video',
          videoOr: 'or URL',
          videoUrlPlaceholder: 'Video URL',
          videoInsert: 'Insert',
        },
        onInsert,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert video' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Video URL' }), {
      target: { value: 'https://cdn.example.com/lesson.mp4?version=2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    expect(onInsert).toHaveBeenCalledWith({
      src: 'https://cdn.example.com/lesson.mp4?version=2',
      ext: 'mp4',
    });
  });

  it('adds the renderer-owned audio picker to the insert toolbar', () => {
    const onInsert = vi.fn();

    renderControlled({
      insertToolbar: { label: 'Insert', items: [] },
      audioInsert: {
        labels: {
          insertAudio: 'Insert audio',
          audioDrop: 'Drop audio',
          audioOr: 'or URL',
          audioUrlPlaceholder: 'Audio URL',
          audioInsert: 'Insert',
        },
        onInsert,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Insert audio' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Audio URL' }), {
      target: { value: 'https://cdn.example.com/lesson.mp3?version=2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    expect(onInsert).toHaveBeenCalledWith({
      src: 'https://cdn.example.com/lesson.mp3?version=2',
      ext: 'mp3',
    });
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
        labels: {
          toolbar: '公式工具栏',
          editFormula: '编辑公式',
          bringToFront: '置于顶层',
          sendToBack: '置于底层',
          delete: '删除',
        },
      },
    });

    expect(screen.getByRole('toolbar', { name: '公式工具栏' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '编辑公式' }).getAttribute('data-tooltip')).toBe(
      '编辑公式',
    );
    expect(screen.getByRole('button', { name: '置于顶层' }).getAttribute('data-tooltip')).toBe(
      '置于顶层',
    );
    expect(screen.getByRole('button', { name: '置于底层' }).getAttribute('data-tooltip')).toBe(
      '置于底层',
    );
    expect(screen.getByRole('button', { name: '删除' }).getAttribute('data-tooltip')).toBe('删除');
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    fireEvent.click(screen.getByRole('button', { name: '置于底层' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onBringToFront).toHaveBeenCalledWith('formula-1');
    expect(onSendToBack).toHaveBeenCalledWith('formula-1');
    expect(onDelete).toHaveBeenCalledWith('formula-1');
  });

  it('groups selected video controls and delegates poster changes', async () => {
    const onPosterChange = vi.fn();
    const onBringToFront = vi.fn();
    const onSendToBack = vi.fn();
    const onDelete = vi.fn();

    renderControlled({
      slide: { ...slide, elements: [videoElement] } as unknown as Slide,
      initialSelection: { elementIds: ['video-1'], primaryId: 'video-1' },
      videoEditor: {
        labels: {
          toolbar: '视频工具栏',
          poster: '设置封面',
          bringToFront: '置于顶层',
          sendToBack: '置于底层',
          delete: '删除',
        },
        renderPosterPicker: ({ onPick }) => (
          <button type="button" onClick={() => onPick('next-cover.png')}>
            Pick poster
          </button>
        ),
        onPosterChange,
        onBringToFront,
        onSendToBack,
        onDelete,
      },
    });

    expect(await screen.findByRole('toolbar', { name: '视频工具栏' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '自动播放' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置封面' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick poster' }));
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    fireEvent.click(screen.getByRole('button', { name: '置于底层' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onPosterChange).toHaveBeenCalledWith('video-1', 'next-cover.png');
    expect(onBringToFront).toHaveBeenCalledWith('video-1');
    expect(onSendToBack).toHaveBeenCalledWith('video-1');
    expect(onDelete).toHaveBeenCalledWith('video-1');
  });

  it('groups selected audio controls and delegates loop and element actions', async () => {
    const onLoopChange = vi.fn();
    const onBringToFront = vi.fn();
    const onSendToBack = vi.fn();
    const onDelete = vi.fn();

    renderControlled({
      slide: { ...slide, elements: [audioElement] } as unknown as Slide,
      initialSelection: { elementIds: ['audio-1'], primaryId: 'audio-1' },
      audioEditor: {
        labels: {
          toolbar: '音频工具栏',
          preview: '试听',
          pause: '暂停',
          loop: '循环播放',
          bringToFront: '置于顶层',
          sendToBack: '置于底层',
          delete: '删除',
        },
        onLoopChange,
        onBringToFront,
        onSendToBack,
        onDelete,
      },
    });

    expect(await screen.findByRole('toolbar', { name: '音频工具栏' })).not.toBeNull();
    const loop = screen.getByRole('button', { name: '循环播放' });
    expect(loop.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(loop);
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    fireEvent.click(screen.getByRole('button', { name: '置于底层' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onLoopChange).toHaveBeenCalledWith('audio-1', true);
    expect(onBringToFront).toHaveBeenCalledWith('audio-1');
    expect(onSendToBack).toHaveBeenCalledWith('audio-1');
    expect(onDelete).toHaveBeenCalledWith('audio-1');
  });

  it('renders renderer-owned element controls for a selected table', async () => {
    const onBringToFront = vi.fn();
    const onSendToBack = vi.fn();
    const onDelete = vi.fn();

    renderControlled({
      initialSelection: { elementIds: ['table-1'], primaryId: 'table-1' },
      elementToolbar: {
        labels: {
          toolbar: '元素工具栏',
          bringToFront: '置于顶层',
          sendToBack: '置于底层',
          delete: '删除',
        },
        onBringToFront,
        onSendToBack,
        onDelete,
      },
    });

    expect(await screen.findByRole('toolbar', { name: '元素工具栏' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '置于顶层' }));
    fireEvent.click(screen.getByRole('button', { name: '置于底层' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(onBringToFront).toHaveBeenCalledWith('table-1');
    expect(onSendToBack).toHaveBeenCalledWith('table-1');
    expect(onDelete).toHaveBeenCalledWith('table-1');
  });

  it('renders renderer-owned image actions while delegating asset selection to the host', async () => {
    const onReplace = vi.fn();
    const onFlip = vi.fn();

    renderControlled({
      slide: { ...slide, elements: [imageElement] } as unknown as Slide,
      initialSelection: { elementIds: ['image-1'], primaryId: 'image-1' },
      imageEditor: {
        labels: {
          toolbar: '图片工具栏',
          replace: '替换图片',
          flipH: '水平翻转',
          flipV: '垂直翻转',
          bringToFront: '置于顶层',
          sendToBack: '置于底层',
          delete: '删除',
        },
        renderPicker: ({ onPick }) => (
          <button type="button" onClick={() => onPick('replacement.png')}>
            Pick image
          </button>
        ),
        onReplace,
        onFlip,
      },
    });

    expect(await screen.findByRole('toolbar', { name: '图片工具栏' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '替换图片' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick image' }));
    fireEvent.click(screen.getByRole('button', { name: '水平翻转' }));
    fireEvent.click(screen.getByRole('button', { name: '垂直翻转' }));

    expect(onReplace).toHaveBeenCalledWith('image-1', 'replacement.png');
    expect(onFlip).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-1' }), 'H');
    expect(onFlip).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-1' }), 'V');
  });

  it('owns selected image actions when only the generic host is configured', async () => {
    const onTransaction = vi.fn();
    const renderAssetPicker = vi.fn(({ onPick }: { onPick: (asset: { src: string }) => void }) => (
      <button type="button" onClick={() => onPick({ src: 'host-replacement.png' })}>
        Pick host image
      </button>
    ));

    renderControlled({
      slide: { ...slide, elements: [imageElement] } as unknown as Slide,
      initialSelection: { elementIds: ['image-1'], primaryId: 'image-1' },
      host: { locale: 'en-US', renderAssetPicker },
      onTransaction,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Replace image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick host image' }));

    expect(renderAssetPicker).toHaveBeenCalledWith(
      expect.objectContaining({ accept: 'image/*', currentSrc: 'cover.png' }),
    );
    expect(onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'toolbar',
        operations: [
          expect.objectContaining({
            type: 'element.update',
            elementId: 'image-1',
            patch: expect.objectContaining({ src: 'host-replacement.png' }),
          }),
        ],
      }),
    );
  });

  it('uses the renderer-owned context menu and delegates its commands', async () => {
    const onSelectionChange = vi.fn();
    const onCopy = vi.fn();

    renderControlled({
      onSelectionChange,
      contextMenu: {
        labels: { copy: '复制' },
        onSelectAll: vi.fn(),
        onCopy,
        onCut: vi.fn(),
        onPaste: vi.fn(),
        onUnlock: vi.fn(),
        onLock: vi.fn(),
        onDelete: vi.fn(),
        onToggleGroup: vi.fn(),
        onReorder: vi.fn(),
        onAlign: vi.fn(),
      },
    });

    fireEvent.contextMenu(screen.getAllByRole('button', { name: 'Second' })[0], {
      clientX: 120,
      clientY: 120,
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      elementIds: ['text-2'],
      primaryId: 'text-2',
    });
    expect(await screen.findByRole('menu')).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /复制/ }));
    expect(onCopy).toHaveBeenCalledTimes(1);
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
