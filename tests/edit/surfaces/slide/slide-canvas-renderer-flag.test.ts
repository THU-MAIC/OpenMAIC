import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditableSlideCanvasWithUIProps } from '@openmaic/renderer/editing-ui';
import { FONTS } from '@/configs/font';
import type { SceneDataController } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';

const mockSetActiveElementIdList = vi.fn();
const mockSetEditingElementId = vi.fn();
const mockSetRichtextAttrs = vi.fn();
const mockSetDisableHotkeysState = vi.fn();
const mockSetCanvasScale = vi.fn();
const mockSetCreatingElement = vi.fn();
const mockApplyOp = vi.fn();
const mockCommitContent = vi.fn();
const mockInsertImageElement = vi.fn();
const mockInsertChartElement = vi.fn();
const mockInsertTableElement = vi.fn();
let activeElementIds: string[] = [];
let hiddenElementIds: string[] = [];
let editingElementId = '';
let clipingImageElementId = '';
let creatingElement: { type: string; data?: unknown } | null = null;
let spotlightPrefix: string | undefined;
let laserPrefix: string | undefined;
let lastRendererProps: EditableSlideCanvasWithUIProps | undefined;

vi.mock('@/components/slide-renderer/Editor/Canvas', () => ({
  default: () => createElement('div', { 'data-testid': 'legacy-editor-canvas' }),
}));

vi.mock('@/components/slide-renderer/Editor/SpotlightOverlay', () => ({
  SpotlightOverlay: ({ domIdPrefix }: { domIdPrefix?: string }) => {
    spotlightPrefix = domIdPrefix;
    return createElement('div', { 'data-testid': 'spotlight-overlay' });
  },
}));

vi.mock('@/components/slide-renderer/Editor/LaserPointerOverlay', () => ({
  LaserPointerOverlay: ({ domIdPrefix }: { domIdPrefix?: string }) => {
    laserPrefix = domIdPrefix;
    return createElement('div', { 'data-testid': 'laser-overlay' });
  },
}));

vi.mock('@/components/edit/surfaces/slide/AnchoredTextBar', () => ({
  AnchoredTextBar: () => createElement('div', { 'data-testid': 'anchored-text-bar' }),
}));

vi.mock('@/components/edit/surfaces/slide/AnchoredElementBar', () => ({
  AnchoredElementBar: () => createElement('div', { 'data-testid': 'anchored-element-bar' }),
}));

vi.mock('@/components/edit/surfaces/slide/ElementPickLayer', () => ({
  ElementPickLayer: () => createElement('div', { 'data-testid': 'element-pick-layer' }),
}));

vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'scene-provider' }, children),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: (key: string) => `translated:${key}`,
  }),
}));

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      activeElementIdList: () => activeElementIds,
      hiddenElementIdList: () => hiddenElementIds,
      pickTarget: () => null,
      disableHotkeys: () => false,
      creatingElement: () => creatingElement,
      editingElementId: () => editingElementId,
      clipingImageElementId: () => clipingImageElementId,
      setActiveElementIdList: () => mockSetActiveElementIdList,
      setEditingElementId: () => mockSetEditingElementId,
      setRichtextAttrs: () => mockSetRichtextAttrs,
      setDisableHotkeysState: () => mockSetDisableHotkeysState,
      setCanvasScale: () => mockSetCanvasScale,
      setCreatingElement: () => mockSetCreatingElement,
      setClipingImageElementId: () => vi.fn(),
    },
    getState: () => ({
      creatingElement: null,
      setCreatingElement: mockSetCreatingElement,
      setActiveElementIdList: mockSetActiveElementIdList,
      setEditingElementId: mockSetEditingElementId,
      setRichtextAttrs: mockSetRichtextAttrs,
      setDisableHotkeysState: mockSetDisableHotkeysState,
      setCanvasScale: mockSetCanvasScale,
      setClipingImageElementId: vi.fn(),
    }),
  },
}));

vi.mock('@/components/edit/surfaces/slide/slide-edit-session', () => ({
  useSlideEditSession: {
    getState: () => ({
      applyOp: mockApplyOp,
      commitContent: mockCommitContent,
    }),
  },
}));

vi.mock('@/components/edit/surfaces/slide/use-slide-surface', () => ({
  insertImageElement: mockInsertImageElement,
  insertChartElement: mockInsertChartElement,
  insertTableElement: mockInsertTableElement,
  useEditingTextElementId: () => '',
  useSelectedNonTextElement: () => null,
  useSlideCanvasController: () => ({
    controller: {
      sceneId: 'scene-1',
      sceneType: 'slide',
      getSnapshot: () => slideContent,
      updateSceneData: vi.fn(),
    } satisfies SceneDataController<SlideContent>,
    gestureProps: {
      onPointerDownCapture: vi.fn(),
      onPointerUpCapture: vi.fn(),
      onPointerCancelCapture: vi.fn(),
    },
  }),
  useSyncEditingElementId: vi.fn(),
  useResolvedSlideContent: () => slideContent,
}));

vi.mock('@openmaic/renderer/editing-ui', () => ({
  ChartInsertPicker: (props: Record<string, unknown>) =>
    createElement('div', { 'data-testid': 'chart-insert-picker', ...props }),
  EditableSlideCanvasWithUI: (props: EditableSlideCanvasWithUIProps) => {
    lastRendererProps = props;
    return createElement('button', {
      type: 'button',
      'data-testid': 'renderer-editing-ui',
      'data-selection': props.selection?.elementIds.join(',') ?? '',
    });
  },
}));

const flag = 'NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED';
const slideContent: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [
      {
        id: 'title-1',
        type: 'text',
        left: 24,
        top: 32,
        width: 120,
        height: 48,
        rotate: 0,
        content: '<p>Hello</p>',
        defaultFontName: 'Arial',
        defaultColor: '#111111',
      },
      {
        id: 'table-1',
        type: 'table',
        left: 40,
        top: 120,
        width: 240,
        height: 80,
        rotate: 0,
        outline: { width: 1, color: '#111111', style: 'solid' },
        colWidths: [0.5, 0.5],
        cellMinHeight: 40,
        data: [
          [
            { id: 'cell-a', colspan: 1, rowspan: 1, text: 'A' },
            { id: 'cell-b', colspan: 1, rowspan: 1, text: 'B' },
          ],
        ],
      },
    ],
  },
};

describe('slide editor canvas renderer flag', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
    mockSetActiveElementIdList.mockClear();
    mockSetEditingElementId.mockClear();
    mockSetRichtextAttrs.mockClear();
    mockSetDisableHotkeysState.mockClear();
    mockSetCanvasScale.mockClear();
    mockSetCreatingElement.mockClear();
    mockApplyOp.mockClear();
    mockCommitContent.mockClear();
    mockInsertChartElement.mockClear();
    activeElementIds = [];
    hiddenElementIds = [];
    editingElementId = '';
    clipingImageElementId = '';
    creatingElement = null;
    spotlightPrefix = undefined;
    laserPrefix = undefined;
    lastRendererProps = undefined;
  });

  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it('uses the legacy editor canvas when the renderer editor flag is unset', async () => {
    delete process.env[flag];
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    const html = renderToStaticMarkup(createElement(SlideCanvas));

    expect(html).toContain('data-testid="legacy-editor-canvas"');
    expect(html).toContain('data-testid="anchored-text-bar"');
    expect(html).not.toContain('data-testid="renderer-editing-ui"');
  });

  it('uses renderer editing-ui without the app text bar when the flag is enabled', async () => {
    process.env[flag] = 'true';
    activeElementIds = ['title-1'];
    editingElementId = 'title-1';
    hiddenElementIds = ['hidden-1'];
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    const html = renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onSelectionChange?.({
      elementIds: ['title-1'],
      primaryId: 'title-1',
      editingId: 'title-1',
    });
    lastRendererProps?.onElementsChange?.([
      { type: 'element.update', id: 'title-1', props: { left: 48 } },
      { type: 'element.update', id: 'title-1', props: { top: 64 } },
    ]);

    expect(html).toContain('data-testid="renderer-editing-ui"');
    expect(html).toContain('data-renderer-canvas-context-menu=""');
    expect(html).toContain('data-selection="title-1"');
    expect(html).not.toContain('data-testid="legacy-editor-canvas"');
    expect(html).toContain('data-testid="spotlight-overlay"');
    expect(html).toContain('data-testid="laser-overlay"');
    expect(html).not.toContain('data-testid="anchored-text-bar"');
    expect(html).toContain('data-testid="anchored-element-bar"');
    expect(html).toContain('data-testid="element-pick-layer"');
    expect(lastRendererProps?.selection).toEqual({
      elementIds: ['title-1'],
      primaryId: 'title-1',
      editingId: 'title-1',
    });
    expect(lastRendererProps?.elementIdPrefix).toBe('editable-element-');
    expect(lastRendererProps?.hiddenElementIds).toEqual(['hidden-1']);
    expect(spotlightPrefix).toBe(lastRendererProps?.elementIdPrefix);
    expect(laserPrefix).toBe(lastRendererProps?.elementIdPrefix);
    expect(lastRendererProps?.snapping).toBe(true);
    expect(lastRendererProps?.renderImage).toBeTypeOf('function');
    expect(lastRendererProps?.shapePathFormulas).toBeDefined();
    expect(lastRendererProps?.textToolbar).toEqual({
      locale: 'zh-CN',
      fonts: FONTS.map((font) => ({
        value: font.value,
        label: font.labelKey ? `translated:${font.labelKey}` : font.label,
      })),
    });
    expect(lastRendererProps?.lineToolbar).toEqual({ locale: 'zh-CN' });
    const insertToolbar = lastRendererProps?.insertToolbar;
    expect(insertToolbar).not.toBe(false);
    expect(insertToolbar && insertToolbar.items.map((item) => item.id)).toEqual([
      'insert-text',
      'insert-image',
      'insert-table',
      'insert-chart',
      'insert-line',
      'slide-background',
    ]);
    if (!insertToolbar) throw new Error('Expected renderer insert toolbar');
    const chartItem = insertToolbar.items.find((item) => item.id === 'insert-chart');
    const close = vi.fn();
    const chartPicker = chartItem?.renderPopover?.({ close });
    if (!isValidElement<{ onPick: (type: 'pie') => void }>(chartPicker)) {
      throw new Error('Expected chart picker popover');
    }
    chartPicker.props.onPick('pie');
    expect(mockInsertChartElement).toHaveBeenCalledWith('pie');
    expect(close).toHaveBeenCalledTimes(1);
    expect(mockSetActiveElementIdList).toHaveBeenCalledWith(['title-1']);
    expect(mockSetEditingElementId).toHaveBeenCalledWith('title-1');
    expect(mockApplyOp).not.toHaveBeenCalled();
    expect(mockCommitContent).toHaveBeenCalledTimes(1);
    expect(mockCommitContent.mock.calls[0][0].canvas.elements[0]).toMatchObject({
      left: 48,
      top: 64,
    });
    expect(mockCommitContent.mock.calls[0][1]).toBe(true);
  });

  it('bridges renderer text content, auto-size and focus callbacks', async () => {
    process.env[flag] = 'true';
    activeElementIds = ['title-1'];
    editingElementId = 'title-1';
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onTextFocusChange?.(true);
    lastRendererProps?.onTextContentChange?.({
      intent: {
        type: 'text.updateContent',
        id: 'title-1',
        target: 'text',
        content: '<p>Edited</p>',
      },
      history: 'neutral',
    });
    lastRendererProps?.onTextAutoSize?.({
      type: 'element.update',
      id: 'title-1',
      props: { height: 72 },
    });

    expect(mockSetDisableHotkeysState).toHaveBeenCalledWith(true);
    expect(mockCommitContent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: expect.arrayContaining([expect.objectContaining({ content: '<p>Edited</p>' })]),
        }),
      }),
      false,
    );
    expect(mockCommitContent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: expect.arrayContaining([expect.objectContaining({ height: 72 })]),
        }),
      }),
      false,
    );
  });

  it('bridges a completed renderer table-cell edit as one history record', async () => {
    process.env[flag] = 'true';
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onTableCellChange?.({
      intent: {
        type: 'table.updateCell',
        id: 'table-1',
        cellId: 'cell-b',
        text: 'Edited',
      },
      history: 'record',
    });

    expect(mockCommitContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              id: 'table-1',
              data: expect.arrayContaining([
                expect.arrayContaining([expect.objectContaining({ id: 'cell-b', text: 'Edited' })]),
              ]),
            }),
          ]),
        }),
      }),
      true,
    );
  });

  it('creates, selects, and persists a renderer text box from the armed canvas gesture', async () => {
    process.env[flag] = 'true';
    creatingElement = { type: 'text' };
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onTextCreate?.({ left: 120, top: 80, width: 300, height: 60 });

    expect(mockSetCreatingElement).toHaveBeenCalledWith(null);
    expect(mockSetActiveElementIdList).toHaveBeenCalledWith([
      expect.stringMatching(/^text-/),
    ]);
    expect(mockSetEditingElementId).toHaveBeenCalledWith(expect.stringMatching(/^text-/));
    expect(mockCommitContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              left: 120,
              top: 80,
              width: 300,
              height: 60,
              content: '<p style="text-align: center"><br></p>',
            }),
          ]),
        }),
      }),
      true,
    );
  });

  it('creates, selects, and persists a renderer line from the armed canvas gesture', async () => {
    process.env[flag] = 'true';
    creatingElement = {
      type: 'line',
      data: { path: 'M 0 0 L 20 20', style: 'solid', points: ['', ''] },
    };
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onLineCreate?.({ start: [280, 180], end: [120, 80] });

    expect(mockSetCreatingElement).toHaveBeenCalledWith(null);
    expect(mockSetActiveElementIdList).toHaveBeenCalledWith([
      expect.stringMatching(/^line-/),
    ]);
    expect(mockSetEditingElementId).toHaveBeenCalledWith('');
    expect(mockCommitContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              type: 'line',
              left: 120,
              top: 80,
              width: 2,
              start: [160, 100],
              end: [0, 0],
              style: 'solid',
              color: '#333333',
              points: ['', ''],
            }),
          ]),
        }),
      }),
      true,
    );
  });

  it('preserves the armed renderer line preset when creating a curve', async () => {
    process.env[flag] = 'true';
    creatingElement = {
      type: 'line',
      data: {
        path: 'M 0 0 Q 0 20 20 20',
        style: 'dashed',
        points: ['dot', 'arrow'],
        isCurve: true,
      },
    };
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onLineCreate?.({ start: [120, 80], end: [280, 180] });

    expect(mockCommitContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({
              type: 'line',
              style: 'dashed',
              points: ['dot', 'arrow'],
              curve: [80, 50],
            }),
          ]),
        }),
      }),
      true,
    );
  });

  it('forwards renderer line-create cancellation to the app insertion state', async () => {
    process.env[flag] = 'true';
    creatingElement = {
      type: 'line',
      data: { path: 'M 0 0 L 20 20', style: 'solid', points: ['', ''] },
    };
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onLineCreateCancel?.();

    expect(mockSetCreatingElement).toHaveBeenCalledWith(null);
    expect(mockCommitContent).not.toHaveBeenCalled();
  });

  it('does not commit empty or ineffective renderer intent batches', async () => {
    process.env[flag] = 'true';
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    lastRendererProps?.onElementsChange?.([]);
    lastRendererProps?.onElementsChange?.([
      { type: 'element.update', id: 'missing', props: { left: 48 } },
    ]);

    expect(mockCommitContent).not.toHaveBeenCalled();
  });
});
