import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EditIntent,
  Selection,
  SnappingOptions,
  TextContentChange,
  TextEditorController,
  TextFormatState,
} from '@openmaic/renderer/editing';
import type { SceneDataController } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';

const mockSetActiveElementIdList = vi.fn();
const mockSetEditingElementId = vi.fn();
const mockSetRichtextAttrs = vi.fn();
const mockSetDisableHotkeysState = vi.fn();
const mockApplyOp = vi.fn();
const mockCommitContent = vi.fn();
let activeElementIds: string[] = [];
let hiddenElementIds: string[] = [];
let editingElementId = '';
let spotlightPrefix: string | undefined;
let laserPrefix: string | undefined;
let lastRendererProps:
  | {
      selection?: Selection;
      elementIdPrefix?: string;
      hiddenElementIds?: readonly string[];
      snapping?: boolean | SnappingOptions;
      onSelectionChange?: (next: Selection) => void;
      onElementsChange?: (intents: EditIntent[]) => void;
      onTextContentChange?: (change: TextContentChange) => void;
      onTextFormatChange?: (elementId: string, state: TextFormatState) => void;
      onTextEditorChange?: (controller: TextEditorController | null) => void;
      onTextFocusChange?: (focused: boolean) => void;
    }
  | undefined;

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

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      activeElementIdList: () => activeElementIds,
      hiddenElementIdList: () => hiddenElementIds,
      pickTarget: () => null,
      disableHotkeys: () => false,
      editingElementId: () => editingElementId,
      setActiveElementIdList: () => mockSetActiveElementIdList,
      setEditingElementId: () => mockSetEditingElementId,
      setRichtextAttrs: () => mockSetRichtextAttrs,
      setDisableHotkeysState: () => mockSetDisableHotkeysState,
    },
    getState: () => ({
      creatingElement: null,
      setCreatingElement: vi.fn(),
      setActiveElementIdList: mockSetActiveElementIdList,
      setEditingElementId: mockSetEditingElementId,
      setRichtextAttrs: mockSetRichtextAttrs,
      setDisableHotkeysState: mockSetDisableHotkeysState,
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

vi.mock('@openmaic/renderer/editing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/renderer/editing')>();
  return {
    ...actual,
    EditableSlideCanvas: (props: {
      selection?: Selection;
      elementIdPrefix?: string;
      hiddenElementIds?: readonly string[];
      snapping?: boolean | SnappingOptions;
      onSelectionChange?: (next: Selection) => void;
      onElementsChange?: (intents: EditIntent[]) => void;
      onTextContentChange?: (change: TextContentChange) => void;
      onTextFormatChange?: (elementId: string, state: TextFormatState) => void;
      onTextEditorChange?: (controller: TextEditorController | null) => void;
      onTextFocusChange?: (focused: boolean) => void;
    }) => {
      lastRendererProps = props;
      return createElement('button', {
        type: 'button',
        'data-testid': 'renderer-editor-canvas',
        'data-selection': props.selection?.elementIds.join(',') ?? '',
      });
    },
  };
});

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
    mockApplyOp.mockClear();
    mockCommitContent.mockClear();
    activeElementIds = [];
    hiddenElementIds = [];
    editingElementId = '';
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
    expect(html).not.toContain('data-testid="renderer-editor-canvas"');
  });

  it('uses EditableSlideCanvas and bridges selection plus intents when the flag is enabled', async () => {
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

    expect(html).toContain('data-testid="renderer-editor-canvas"');
    expect(html).toContain('data-renderer-canvas-context-menu=""');
    expect(html).toContain('data-selection="title-1"');
    expect(html).not.toContain('data-testid="legacy-editor-canvas"');
    expect(html).toContain('data-testid="spotlight-overlay"');
    expect(html).toContain('data-testid="laser-overlay"');
    expect(html).toContain('data-testid="anchored-text-bar"');
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

  it('bridges renderer text format, focus and history callbacks', async () => {
    process.env[flag] = 'true';
    activeElementIds = ['title-1'];
    editingElementId = 'title-1';
    vi.resetModules();
    const { SlideCanvas } = await import('@/components/edit/surfaces/slide/SlideCanvas');

    renderToStaticMarkup(createElement(SlideCanvas));
    const format = {
      bold: true,
      em: false,
      underline: false,
      strikethrough: false,
      superscript: false,
      subscript: false,
      code: false,
      color: '#111111',
      backcolor: '',
      fontsize: '24px',
      fontname: 'Arial',
      link: '',
      align: 'left',
      bulletList: false,
      orderedList: false,
      blockquote: false,
    } satisfies TextFormatState;
    lastRendererProps?.onTextFormatChange?.('title-1', format);
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

    expect(mockSetRichtextAttrs).toHaveBeenCalledWith(format);
    expect(mockSetDisableHotkeysState).toHaveBeenCalledWith(true);
    expect(mockCommitContent).toHaveBeenCalledWith(expect.any(Object), false);
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
